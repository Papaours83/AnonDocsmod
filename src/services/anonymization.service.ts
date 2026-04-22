import { chunkingService } from './chunking.service';
import {
  llmService,
  LLMProvider,
  AnonymizationResult,
  PiiReplacement,
  RemainingPii,
} from './llm.service';
import { config } from '../config';
import { EventEmitter } from 'events';

export interface AnonymizeTextRequest {
  text: string;
  provider?: LLMProvider;
}

export interface AnonymizeTextResponse {
  anonymizedText: string;
  piiDetected: AnonymizationResult['piiDetected'];
  replacements: PiiReplacement[];
  chunksProcessed: number;
  wordsPerMinute: number;
  processingTimeMs: number;
}

export interface ProgressEvent {
  type: 'started' | 'chunk_processing' | 'chunk_completed' | 'completed' | 'error';
  progress: number; // 0-100
  message: string;
  currentChunk?: number;
  totalChunks?: number;
  data?: any;
}

export class AnonymizationService {
  /**
   * Anonymize text by chunking if needed and processing each chunk with LLM
   */
  async anonymizeText(
    text: string,
    provider?: LLMProvider,
    progressEmitter?: EventEmitter
  ): Promise<AnonymizeTextResponse> {
    try {
      const startTime = Date.now();

      // Count words in original text
      const wordCount = text.split(/\s+/).filter((word) => word.length > 0).length;

      // Chunk text
      const textChunks = chunkingService.chunkText(text);

      // Emit started event
      if (progressEmitter) {
        progressEmitter.emit('progress', {
          type: 'started',
          progress: 0,
          message: 'Starting anonymization',
          totalChunks: textChunks.length,
        } as ProgressEvent);
      }

      // Process chunks (parallel or sequential based on config)
      const allPiiDetected: AnonymizationResult['piiDetected'] = {
        names: [],
        addresses: [],
        emails: [],
        phoneNumbers: [],
        dates: [],
        organizations: [],
      };

      let results: AnonymizationResult[];

      if (config.chunking.enableParallel) {
        // Process all chunks in parallel
        if (progressEmitter) {
          progressEmitter.emit('progress', {
            type: 'chunk_processing',
            progress: 10,
            message: 'Processing all chunks in parallel',
            totalChunks: textChunks.length,
          } as ProgressEvent);
        }
        results = await Promise.all(
          textChunks.map((chunk) => llmService.anonymizeChunk(chunk, provider))
        );
      } else {
        // Process chunks sequentially
        results = [];
        for (let i = 0; i < textChunks.length; i++) {
          const chunk = textChunks[i];

          if (progressEmitter) {
            progressEmitter.emit('progress', {
              type: 'chunk_processing',
              progress: Math.round((i / textChunks.length) * 90),
              message: `Processing chunk ${i + 1} of ${textChunks.length}`,
              currentChunk: i + 1,
              totalChunks: textChunks.length,
            } as ProgressEvent);
          }

          const result = await llmService.anonymizeChunk(chunk, provider);
          results.push(result);

          if (progressEmitter) {
            progressEmitter.emit('progress', {
              type: 'chunk_completed',
              progress: Math.round(((i + 1) / textChunks.length) * 90),
              message: `Completed chunk ${i + 1} of ${textChunks.length}`,
              currentChunk: i + 1,
              totalChunks: textChunks.length,
            } as ProgressEvent);
          }
        }
      }

      // Aggregate results with global numbered placeholders ([Name1], [Name2], ...)
      const anonymizedChunks: string[] = [];
      const allReplacements: PiiReplacement[] = [];
      const globalMap = new Map<string, string>();
      const counters: Record<string, number> = {};

      // Normalize the LLM's placeholder into one of the seven allowed
      // categories. Anything we can't confidently classify falls back to
      // Organization — acts as a catch-all for unidentified proper nouns.
      const categoryFromPlaceholder = (ph: string): string => {
        const m = ph.match(/\[([A-Za-z_ ]+?)\d*\]/);
        if (!m) return 'Organization';
        const raw = m[1].trim().toLowerCase().replace(/[_\s]/g, '');
        const mapping: Record<string, string> = {
          name: 'Name',
          names: 'Name',
          personname: 'Name',
          address: 'Address',
          addresses: 'Address',
          email: 'Email',
          emails: 'Email',
          phone: 'Phone',
          phonenumber: 'Phone',
          phonenumbers: 'Phone',
          date: 'Date',
          dates: 'Date',
          organization: 'Organization',
          organizations: 'Organization',
          org: 'Organization',
          id: 'Id',
        };
        return mapping[raw] || 'Organization';
      };

      for (const result of results) {
        let chunkText = result.anonymizedText;

        if (result.piiDetected.names) allPiiDetected.names.push(...result.piiDetected.names);
        if (result.piiDetected.addresses)
          allPiiDetected.addresses.push(...result.piiDetected.addresses);
        if (result.piiDetected.emails) allPiiDetected.emails.push(...result.piiDetected.emails);
        if (result.piiDetected.phoneNumbers)
          allPiiDetected.phoneNumbers.push(...result.piiDetected.phoneNumbers);
        if (result.piiDetected.dates) allPiiDetected.dates.push(...result.piiDetected.dates);
        if (result.piiDetected.organizations)
          allPiiDetected.organizations.push(...result.piiDetected.organizations);

        const chunkReplacements = result.replacements || [];
        for (const rep of chunkReplacements) {
          const category = categoryFromPlaceholder(rep.anonymized);
          const key = `${category}|${rep.original.trim().toLowerCase()}`;
          let newPh = globalMap.get(key);
          if (!newPh) {
            counters[category] = (counters[category] || 0) + 1;
            newPh = `[${category}${counters[category]}]`;
            globalMap.set(key, newPh);
          }
          const idx = chunkText.indexOf(rep.anonymized);
          if (idx !== -1) {
            chunkText =
              chunkText.slice(0, idx) + newPh + chunkText.slice(idx + rep.anonymized.length);
          }
          allReplacements.push({ original: rep.original, anonymized: newPh });
        }

        anonymizedChunks.push(chunkText);
      }

      // Safety net: the LLM sometimes misses structured PII, especially when
      // a piece appears in only one chunk and the surrounding context is thin.
      // Scan the original text for well-defined patterns (phone, email, URL,
      // SIRET, French street addresses) and add any match that isn't already
      // covered. These run AFTER the LLM so they don't disturb its output.
      this.augmentWithDeterministicPatterns(text, allReplacements, counters);

      // Combine anonymized chunks
      let anonymizedText = anonymizedChunks.join('\n\n');
      // Apply any newly-discovered deterministic replacements to the returned
      // anonymizedText too so callers that display it see a consistent view.
      anonymizedText = this.applyReplacements(anonymizedText, allReplacements);

      // Second LLM pass: ask the model to audit the already-anonymized text
      // and surface any PII still in clear form. Loop up to maxIterations so
      // entities the model spots in iteration N (but fails to classify for
      // the whole doc) get cleaned up in iteration N+1. Break as soon as an
      // iteration finds nothing new.
      if (config.anonymization.enableSecondPass) {
        const maxIterations = 3;
        for (let iter = 1; iter <= maxIterations; iter++) {
          if (progressEmitter) {
            progressEmitter.emit('progress', {
              type: 'chunk_processing',
              progress: 90 + iter * 2,
              message: `Running second-pass PII audit (iteration ${iter}/${maxIterations})`,
            } as ProgressEvent);
          }
          const added = await this.runSecondPassAudit(
            anonymizedText,
            allReplacements,
            allPiiDetected,
            globalMap,
            counters,
            provider
          );
          if (added === 0) {
            if (iter > 1) console.log(`[Anonymize] Second pass converged after ${iter - 1} iteration(s)`);
            break;
          }
          anonymizedText = this.applyReplacements(anonymizedText, allReplacements);
          console.log(`[Anonymize] Second pass iteration ${iter} added ${added} replacement(s)`);
        }
      }

      // Calculate metrics
      const endTime = Date.now();
      const processingTimeMs = endTime - startTime;
      const processingTimeMinutes = processingTimeMs / 60000;
      const wordsPerMinute = Math.round(wordCount / processingTimeMinutes);

      const response = {
        anonymizedText,
        piiDetected: allPiiDetected,
        replacements: allReplacements,
        chunksProcessed: textChunks.length,
        wordsPerMinute,
        processingTimeMs,
      };

      // Emit completed event
      if (progressEmitter) {
        progressEmitter.emit('progress', {
          type: 'completed',
          progress: 100,
          message: 'Anonymization completed',
          data: response,
        } as ProgressEvent);
      }

      return response;
    } catch (error) {
      console.error('Error anonymizing text:', error);

      if (progressEmitter) {
        progressEmitter.emit('progress', {
          type: 'error',
          progress: 0,
          message: error instanceof Error ? error.message : 'Unknown error',
        } as ProgressEvent);
      }

      throw error;
    }
  }

