import { Request, Response } from 'express';
import { anonymizationService } from '../services/anonymization.service';
import { parserService } from '../services/parser.service';
import { docxFormatterService } from '../services/docx-formatter.service';
import { LLMProvider } from '../services/llm.service';
import fs from 'fs';
import JSZip from 'jszip';

export class DocumentController {
  /**
   * Anonymize document
   * - DOCX: Returns download link with formatting preserved
   * - PDF/TXT: Returns plain anonymized text only
   */
  async anonymizeDocument(req: Request, res: Response): Promise<void> {
    try {
      if (!req.file) {
        res.status(400).json({
          error: 'No file uploaded',
        });
        return;
      }

      const { provider } = req.body;
      const mimeType = req.file.mimetype;
      const isDocx =
        mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

      // Validate provider if provided
      if (provider && !['openai', 'anthropic', 'ollama'].includes(provider)) {
        fs.unlinkSync(req.file.path);
        res.status(400).json({
          error: 'Invalid provider. Must be one of: openai, anthropic, ollama',
        });
        return;
      }

      if (isDocx) {
        // Handle DOCX: preserve formatting
        await this.handleDocx(req, res, provider as LLMProvider);
      } else {
        // Handle PDF/TXT: plain text only
        await this.handlePlainText(req, res, provider as LLMProvider);
      }
    } catch (error) {
      // Clean up file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      console.error('Error in anonymizeDocument controller:', error);
      res.status(500).json({
        error: 'Failed to anonymize document',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Handle DOCX files with formatting preservation
   */
  private async handleDocx(req: Request, res: Response, provider: LLMProvider): Promise<void> {
    if (!req.file) return;

    // Extract text from DOCX
    const text = await docxFormatterService.extractText(req.file.path);

    if (!text || text.trim().length === 0) {
      fs.unlinkSync(req.file.path);
      res.status(400).json({
        error: 'Could not extract text from document',
      });
      return;
    }

    // Anonymize the text
    const result = await anonymizationService.anonymizeText(text, provider);

    // Create anonymized DOCX with formatting preserved using replacements
    const { filename } = await docxFormatterService.anonymizeDocx(
      req.file.path,
      result.replacements
    );

    // Clean up uploaded file
    fs.unlinkSync(req.file.path);

    // Generate PII report txt
    const piiReport = docxFormatterService.writePiiReport(
      result.piiDetected as any,
      result.replacements
    );

    // Stream a zip containing the anonymized docx + pii report
    const baseName = req.file.originalname.replace(/\.docx$/i, '');
    const zip = new JSZip();
    zip.file(
      `anonymized-${baseName}.docx`,
      fs.readFileSync(docxFormatterService.getFilePath(filename))
    );
    zip.file(
      `pii-${baseName}.txt`,
      fs.readFileSync(docxFormatterService.getFilePath(piiReport.filename))
    );
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="anonymized-${baseName}.zip"`);
    res.setHeader('X-Anonymized-Filename', filename);
    res.setHeader('X-Pii-Filename', piiReport.filename);
    res.send(zipBuffer);
  }

  /**
   * Handle PDF/TXT files - return plain text only
   */
  private async handlePlainText(req: Request, res: Response, provider: LLMProvider): Promise<void> {
    if (!req.file) return;

    // Parse document to extract text
    const text = await parserService.parseDocument(req.file.path, req.file.mimetype);

    // Clean up uploaded file immediately
    fs.unlinkSync(req.file.path);

    if (!text || text.trim().length === 0) {
      res.status(400).json({
        error: 'Could not extract text from document',
      });
      return;
    }

    // Anonymize the text
    const result = await anonymizationService.anonymizeText(text, provider);

    // Generate PII report txt
    const piiReport = docxFormatterService.writePiiReport(
      result.piiDetected as any,
      result.replacements
    );

    // Write anonymized text to a .txt file and zip both
    const anonTxt = docxFormatterService.writeTextFile(result.anonymizedText, 'anonymized');
    const baseName = req.file.originalname.replace(/\.(pdf|txt)$/i, '');

    const zip = new JSZip();
    zip.file(`anonymized-${baseName}.txt`, fs.readFileSync(anonTxt.filePath));
    zip.file(
      `pii-${baseName}.txt`,
      fs.readFileSync(docxFormatterService.getFilePath(piiReport.filename))
    );
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="anonymized-${baseName}.zip"`);
    res.setHeader('X-Anonymized-Filename', anonTxt.filename);
    res.setHeader('X-Pii-Filename', piiReport.filename);
    res.send(zipBuffer);
  }

  /**
   * De-anonymize a document using an uploaded PII report (.txt)
   * Form fields:
   *  - file: anonymized document (.docx, .txt or .pdf)
   *  - piiReport: PII report .txt produced by /api/document
   *
   * Note: PDF input is regenerated as a plain PDF — original formatting
   * cannot be recovered from extracted text.
   */
  async deanonymizeDocument(req: Request, res: Response): Promise<void> {
    const files = req.files as { [k: string]: Express.Multer.File[] } | undefined;
    const docFile = files?.file?.[0];
    const reportFile = files?.piiReport?.[0];

    try {
      if (!docFile || !reportFile) {
        res.status(400).json({ error: 'Both "file" and "piiReport" must be uploaded' });
        return;
      }

      if (!reportFile.originalname.toLowerCase().endsWith('.txt')) {
        res.status(400).json({ error: 'piiReport must be a .txt file' });
        return;
      }

      const replacements = docxFormatterService.parsePiiReport(reportFile.path);
      if (replacements.length === 0) {
        res.status(400).json({ error: 'No replacements found in PII report' });
        return;
      }

      const docName = docFile.originalname.toLowerCase();
      const baseName = docFile.originalname.replace(/\.(docx|txt|pdf)$/i, '');

      if (docName.endsWith('.docx')) {
        const { filePath, filename } = await docxFormatterService.deanonymizeDocx(
          docFile.path,
          replacements
        );
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="deanonymized-${baseName}.docx"`
        );
        res.setHeader('X-Replacements-Applied', String(replacements.length));
        res.setHeader('X-Generated-Filename', filename);
        fs.createReadStream(filePath).pipe(res);
      } else if (docName.endsWith('.txt')) {
        const content = fs.readFileSync(docFile.path, 'utf8');
        const restored = docxFormatterService.deanonymizeText(content, replacements);
        const { filePath, filename } = docxFormatterService.writeTextFile(restored);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="deanonymized-${baseName}.txt"`
        );
        res.setHeader('X-Replacements-Applied', String(replacements.length));
        res.setHeader('X-Generated-Filename', filename);
        fs.createReadStream(filePath).pipe(res);
      } else if (docName.endsWith('.pdf')) {
        const content = await parserService.parseDocument(docFile.path, 'application/pdf');
        if (!content || content.trim().length === 0) {
          res.status(400).json({ error: 'Could not extract text from PDF' });
          return;
        }
        const restored = docxFormatterService.deanonymizeText(content, replacements);
        const { filePath, filename } = await docxFormatterService.writePdfFile(restored);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="deanonymized-${baseName}.pdf"`
        );
        res.setHeader('X-Replacements-Applied', String(replacements.length));
        res.setHeader('X-Generated-Filename', filename);
        fs.createReadStream(filePath).pipe(res);
      } else {
        res.status(400).json({ error: 'file must be a .docx, .txt or .pdf' });
      }
    } catch (error) {
      console.error('Error in deanonymizeDocument controller:', error);
      res.status(500).json({
        error: 'Failed to deanonymize document',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      if (docFile && fs.existsSync(docFile.path)) fs.unlinkSync(docFile.path);
      if (reportFile && fs.existsSync(reportFile.path)) fs.unlinkSync(reportFile.path);
    }
  }

  /**
   * Download anonymized DOCX file
   */
  async downloadDocument(req: Request, res: Response): Promise<void> {
    try {
      const { filename } = req.params;

      // Security: Validate filename
      if (!filename || filename.includes('..') || filename.includes('/')) {
        res.status(400).json({
          error: 'Invalid filename',
        });
        return;
      }

      // Only allow DOCX or TXT downloads
      const isDocx = filename.endsWith('.docx');
      const isTxt = filename.endsWith('.txt');
      if (!isDocx && !isTxt) {
        res.status(400).json({
          error: 'Only DOCX or TXT files can be downloaded',
        });
        return;
      }

      // Check if file exists
      if (!docxFormatterService.fileExists(filename)) {
        res.status(404).json({
          error: 'File not found',
        });
        return;
      }

      const filePath = docxFormatterService.getFilePath(filename);

      // Set headers for download
      res.setHeader(
        'Content-Type',
        isDocx
          ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          : 'text/plain; charset=utf-8'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Stream the file
      const fileStream = fs.createReadStream(filePath);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: 'Failed to download file',
          });
        }
      });
    } catch (error) {
      console.error('Error in downloadDocument controller:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to download file',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }
}

export const documentController = new DocumentController();
