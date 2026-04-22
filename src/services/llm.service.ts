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
    addresses: string[];
    emails: string[];
    phoneNumbers: string[];
    dates: string[];
    organizations: string[];
  };
  replacements: PiiReplacement[];
}

export type PiiCategory =
  | 'Name'
  | 'Organization'
  | 'Address'
  | 'Email'
  | 'Phone'
  | 'Date'
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

  async anonymizeChunk(text: string, provider?: LLMProvider): Promise<AnonymizationResult> {
    const selectedProvider = provider || config.llm.defaultProvider;
    const model = this.models.get(selectedProvider);

    if (!model) {
      throw new Error(
        `LLM provider "${selectedProvider}" is not configured. ` +
          `Please check your environment variables (${selectedProvider.toUpperCase()}_BASE_URL, ${selectedProvider.toUpperCase()}_MODEL).`
      );
    }

    const systemPrompt = `/no_think
You are an expert document anonymization assistant. Your task is to:
1. Identify and remove all Personally Identifiable Information (PII) from the text
2. Replace PII with generic placeholders like [NAME], [ADDRESS], [EMAIL], [PHONE], [DATE], [ORGANIZATION]
3. Maintain the document's structure and readability
4. Return both the anonymized text, a JSON list of detected PII, AND a precise mapping of what was replaced

Keep the original language of the text.

PII includes (be AGGRESSIVE — when in doubt, anonymize):
- Personal names (first names, last names, full names, initials followed by a surname)
- Physical addresses
- Email addresses
- Phone numbers
- Dates of birth or identifying dates
- ALL organization names — companies, subcontractors, suppliers, clients, associations, administrations. Do NOT restrict to organizations that "identify individuals": any proper-noun organization must be replaced.
- Brand names, product names, trade names (e.g. "Celio", "Macrolot")
- Short codes, acronyms, and internal project/lot references that look like identifiers
  (e.g. "AG83", "PAP", "SR PLUS", "VAR TOITURES"). Any UPPERCASE
  token of 2+ letters that is not a common word should be treated as an organization/code.
  Multi-word company names where one word is a common noun (e.g. "VAR TOITURES",
  "SR PLUS") still count — replace the full expression.
- ID numbers (social security, passport, driver's license, SIRET, etc.)
- Financial information (credit card, bank account numbers)

When scanning, pay special attention to tables, bullet lists, and signature blocks —
PII is often dense there and easy to miss.

IMPORTANT: In the "replacements" array, list EVERY single replacement you made with the EXACT original text and what you replaced it with. Include every distinct occurrence of the same entity if the surface form differs (e.g. "VAR TOITURES" and "Var Toitures" are two entries).

Respond with a JSON object in this exact format:
{
  "anonymizedText": "the anonymized text here",
  "piiDetected": {
    "names": ["list of detected names"],
    "addresses": ["list of detected addresses"],
    "emails": ["list of detected emails"],
    "phoneNumbers": ["list of detected phone numbers"],
    "dates": ["list of detected dates"],
    "organizations": ["list of detected organizations"]
  },
  "replacements": [
    {"original": "exact original text", "anonymized": "[Name]"},
    {"original": "another original", "anonymized": "[Organization]"}
  ]
}

Use ONLY these placeholder categories: [Name], [Organization], [Address], [Email], [Phone], [Date], [Id]. Do NOT invent categories like [Other], [Project], [Code], etc. — classify every finding into one of those seven.`;

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(`Anonymize the following text:\n\n${text}`),
    ];

    try {
      const response = await model.invoke(messages);
      let content = response.content.toString();

      // Strip Qwen/DeepSeek-style <think>...</think> reasoning blocks (and unterminated ones)
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
      content = content.replace(/<think>[\s\S]*$/i, '');

      try {
        // Extract JSON from response (handle cases where LLM adds markdown formatting)
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in response');
        }

        const result = JSON.parse(jsonMatch[0]) as AnonymizationResult;
        return result;
      } catch (error) {
        console.error('Failed to parse LLM response:', content);
        throw new Error('Failed to parse anonymization response from LLM');
      }
    } catch (error: any) {
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
   * placeholders like [Name1], [Organization2]), ask the LLM to list PII that
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
tokens in square brackets like [Name1], [Organization2], [Address3], [Phone4],
[Email5], [Date6], [Id7] are EXISTING placeholders — you MUST ignore
them and never include them in your output.

Your task: scan the text and list EVERY remaining piece of PII that is still in
clear form (i.e. was missed by the first anonymization pass). Be AGGRESSIVE.

Look especially for:
- Personal names (first names, last names, full names, "Prénom NOM" patterns)
- Organization names, companies, subcontractors, suppliers, clients, brand names,
  product names, trade names
- Short codes / acronyms / internal project or lot references that look like
  identifiers (e.g. "AG83", "PAP", "SR PLUS", "VAR TOITURES", "Macrolot",
  "Lot 6"). Any UPPERCASE token of 2+ letters that is not a common word is
  likely PII.
- Addresses, phone numbers, emails, identifying dates, ID numbers

Rules:
- Do NOT include any [Placeholder] token — they are already anonymized.
- Each "original" must be the EXACT substring that appears in the input text.
- One entry per distinct surface form (case-sensitive, including spacing).
- If you find nothing, return an empty array.

Respond with ONLY a JSON object, no prose, no markdown fences:
{
  "remainingPii": [
    {"original": "exact string from the text", "category": "Name"},
    {"original": "...", "category": "Organization"}
  ]
}

Allowed categories (use EXACTLY one of these — no others): Name, Organization, Address, Email, Phone, Date, Id.
For anything that doesn't clearly fit Name/Address/Email/Phone/Date/Id, use Organization.`;

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
        'Organization',
        'Address',
        'Email',
        'Phone',
        'Date',
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
