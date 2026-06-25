import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatOllama } from '@langchain/community/chat_models/ollama';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { config } from '../config';

export type LLMProvider = 'openai' | 'anthropic' | 'ollama';

export interface PiiReplacement {
  original: string;
  anonymized: string;
}

export interface AnonymizationResult {
  anonymizedText: string;
  piiDetected: {
    names: string[];
    emails: string[];
    phoneNumbers: string[];
  };
  replacements: PiiReplacement[];
}

export type PiiCategory =
  | 'Name'
  | 'Email'
  | 'Phone'
  | 'Id';

export interface RemainingPii {
  original: string;
  category: PiiCategory;
}

export class LLMService {
  private models: Map<LLMProvider, BaseChatModel> = new Map();

  constructor() {
    this.initializeModels();
  }

  private initializeModels() {
    // Initialize OpenAI (or OpenAI-compatible APIs like LocalAI, LM Studio)
    if (config.llm.openai) {
      const openaiConfig: any = {
        modelName: config.llm.openai.model,
        temperature: config.llm.openai.temperature,
      };

      // Add API key if provided (not needed for some local setups)
      if (config.llm.openai.apiKey) {
        openaiConfig.openAIApiKey = config.llm.openai.apiKey;
      }

      // Add custom base URL if provided (for OpenAI-compatible APIs)
      if (config.llm.openai.baseURL) {
        openaiConfig.configuration = {
          baseURL: config.llm.openai.baseURL,
        };
      }

      this.models.set('openai', new ChatOpenAI(openaiConfig));
      console.log(
        `✓ OpenAI initialized: ${config.llm.openai.model}${
          config.llm.openai.baseURL ? ` (${config.llm.openai.baseURL})` : ''
        }`
      );
    }

    // Initialize Anthropic
    if (config.llm.anthropic) {
      this.models.set(
        'anthropic',
        new ChatAnthropic({
          anthropicApiKey: config.llm.anthropic.apiKey,
          modelName: config.llm.anthropic.model,
          temperature: config.llm.anthropic.temperature,
        })
      );
      console.log(`✓ Anthropic initialized: ${config.llm.anthropic.model}`);
    }

    // Initialize Ollama (local LLM runtime)
    if (config.llm.ollama) {
      this.models.set(
        'ollama',
        new ChatOllama({
          baseUrl: config.llm.ollama.baseUrl,
          model: config.llm.ollama.model,
          temperature: config.llm.ollama.temperature,
        })
      );
      console.log(
        `✓ Ollama initialized: ${config.llm.ollama.model} (${config.llm.ollama.baseUrl})`
      );
    }

    // Log available providers
    const providers = Array.from(this.models.keys());
    if (providers.length === 0) {
      console.warn('⚠️  No LLM providers configured! Please set up at least one provider in .env');
    } else {
      console.log(`📋 Available providers: ${providers.join(', ')}`);
      console.log(`🎯 Default provider: ${config.llm.defaultProvider}`);
    }
  }

  private chunkCounter = 0;