  /**
   * Append deterministic replacements for PII patterns the LLM may have
   * missed. Mutates `replacements` and `counters` in place. Only adds a match
   * if it isn't already an original in the existing replacements list and
   * isn't contained within an existing original (to avoid double-covering
   * parts of a longer address or signature block).
   */
  private augmentWithDeterministicPatterns(
    text: string,
    replacements: PiiReplacement[],
    counters: Record<string, number>
  ): void {
    const existing = replacements.map((r) => r.original);
    const isCovered = (candidate: string): boolean => {
      const c = candidate.toLowerCase();
      for (const orig of existing) {
        const o = orig.toLowerCase();
        if (o === c || o.includes(c) || c.includes(o)) return true;
      }
      return false;
    };

    // Construction/technical role abbreviations that are NOT companies or
    // people. Used to filter out false positives from the fuzzy UPPERCASE
    // patterns below ("MOE MOA", "CSPS SPS", …).
    const ROLE_STOPLIST = new Set<string>([
      // Project roles
      'MOE', 'MOA', 'AMOA', 'AMOE', 'AMO', 'MOP', 'OPC', 'OPR', 'AOR',
      'SPS', 'CSPS', 'BET', 'BTP', 'TCE', 'GO',
      // Project phases / documents
      'APS', 'APD', 'PRO', 'EXE', 'DCE', 'DOE', 'DIUO', 'PPSPS', 'PGC',
      'CCTP', 'CCAG', 'CCAP', 'BPU', 'DPGF', 'DQE', 'AVP', 'RICT',
      // Technical systems / regs
      'VRD', 'VMC', 'CVC', 'CFO', 'CFA', 'SSI', 'CTA', 'PAC', 'ERP', 'IGH',
      'ICPE', 'ABF', 'RT', 'RE', 'NF', 'CE', 'ISO', 'DTU', 'OS', 'OA',
      'ATE', 'ATEC', 'ATEX',
      // Business / admin
      'HT', 'TTC', 'TVA', 'PME', 'PMI', 'PDG', 'RH', 'DRH', 'PC', 'PV',
      // Tech/web (tend to appear in meta, not as entities)
      'URL', 'HTTP', 'HTTPS', 'PDF', 'XML', 'JSON', 'CSV', 'TXT', 'HTML',
      'CSS', 'SQL', 'API', 'SDK', 'RGPD', 'GDPR', 'IP', 'GPS',
    ]);

    // Titles / honorifics that should NOT be treated as first names
    const TITLE_STOPLIST = new Set<string>([
      'Monsieur', 'Madame', 'Mademoiselle', 'Mr', 'Mme', 'Mlle', 'Dr',
      'Maître', 'Me', 'Prof', 'Professeur',
    ]);

    const isAllStoplisted = (s: string, stoplist: Set<string>): boolean => {
      const tokens = s.split(/[\s-]+/).filter(Boolean);
      if (tokens.length === 0) return false;
      return tokens.every((t) => stoplist.has(t));
    };

    type Pattern = {
      regex: RegExp;
      category: string;
      minLen?: number;
      filter?: (match: string) => boolean;
    };

    const patterns: Pattern[] = [
      // Emails
      { regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, category: 'Email' },
      // French phone numbers: 0X XX XX XX XX (spaces/dots/dashes optional),
      // and international +33 X XX XX XX XX
      {
        regex: /(?:(?:\+33|0033)[\s.-]?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/g,
        category: 'Phone',
      },
      // SIRET (14 digits, with optional spacing every 3)
      { regex: /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[\s.]?\d{5}\b/g, category: 'Id' },
      // French street addresses, e.g. "3 route de Montfavet", "292 Avenue du Prado"
      {
        regex:
          /\b\d{1,4}(?:\s*(?:bis|ter|quater))?[,\s]+(?:rue|route|avenue|av\.?|boulevard|bd\.?|chemin|impasse|place|allée|allee|voie|passage|quai|cours)\s+(?:(?:de|du|des|de\s+la|de\s+l'|la|le|les|d')\s+)?[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][\wÀ-ÿ'\-\s]{1,60}/gi,
        category: 'Address',
      },
      // French postal code + city, e.g. "13008 MARSEILLE", "84000 AVIGNON"
      {
        regex: /\b\d{5}\s+[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ\s\-']{2,}\b/g,
        category: 'Address',
      },
      // Person name — "Firstname LASTNAME" (e.g. "Michael HANN", "Vincent NICOLAS")
      {
        regex:
          /\b([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][a-zà-ÿ]{2,}(?:-[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][a-zà-ÿ]+)?)\s+([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ]{3,}(?:-[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ]+)?)\b/g,
        category: 'Name',
        minLen: 7,
        filter: (match) => {
          const parts = match.split(/\s+/);
          if (parts.length < 2) return false;
          const [first, last] = parts;
          if (TITLE_STOPLIST.has(first)) return false;
          if (ROLE_STOPLIST.has(last)) return false;
          return true;
        },
      },
      // Person name — "LASTNAME Firstname" (common in French admin docs)
      {
        regex:
          /\b([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ]{3,}(?:-[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ]+)?)\s+([A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][a-zà-ÿ]{2,}(?:-[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][a-zà-ÿ]+)?)\b/g,
        category: 'Name',
        minLen: 7,
        filter: (match) => {
          const parts = match.split(/\s+/);
          if (parts.length < 2) return false;
          const [last, first] = parts;
          if (ROLE_STOPLIST.has(last)) return false;
          if (TITLE_STOPLIST.has(first)) return false;
          return true;
        },
      },
      // 2+ consecutive UPPERCASE words — company / multi-word acronym
      // ("VAR TOITURES", "SR PLUS", "SOCOTEC MOE", "CSPS SOCOTEC")
      {
        regex:
          /\b[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ0-9]+(?:\s+[A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ][A-ZÀÂÄÉÈÊËÎÏÔÖÙÛÜŸÇ0-9]+)+\b/g,
        category: 'Organization',
        minLen: 5,
        filter: (match) => !isAllStoplisted(match, ROLE_STOPLIST),
      },
      // Alphanumeric UPPERCASE code ("AG83", "PAP83", "R12", "ZAC2024")
      {
        regex: /\b[A-Z]{2,}\d+\b/g,
        category: 'Organization',
        minLen: 3,
        filter: (match) => !ROLE_STOPLIST.has(match.replace(/\d+$/, '')),
      },
    ];

    const addedHere: PiiReplacement[] = [];
    for (const { regex, category, minLen = 4, filter } of patterns) {
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((m = regex.exec(text)) !== null) {
        const match = m[0].trim().replace(/[.,;:!?]+$/, '');
        if (match.length < minLen) continue;
        if (filter && !filter(match)) continue;
        found.add(match);
      }
      for (const match of found) {
        if (isCovered(match)) continue;
        counters[category] = (counters[category] || 0) + 1;
        const placeholder = `[${category}${counters[category]}]`;
        const rep = { original: match, anonymized: placeholder };
        replacements.push(rep);
        addedHere.push(rep);
        existing.push(match);
      }
    }
    if (addedHere.length > 0) {
      console.log(`[Anonymize] Deterministic patterns caught ${addedHere.length}:`,
        addedHere.map((r) => `${JSON.stringify(r.original)}->${r.anonymized}`).join(', '));
    } else {
      console.log('[Anonymize] Deterministic patterns caught 0');
    }
  }

  /**
   * Second-pass audit. Chunks the already-anonymized text, asks the LLM to
   * surface any PII still in clear form, and merges the findings into the
   * shared replacements list (using the same global counters/globalMap so
   * placeholder numbering stays consistent with the first pass).
   * Returns the number of new replacements added.
   */
  private async runSecondPassAudit(
    anonymizedText: string,
    replacements: PiiReplacement[],
    piiDetected: AnonymizationResult['piiDetected'],
    globalMap: Map<string, string>,
    counters: Record<string, number>,
    provider?: LLMProvider
  ): Promise<number> {
    const existingOriginals = new Set(replacements.map((r) => r.original));
    const chunks = chunkingService.chunkText(anonymizedText);

    let audits: RemainingPii[][];
    try {
      if (config.chunking.enableParallel) {
        audits = await Promise.all(chunks.map((c) => llmService.findRemainingPii(c, provider)));
      } else {
        audits = [];
        for (const c of chunks) {
          audits.push(await llmService.findRemainingPii(c, provider));
        }
      }
    } catch (err) {
      console.warn('[Anonymize] Second pass failed, skipping:', err);
      return 0;
    }

    const categoryToBucket: Partial<Record<string, keyof AnonymizationResult['piiDetected']>> = {
      Name: 'names',
      Organization: 'organizations',
      Address: 'addresses',
      Email: 'emails',
      Phone: 'phoneNumbers',
      Date: 'dates',
    };

    let added = 0;
    for (const auditList of audits) {
      for (const item of auditList) {
        const original = item.original;
        // Must actually exist in the anonymized text (LLMs can hallucinate)
        if (!anonymizedText.includes(original)) continue;
        // Dedup by exact original — we keep case-sensitive form here since
        // acronyms like "AG83" and "ag83" should be treated as distinct.
        if (existingOriginals.has(original)) continue;

        const category = item.category;
        const key = `${category}|${original.trim().toLowerCase()}`;
        let ph = globalMap.get(key);
        if (!ph) {
          counters[category] = (counters[category] || 0) + 1;
          ph = `[${category}${counters[category]}]`;
          globalMap.set(key, ph);
        }
        replacements.push({ original, anonymized: ph });
        existingOriginals.add(original);
        added++;

        const bucket = categoryToBucket[category];
        if (bucket) piiDetected[bucket].push(original);
      }
    }

    return added;
  }

  /**
   * Apply a replacement table to a string. Longest originals first so that a
   * shorter one never clobbers part of a longer match.
   */
  private applyReplacements(text: string, replacements: PiiReplacement[]): string {
    const sorted = [...replacements].sort((a, b) => b.original.length - a.original.length);
    let out = text;
    for (const rep of sorted) {
      const escaped = rep.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), rep.anonymized);
    }
    return out;
  }
}

export const anonymizationService = new AnonymizationService();
