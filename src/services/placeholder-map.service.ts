import fs from 'fs';
import path from 'path';
import { PiiCategory } from './llm.service';

interface CategoryState {
  counter: number;
  entries: Record<string, number>;
}

interface MapFile {
  version: 1;
  state: Partial<Record<PiiCategory, CategoryState>>;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const MAP_PATH = path.join(DATA_DIR, 'placeholder-map.json');

/**
 * Persistent, cross-document mapping from (category, original) to a stable
 * placeholder index. Ensures "Benoit Dutrou" gets [Name1] in every document
 * it appears in, even when the global counter has advanced (e.g. [Name350]
 * exists from other documents).
 *
 * Keys are case-insensitive and trimmed so "Benoit Dutrou" and
 * "BENOIT DUTROU" share the same placeholder.
 */
export class PlaceholderMapService {
  private state: Partial<Record<PiiCategory, CategoryState>> = {};
  private loaded = false;
  private writeTimer: NodeJS.Timeout | null = null;

  private ensureLoaded(): void {
    if (this.loaded) return;
    try {
      if (fs.existsSync(MAP_PATH)) {
        const raw = fs.readFileSync(MAP_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as MapFile;
        this.state = parsed?.state || {};
      }
    } catch (err) {
      console.warn('[PlaceholderMap] Failed to load, starting fresh:', err);
      this.state = {};
    }
    this.loaded = true;
  }

  private scheduleSave(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      this.save();
    }, 100);
  }

  private save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const file: MapFile = { version: 1, state: this.state };
      fs.writeFileSync(MAP_PATH, JSON.stringify(file, null, 2), 'utf-8');
    } catch (err) {
      console.error('[PlaceholderMap] Failed to save:', err);
    }
  }

  private keyOf(original: string): string {
    return original.trim().toLowerCase();
  }

  /**
   * Resolve a placeholder for (category, original). Returns the existing
   * placeholder if (category, original) has been seen before; otherwise
   * allocates the next index from the global counter and persists.
   */
  resolve(category: PiiCategory, original: string): string {
    this.ensureLoaded();
    const key = this.keyOf(original);
    if (key.length === 0) return `[${category}]`;
    let bucket = this.state[category];
    if (!bucket) {
      bucket = { counter: 0, entries: {} };
      this.state[category] = bucket;
    }
    let idx = bucket.entries[key];
    if (idx === undefined) {
      bucket.counter += 1;
      idx = bucket.counter;
      bucket.entries[key] = idx;
      this.scheduleSave();
    }
    return `[${category}${idx}]`;
  }

  /**
   * Inspect-only stats — useful for debugging / future admin endpoints.
   */
  stats(): Record<string, { counter: number; size: number }> {
    this.ensureLoaded();
    const out: Record<string, { counter: number; size: number }> = {};
    for (const [cat, bucket] of Object.entries(this.state)) {
      if (!bucket) continue;
      out[cat] = { counter: bucket.counter, size: Object.keys(bucket.entries).length };
    }
    return out;
  }
}

export const placeholderMapService = new PlaceholderMapService();