  async anonymizeChunk(text: string, provider?: LLMProvider): Promise<AnonymizationResult> {
    const selectedProvider = provider || config.llm.defaultProvider;
    const model = this.models.get(selectedProvider);

    if (!model) {
      throw new Error(
        `LLM provider "${selectedProvider}" is not configured. ` +
          `Please check your environment variables (${selectedProvider.toUpperCase()}_BASE_URL, ${selectedProvider.toUpperCase()}_MODEL).`
      );
    }

    const chunkId = ++this.chunkCounter;
    const startedAt = Date.now();
    console.log(`[LLM] chunk #${chunkId} → ${selectedProvider} (${text.length} chars) — sending`);

    const systemPrompt = `/no_think
You are an expert document anonymization assistant. Your task is to:
1. Identify and remove all Personally Identifiable Information (PII) from the text
2. Replace PII with generic placeholders like [NAME], [EMAIL], [PHONE], [ID]
3. Maintain the document's structure and readability
4. Return both the anonymized text, a JSON list of detected PII, AND a precise mapping of what was replaced

Keep the original language of the text.

PII includes (be AGGRESSIVE — when in doubt, anonymize):
- Personal names (first names, last names, full names, initials followed by a surname)
- Email addresses
- Phone numbers
- ID numbers (social security, passport, driver's license, SIRET, etc.)
- Financial information (credit card, bank account numbers)

DO NOT anonymize:
- Organization names, companies, subcontractors, suppliers, clients, brand names, project codes, lot references, UPPERCASE acronyms — out of scope.
- Physical addresses, street names, postal codes, cities — out of scope.
- Dates of any kind (birth dates, deadlines, signature dates, etc.) — out of scope.
Leave them in the text exactly as written.

When scanning, pay special attention to tables, bullet lists, and signature blocks —
PII is often dense there and easy to miss.

IMPORTANT: In the "replacements" array, list EVERY single replacement you made with the EXACT original text and what you replaced it with. Include every distinct occurrence of the same entity if the surface form differs.

Respond with a JSON object in this exact format:
{
  "anonymizedText": "the anonymized text here",
  "piiDetected": {
    "names": ["list of detected names"],
    "emails": ["list of detected emails"],
    "phoneNumbers": ["list of detected phone numbers"]
  },
  "replacements": [
    {"original": "exact original text", "anonymized": "[Name]"},
    {"original": "another original", "anonymized": "[Phone]"}
  ]
}

Use ONLY these placeholder categories: [Name], [Email], [Phone], [Id]. Do NOT use [Address], [Date], [Organization], [Other], etc. — classify every finding into one of those four, or omit it.`;

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Anonymize the following text:\n\n${text}`),
    ];

    try {
      const response = await model.invoke(messages);
      const elapsed = Date.now() - startedAt;
      let content = response.content.toString();
      console.log(
        `[LLM] chunk #${chunkId} ← response in ${elapsed}ms (${content.length} chars)`
      );

      // Strip Qwen/DeepSeek-style <think>...</think> reasoning blocks (and unterminated ones)
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
      content = content.replace(/<think>[\s\S]*$/i, '');

