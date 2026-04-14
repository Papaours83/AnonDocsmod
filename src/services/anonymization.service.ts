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

      // Combine anonymized chunks
      const anonymizedText = anonymizedChunks.join('\n\n');

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
}

export const anonymizationService = new AnonymizationService();
