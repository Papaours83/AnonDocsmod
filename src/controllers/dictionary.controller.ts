import { Request, Response } from 'express';
import { dictionaryService, DictionarySource } from '../services/dictionary.service';
import { PiiCategory } from '../services/llm.service';

const CATEGORIES: PiiCategory[] = [
  'Name',
  'Organization',
  'Address',
  'Email',
  'Phone',
  'Date',
  'Id',
];

export class DictionaryController {
  async list(req: Request, res: Response): Promise<void> {
    try {
      const category = req.query.category as PiiCategory | undefined;
      const source = req.query.source as DictionarySource | undefined;
      if (category && !CATEGORIES.includes(category)) {
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
        const { added, updated } = dictionaryService.addBatch(
          body.entries,
          'manual'
        );
        res.json({ success: true, added, updated });
        return;
      }
      const { original, category } = body || {};
      if (!original || typeof original !== 'string') {
        res.status(400).json({ error: 'original is required and must be a string' });
        return;
      }
      if (!category || !CATEGORIES.includes(category)) {
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
      const category = req.query.category as PiiCategory | undefined;
      if (!original || typeof original !== 'string') {
        res.status(400).json({ error: 'original query param is required' });
        return;
      }
      if (!category || !CATEGORIES.includes(category)) {
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
