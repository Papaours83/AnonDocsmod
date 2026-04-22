import { Router } from 'express';
import { dictionaryController } from '../controllers/dictionary.controller';

const router = Router();

/**
 * GET /api/dictionary
 * List all learned/manual PII entries.
 * Query params (optional): category, source
 */
router.get('/', (req, res) => dictionaryController.list(req, res));

/**
 * POST /api/dictionary
 * Add an entry (or a batch) to the dictionary, marked as source=manual.
 *
 * Single: { "original": "ACME SAS", "category": "Organization" }
 * Batch:  { "entries": [{ "original": "...", "category": "..." }, ...] }
 */
router.post('/', (req, res) => dictionaryController.add(req, res));

/**
 * DELETE /api/dictionary?original=...&category=...
 */
router.delete('/', (req, res) => dictionaryController.remove(req, res));

export const dictionaryRouter = router;
