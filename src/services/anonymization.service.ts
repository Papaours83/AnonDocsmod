import { chunkingService } from './chunking.service';
import { llmService, LLMProvider, AnonymizationResult, PiiReplacement } from './llm.service';
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
        other: [],
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

      const categoryFromPlaceholder = (ph: string): string => {
        const m = ph.match(/\[([A-Za-z_ ]+?)\d*\]/);
        if (!m) return 'Other';
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
          other: 'Other',
        };
        return (
          mapping[raw] ||
          m[1].trim().charAt(0).toUpperCase() + m[1].trim().slice(1).toLowerCase()
        );
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
        if (result.piiDetected.other) allPiiDetected.other.push(...result.piiDetected.other);

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

    const patterns: Array<{ regex: RegExp; category: string }> = [
      // Emails
      { regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, category: 'Email' },
      // URLs (http/https/www)
      { regex: /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi, category: 'Other' },
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
    ];

    for (const { regex, category } of patterns) {
      const found = new Set<string>();
      let m: RegExpExecArray | null;
      regex.lastIndex = 0;
      while ((m = regex.exec(text)) !== null) {
        const match = m[0].trim().replace(/[.,;:!?]+$/, '');
        if (match.length < 4) continue;
        found.add(match);
      }
      for (const match of found) {
        if (isCovered(match)) continue;
        counters[category] = (counters[category] || 0) + 1;
        const placeholder = `[${category}${counters[category]}]`;
        replacements.push({ original: match, anonymized: placeholder });
        existing.push(match);
      }
    }
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
