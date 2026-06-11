import { Request, Response } from 'express';
import { dictionaryService, DictionarySource } from '../services/dictionary.service';
import { PiiCategory } from '../services/llm.service';

const CATEGORIES: PiiCategory[] = [
  'Name',
  'Address',
  'Email',
  'Phone',
  'Date',
  'Id',
];

/**
 * Maps category labels (French UI labels, case/accents variants) to the
 * canonical English PiiCategory expected by the rest of the system.
 * Organization is intentionally absent — organizations are out of scope.
 */
const CATEGORY_ALIASES: Record<string, PiiCategory> = {
  name: 'Name',
  nom: 'Name',
  address: 'Address',
  adresse: 'Address',
  email: 'Email',
  courriel: 'Email',
  'e-mail': 'Email',
  mail: 'Email',
  phone: 'Phone',
  telephone: 'Phone',
  tel: 'Phone',
  date: 'Date',
  id: 'Id',
  identifiant: 'Id',
};

/**
 * Normalizes an incoming category value. Returns the canonical PiiCategory,
 * or null if it cannot be mapped.
 */
function normalizeCategory(value: unknown): PiiCategory | null {
  if (typeof value !== 'string') return null;
  const key = value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // strip accents
  return CATEGORY_ALIASES[key] ?? null;
}

export class DictionaryController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const rawCategory = req.query.category;
      const category = rawCategory ? normalizeCategory(rawCategory) ?? undefined : undefined;
      const source = req.query.source as DictionarySource | undefined;
      if (rawCategory && !category) {
        res.status(400).json({ error: `Invalid category. Must be one of: ${CATEGORIES.join(', ')}` });
        return;
      }
      if (source && source !== 'manual' && source !== 'detected') {
        res.status(400).json({ error: 'Invalid source. Must be manual or detected' });
        return;
      }
      const entries = dictionaryService.list({ category, source });
      res.json({ success: true, count: entries.length, entries });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to list dictionary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async add(req: Request, res: Response): Promise<void> {
    try {
      const body = req.body;
      if (Array.isArray(body?.entries)) {
        const normalized = body.entries.map((e: { original: string; category: unknown }) => ({
          original: e?.original,
          category: normalizeCategory(e?.category) ?? e?.category,
        }));
        const { added, updated } = dictionaryService.addBatch(normalized, 'manual');
        res.json({ success: true, added, updated });
        return;
      }
      const { original } = body || {};
      const category = normalizeCategory(body?.category);
      if (!original || typeof original !== 'string') {
        res.status(400).json({ error: 'original is required and must be a string' });
        return;
      }
      if (!category) {
        res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
        return;
      }
      const { entry, created } = dictionaryService.addEntry(original, category, 'manual');
      res.status(created ? 201 : 200).json({ success: true, created, entry });
    } catch (error) {
      res.status(400).json({
        error: 'Failed to add entry',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async remove(req: Request, res: Response): Promise<void> {
    try {
      const original = req.query.original as string | undefined;
      const category = normalizeCategory(req.query.category);
      if (!original || typeof original !== 'string') {
        res.status(400).json({ error: 'original query param is required' });
        return;
      }
      if (!category) {
        res.status(400).json({ error: `category query param must be one of: ${CATEGORIES.join(', ')}` });
        return;
      }
      const removed = dictionaryService.removeEntry(original, category);
      if (!removed) {
        res.status(404).json({ success: false, error: 'Entry not found' });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to remove entry',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

export const dictionaryController = new DictionaryController();
