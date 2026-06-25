import { chunkingService } from './chunking.service';
import {
  llmService,
  LLMProvider,
  AnonymizationResult,
  PiiReplacement,
  PiiCategory,
  RemainingPii,
} from './llm.service';
import { dictionaryService } from './dictionary.service';
import { placeholderMapService } from './placeholder-map.service';
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

      // Pre-anonymize manual dictionary entries BEFORE the LLM sees them.
      // Each match is replaced with a unique marker that the LLM passes
      // through unchanged; markers are swapped for proper [Category{N}]
      // placeholders after aggregation. This guarantees user-added words
      // are always anonymized, regardless of what the LLM detects.
      const manualEntries = dictionaryService.list({ source: 'manual' });
      type ManualHit = { original: string; category: string; marker: string };
      const manualHits = new Map<string, ManualHit>();
      const sortedManual = [...manualEntries].sort(
        (a, b) => b.original.length - a.original.length
      );
      const escapeForRegex = (s: string) =>
        s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const markerOf = (n: number) =>
        `__PIIM_${String(n).padStart(4, '0')}__`;

      const llmChunks = textChunks.map((chunk) => {
        let out = chunk;
        for (const entry of sortedManual) {
          const regex = new RegExp(
            `(?<![\\p{L}\\p{N}])${escapeForRegex(entry.original)}(?![\\p{L}\\p{N}])`,
            'giu'
          );
          if (!regex.test(out)) continue;
          const key = `${entry.category}|${entry.original.trim().toLowerCase()}`;
          let hit = manualHits.get(key);
          if (!hit) {
            hit = {
              original: entry.original,
              category: entry.category,
              marker: markerOf(manualHits.size + 1),
            };
            manualHits.set(key, hit);
          }
          out = out.replace(regex, hit.marker);
        }
        return out;
      });

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
        emails: [],
        phoneNumbers: [],
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
          llmChunks.map((chunk) => llmService.anonymizeChunk(chunk, provider))
        );
      } else {
        // Process chunks sequentially
        results = [];
        for (let i = 0; i < llmChunks.length; i++) {
          const chunk = llmChunks[i];

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

      // Aggregate results. Placeholder allocation goes through the persistent
      // map service so the same (category, original) always resolves to the
      // same [Category{N}] across requests — e.g. "Benoit Dutrou" → [Name1]
      // in every document, even when the global counter has reached [Name350].
      const anonymizedChunks: string[] = [];
      const allReplacements: PiiReplacement[] = [];

      // Normalize the LLM's placeholder into one of the six allowed
      // categories. Returns null for anything unmappable (including
      // Organization, which we explicitly do NOT anonymize) so the caller
      // can restore the original text.
      const categoryFromPlaceholder = (ph: string): string | null => {
        const m = ph.match(/\[([A-Za-z_ ]+?)\d*\]/);
        if (!m) return null;
        const raw = m[1].trim().toLowerCase().replace(/[_\s]/g, '');
        const mapping: Record<string, string> = {
          name: 'Name',
          names: 'Name',
          personname: 'Name',
          email: 'Email',
          emails: 'Email',
          phone: 'Phone',
          phonenumber: 'Phone',
          phonenumbers: 'Phone',
          id: 'Id',
        };
        return mapping[raw] || null;
      };

      for (const result of results) {
        let chunkText = result.anonymizedText;

        if (result.piiDetected.names) allPiiDetected.names.push(...result.piiDetected.names);
        if (result.piiDetected.emails) allPiiDetected.emails.push(...result.piiDetected.emails);
        if (result.piiDetected.phoneNumbers)
          allPiiDetected.phoneNumbers.push(...result.piiDetected.phoneNumbers);

        const chunkReplacements = result.replacements || [];
        for (const rep of chunkReplacements) {
          const category = categoryFromPlaceholder(rep.anonymized);
          if (!category) {
            // LLM anonymized something we don't want anonymized (e.g. an
            // organization). Put the original text back in the chunk.
            const idx = chunkText.indexOf(rep.anonymized);
            if (idx !== -1) {
              chunkText =
                chunkText.slice(0, idx) + rep.original + chunkText.slice(idx + rep.anonymized.length);
            }
            continue;
          }
          const newPh = placeholderMapService.resolve(category as PiiCategory, rep.original);
          const idx = chunkText.indexOf(rep.anonymized);
          if (idx !== -1) {
            chunkText =
              chunkText.slice(0, idx) + newPh + chunkText.slice(idx + rep.anonymized.length);
          }
          allReplacements.push({ original: rep.original, anonymized: newPh });
        }

        anonymizedChunks.push(chunkText);
      }

      // Swap manual-entry markers (inserted before the LLM) for proper
      // [Category{N}] placeholders via the persistent map service — same
      // (category, original) always resolves to the same number.
      if (manualHits.size > 0) {
        for (let i = 0; i < anonymizedChunks.length; i++) {
          let chunkText = anonymizedChunks[i];
          for (const hit of manualHits.values()) {
            if (!chunkText.includes(hit.marker)) continue;
            const ph = placeholderMapService.resolve(hit.category as PiiCategory, hit.original);
            chunkText = chunkText.split(hit.marker).join(ph);
            if (!allReplacements.some(
              (r) => r.original === hit.original && r.anonymized === ph
            )) {
              allReplacements.push({ original: hit.original, anonymized: ph });
            }
          }
          anonymizedChunks[i] = chunkText;
        }
      }

      // Apply the persistent dictionary BEFORE pattern matching so that any
      // word we've previously seen or that a user manually flagged is always
      // caught, even if the LLM missed it and no pattern matches it.
      this.augmentWithDictionary(text, allReplacements);

      // Safety net: the LLM sometimes misses structured PII, especially when
      // a piece appears in only one chunk and the surrounding context is thin.
      // Scan the original text for well-defined patterns (phone, email, URL,
      // SIRET) and add any match that isn't already covered. These run AFTER
      // the LLM so they don't disturb its output.
      this.augmentWithDeterministicPatterns(text, allReplacements);

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

      // Note: detected entries are intentionally NOT auto-recorded to the
      // dictionary. Only user-added (manual) entries should persist there.

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
   * Apply the persistent dictionary of learned/manual PII words. For each
   * entry we search the original text case-insensitively on word boundaries
   * and, if found and not already covered, push a replacement that reuses
   * an existing placeholder (via the persistent placeholder map) or
   * allocates a new one through the same service.
   */
  private augmentWithDictionary(
    text: string,
    replacements: PiiReplacement[]
  ): void {
    const entries = dictionaryService.list();
    if (entries.length === 0) return;

    const existingOriginals = new Set(replacements.map((r) => r.original.toLowerCase()));
    const isCovered = (candidate: string): boolean => {
      const c = candidate.toLowerCase();
      if (existingOriginals.has(c)) return true;
      for (const orig of existingOriginals) {
        if (orig.includes(c) || c.includes(orig)) return true;
      }
      return false;
    };

    // Longest entries first so "Jean-Pierre MARTIN" is matched before "MARTIN"
    const sorted = [...entries].sort((a, b) => b.original.length - a.original.length);

    let added = 0;
    for (const entry of sorted) {
      if (isCovered(entry.original)) continue;
      const escaped = entry.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
      if (!regex.test(text)) continue;

      const ph = placeholderMapService.resolve(entry.category, entry.original);
      replacements.push({ original: entry.original, anonymized: ph });
      existingOriginals.add(entry.original.toLowerCase());
      added++;
    }
    if (added > 0) {
      console.log(`[Anonymize] Dictionary caught ${added} entry/entries`);
    }
  }

  /**
   * Append deterministic replacements for PII patterns the LLM may have
   * missed. Mutates `replacements` in place. Only adds a match
   * if it isn't already an original in the existing replacements list and
   * isn't contained within an existing original (to avoid double-covering
   * parts of a longer address or signature block).
   */
  private augmentWithDeterministicPatterns(
    text: string,
    replacements: PiiReplacement[]
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

    type Pattern = {
      regex: RegExp;
      category: PiiCategory;
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
      // Address-style patterns (street, postal code + city) are intentionally
      // NOT included — addresses are out of scope for anonymization.
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
      // Organization-style patterns (multi-word UPPERCASE, alphanumeric
      // codes) are intentionally NOT included — organizations are out of
      // scope for anonymization.
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
        const placeholder = placeholderMapService.resolve(category, match);
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
   * shared replacements list (using the persistent placeholder map so
   * numbering stays consistent with the first pass AND across documents).
   * Returns the number of new replacements added.
   */
  private async runSecondPassAudit(
    anonymizedText: string,
    replacements: PiiReplacement[],
    piiDetected: AnonymizationResult['piiDetected'],
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
      Email: 'emails',
      Phone: 'phoneNumbers',
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
        const ph = placeholderMapService.resolve(category, original);
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
      // Word boundaries (Unicode letters/digits) so e.g. "CA" doesn't match
      // inside "CASSER". Case-insensitive so "Gestion" / "gestion" / "GESTION"
      // all anonymize from a single dictionary entry.
      out = out.replace(
        new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu'),
        rep.anonymized
      );
    }
    return out;
  }
}

export const anonymizationService = new AnonymizationService();
