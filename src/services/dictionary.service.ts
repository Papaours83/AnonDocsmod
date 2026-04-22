import fs from 'fs';
import path from 'path';
import { PiiCategory, PiiReplacement } from './llm.service';

export type DictionarySource = 'detected' | 'manual';

export interface DictionaryEntry {
  original: string;
  category: PiiCategory;
  source: DictionarySource;
  addedAt: string;
  hits: number;
}

interface DictionaryFile {
  version: 1;
  entries: DictionaryEntry[];
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DICT_PATH = path.join(DATA_DIR, 'dictionary.json');

const VALID_CATEGORIES: PiiCategory[] = [
  'Name',
  'Organization',
  'Address',
  'Email',
  'Phone',
  'Date',
  'Id',
];

export class DictionaryService {
  private entries: Map<string, DictionaryEntry> = new Map();
  private loaded = false;

  private keyOf(original: string, category: PiiCategory): string {
    return `${category}|${original.trim().toLowerCase()}`;
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(DICT_PATH)) {
        this.entries = new Map();
        this.loaded = true;
        return;
      }
      const raw = fs.readFileSync(DICT_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as DictionaryFile;
      this.entries = new Map();
      for (const e of parsed.entries || []) {
        if (!VALID_CATEGORIES.includes(e.category)) continue;
        if (typeof e.original !== 'string' || e.original.trim().length === 0) continue;
        this.entries.set(this.keyOf(e.original, e.category), {
          original: e.original,
          category: e.category,
          source: e.source === 'manual' ? 'manual' : 'detected',
          addedAt: e.addedAt || new Date().toISOString(),
          hits: typeof e.hits === 'number' ? e.hits : 0,
        });
      }
      this.loaded = true;
    } catch (err) {
      console.warn('[Dictionary] Failed to load, starting fresh:', err);
      this.entries = new Map();
      this.loaded = true;
    }
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const file: DictionaryFile = {
        version: 1,
        entries: Array.from(this.entries.values()),
      };
      fs.writeFileSync(DICT_PATH, JSON.stringify(file, null, 2), 'utf-8');
    } catch (err) {
      console.error('[Dictionary] Failed to save:', err);
    }
  }

  list(filter?: { category?: PiiCategory; source?: DictionarySource }): DictionaryEntry[] {
    this.ensureLoaded();
    let out = Array.from(this.entries.values());
    if (filter?.category) out = out.filter((e) => e.category === filter.category);
    if (filter?.source) out = out.filter((e) => e.source === filter.source);
    return out.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
  }

  addEntry(
    original: string,
    category: PiiCategory,
    source: DictionarySource
  ): { entry: DictionaryEntry; created: boolean } {
    this.ensureLoaded();
    const trimmed = original.trim();
    if (trimmed.length === 0) {
      throw new Error('original must be a non-empty string');
    }
    if (!VALID_CATEGORIES.includes(category)) {
      throw new Error(
        `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`
      );
    }
    const key = this.keyOf(trimmed, category);
    const existing = this.entries.get(key);
    if (existing) {
      if (source === 'manual' && existing.source !== 'manual') {
        existing.source = 'manual';
        this.save();
      }
      return { entry: existing, created: false };
    }
    const entry: DictionaryEntry = {
      original: trimmed,
      category,
      source,
      addedAt: new Date().toISOString(),
      hits: 0,
    };
    this.entries.set(key, entry);
    this.save();
    return { entry, created: true };
  }

  addBatch(
    items: Array<{ original: string; category: PiiCategory }>,
    source: DictionarySource
  ): { added: number; updated: number } {
    this.ensureLoaded();
    let added = 0;
    let updated = 0;
    for (const item of items) {
      try {
        const { created } = this.addEntry(item.original, item.category, source);
        if (created) added++;
        else updated++;
      } catch {
        // skip invalid items in batch
      }
    }
    return { added, updated };
  }

  removeEntry(original: string, category: PiiCategory): boolean {
    this.ensureLoaded();
    const key = this.keyOf(original, category);
    const existed = this.entries.delete(key);
    if (existed) this.save();
    return existed;
  }

  recordFromReplacements(replacements: PiiReplacement[]): void {
    this.ensureLoaded();
    let changed = false;
    for (const rep of replacements) {
      const category = this.categoryFromPlaceholder(rep.anonymized);
      if (!category) continue;
      const key = this.keyOf(rep.original, category);
      const existing = this.entries.get(key);
      if (existing) {
        existing.hits += 1;
        changed = true;
      } else {
        this.entries.set(key, {
          original: rep.original.trim(),
          category,
          source: 'detected',
          addedAt: new Date().toISOString(),
          hits: 1,
        });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private categoryFromPlaceholder(placeholder: string): PiiCategory | null {
    const m = placeholder.match(/\[([A-Za-z]+)\d*\]/);
    if (!m) return null;
    const raw = m[1];
    if (VALID_CATEGORIES.includes(raw as PiiCategory)) return raw as PiiCategory;
    return null;
  }
}

export const dictionaryService = new DictionaryService();