      const parsed = this.parseAnonymizationResponse(content);
      if (!parsed) {
        console.error(`[LLM] chunk #${chunkId} parse FAILED, raw:`, content);
        throw new Error('Failed to parse anonymization response from LLM');
      }
      return parsed;
    } catch (error: any) {
      console.warn(
        `[LLM] chunk #${chunkId} threw after ${Date.now() - startedAt}ms:`,
        error?.message || error
      );
      // Handle connection errors with helpful messages
      if (error.cause) {
        const cause = error.cause;

        if (cause.code === 'ECONNREFUSED' || cause.code === 'ENOTFOUND') {
          const providerInfo = this.getProviderConnectionInfo(selectedProvider);
          throw new Error(
            `Cannot connect to ${selectedProvider.toUpperCase()} at ${providerInfo.url}. ` +
              `${providerInfo.suggestion}`
          );
        }

        if (cause.code === 'ETIMEDOUT') {
          throw new Error(
            `Connection timeout to ${selectedProvider.toUpperCase()}. The LLM server is not responding.`
          );
        }
      }

      // Re-throw original error if not a connection issue
      throw error;
    }
  }

  /**
   * Parse the anonymization response from the LLM. qwen3/vLLM (and other
   * smaller models) sometimes produce malformed JSON — most often by closing
   * the wrapper object early and putting "replacements" as a sibling rather
   * than a child. We try two strategies:
   *   1. Strict parse on the first balanced `{...}` block (fast path for
   *      well-formed responses).
   *   2. Per-field extraction with a brace-balanced walker, so the wrapper
   *      structure can be malformed and we still recover anonymizedText,
   *      piiDetected, and replacements.
   */
  private parseAnonymizationResponse(raw: string): AnonymizationResult | null {
    const cleaned = this.stripMarkdownFences(raw);

    // Strategy 1: balanced top-level JSON object
    let strict: Partial<AnonymizationResult> | null = null;
    const balanced = this.findFirstBalancedBlock(cleaned, '{', '}');
    if (balanced) {
      try {
        strict = JSON.parse(balanced) as Partial<AnonymizationResult>;
      } catch {
        /* fall through to per-field extraction */
      }
    }

    // Per-field extraction — also used to top-up missing fields when the LLM
    // closed the wrapper early and put one of them outside (qwen3 does this).
    const anonymizedText =
      (strict?.anonymizedText as string | undefined) ??
      this.extractStringField(cleaned, 'anonymizedText') ??
      null;
    if (anonymizedText === null) return null;

    let piiDetected = strict?.piiDetected as AnonymizationResult['piiDetected'] | undefined;
    if (!piiDetected) {
      const piiRaw = this.extractBalancedField(cleaned, 'piiDetected', '{', '}');
      piiDetected = piiRaw
        ? this.tryParse<AnonymizationResult['piiDetected']>(piiRaw) ?? this.emptyPiiDetected()
        : this.emptyPiiDetected();
    }

    let replacements = strict?.replacements as PiiReplacement[] | undefined;
    if (!Array.isArray(replacements)) {
      const repRaw = this.extractBalancedField(cleaned, 'replacements', '[', ']');
      replacements = repRaw ? this.tryParse<PiiReplacement[]>(repRaw) ?? [] : [];
    }

    return {
      anonymizedText,
      piiDetected: this.normalizePiiDetected(piiDetected),
      replacements: Array.isArray(replacements) ? replacements : [],
    };
  }

  private stripMarkdownFences(content: string): string {
    return content.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  }

  private findFirstBalancedBlock(content: string, open: string, close: string): string | null {
    let depth = 0;
    let start = -1;
    let inString = false;
    let escape = false;
    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      if (escape) { escape = false; continue; }
      if (inString && c === '\\') { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === open) {
        if (depth === 0) start = i;
        depth++;
      } else if (c === close) {
        depth--;
        if (depth === 0 && start !== -1) return content.slice(start, i + 1);
      }
    }
    return null;
  }

  private extractBalancedField(
    content: string,
    key: string,
    open: string,
    close: string
  ): string | null {
    const keyIdx = content.indexOf(`"${key}"`);
    if (keyIdx === -1) return null;
    const colon = content.indexOf(':', keyIdx);
    if (colon === -1) return null;
    const openIdx = content.indexOf(open, colon);
    if (openIdx === -1) return null;
    const slice = content.slice(openIdx);
    return this.findFirstBalancedBlock(slice, open, close);
  }

  private extractStringField(content: string, key: string): string | null {
    const keyIdx = content.indexOf(`"${key}"`);
    if (keyIdx === -1) return null;
    const colon = content.indexOf(':', keyIdx);
    if (colon === -1) return null;
    // Find the opening quote of the value
    let i = colon + 1;
    while (i < content.length && /\s/.test(content[i])) i++;
    if (content[i] !== '"') return null;
    const start = i;
    i++;
    let escape = false;
    for (; i < content.length; i++) {
      const c = content[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') {
        // Use JSON.parse to handle escapes (\n, \", \\, \uXXXX, etc.)
        try {
          return JSON.parse(content.slice(start, i + 1)) as string;
        } catch {
          return content.slice(start + 1, i);
        }
      }
    }
    return null;
  }

  private tryParse<T>(s: string): T | null {
    try {
      return JSON.parse(s) as T;
    } catch {
      return null;
    }
  }

  private emptyPiiDetected(): AnonymizationResult['piiDetected'] {
    return {
      names: [],
      emails: [],
      phoneNumbers: [],
    };
  }

  private normalizePiiDetected(p: any): AnonymizationResult['piiDetected'] {
    const empty = this.emptyPiiDetected();
    if (!p || typeof p !== 'object') return empty;
    const arr = (v: any): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    return {
      names: arr(p.names),
      emails: arr(p.emails),
      phoneNumbers: arr(p.phoneNumbers),
    };
  }

  private getProviderConnectionInfo(provider: LLMProvider): { url: string; suggestion: string } {
    switch (provider) {
      case 'ollama':
        const ollamaUrl = config.llm.ollama?.baseUrl || 'not configured';
        return {
          url: ollamaUrl,
          suggestion: 'Make sure Ollama is running (ollama serve) and accessible at this URL.',
        };
      case 'openai':
        const openaiUrl = config.llm.openai?.baseURL || 'https://api.openai.com/v1';
        return {
          url: openaiUrl,
          suggestion: 'Check your network connection and API key configuration.',
        };
      case 'anthropic':
        return {
          url: 'https://api.anthropic.com',
          suggestion: 'Check your network connection and API key configuration.',
        };
      default:
        return {
          url: 'unknown',
          suggestion: 'Check your provider configuration.',
        };
    }
  }

  getAvailableProviders(): LLMProvider[] {
    return Array.from(this.models.keys());
  }

  /**
   * Second pass: given text that has already been partially anonymized (with
   * placeholders like [Name1], [Address2]), ask the LLM to list PII that
   * is still present in clear form. Existing placeholders must be ignored.
   * Returns an array of {original, category} — callers assign placeholders.
   */
  async findRemainingPii(
    anonymizedText: string,
    provider?: LLMProvider
  ): Promise<RemainingPii[]> {
    const selectedProvider = provider || config.llm.defaultProvider;
    const model = this.models.get(selectedProvider);
    if (!model) {
      throw new Error(
        `LLM provider "${selectedProvider}" is not configured for second pass.`
      );
    }

    const systemPrompt = `/no_think
You are a PII auditor. The text you will see has ALREADY been partially anonymized:
tokens in square brackets like [Name1], [Phone4], [Email5], [Id7] are EXISTING
placeholders — you MUST ignore them and never include them in your output.

Your task: scan the text and list EVERY remaining piece of PII that is still in
clear form (i.e. was missed by the first anonymization pass). Be AGGRESSIVE.

Look especially for:
- Personal names (first names, last names, full names, "Prénom NOM" patterns)
- Phone numbers, emails, ID numbers

DO NOT report:
- Organization names, companies, subcontractors, suppliers, clients, brand names, project codes, lot references, UPPERCASE acronyms — out of scope.
- Addresses, street names, postal codes, cities — out of scope.
- Dates of any kind — out of scope.

Rules:
- Do NOT include any [Placeholder] token — they are already anonymized.
- Each "original" must be the EXACT substring that appears in the input text.
- One entry per distinct surface form (case-sensitive, including spacing).
- If you find nothing, return an empty array.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "remainingPii": [
    {"original": "exact string from the text", "category": "Name"},
    {"original": "...", "category": "Phone"}
  ]
}

Allowed categories (use EXACTLY one of these — no others): Name, Email, Phone, Id.
Anything that doesn't clearly fit one of those four must be omitted, not classified as a fallback.`;

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Audit the following partially-anonymized text:\n\n${anonymizedText}`),
    ];

    try {
      const response = await model.invoke(messages);
      let content = response.content.toString();
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
      content = content.replace(/<think>[\s\S]*$/i, '');

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as { remainingPii?: RemainingPii[] };
      if (!parsed.remainingPii || !Array.isArray(parsed.remainingPii)) return [];

      const allowed: ReadonlySet<PiiCategory> = new Set<PiiCategory>([
        'Name',
        'Email',
        'Phone',
        'Id',
      ]);

      return parsed.remainingPii
        .filter(
          (p): p is RemainingPii =>
            !!p &&
            typeof p.original === 'string' &&
            p.original.trim().length > 0 &&
            // Reject anything that looks like an existing placeholder
            !/^\[[A-Za-z_ ]+\d*\]$/.test(p.original.trim()) &&
            typeof p.category === 'string' &&
            allowed.has(p.category as PiiCategory)
        )
        .map((p) => ({ original: p.original, category: p.category }));
    } catch (err) {
      console.warn('[LLM] Second-pass PII audit failed:', err);
      return [];
    }
  }
}

export const llmService = new LLMService();
