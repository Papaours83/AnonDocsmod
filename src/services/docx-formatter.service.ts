import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { PDFDocument as PDFLibDocument, StandardFonts, rgb } from 'pdf-lib';
import { parseString } from 'xml2js';
import { promisify } from 'util';
import { PiiReplacement } from './llm.service';
import { PdfStructure } from './parser.service';

const parseXml = promisify(parseString);

export class DocxFormatterService {
  private downloadsDir: string;

  constructor(downloadsDir = './downloads') {
    this.downloadsDir = downloadsDir;
    this.ensureDownloadsDirectory();
  }

  private ensureDownloadsDirectory(): void {
    if (!fs.existsSync(this.downloadsDir)) {
      fs.mkdirSync(this.downloadsDir, { recursive: true });
    }
  }

  /**
   * Anonymize a DOCX file using precise PII replacements
   * Preserves ALL formatting by replacing text directly in XML nodes.
   * Processes every word/*.xml part (main document, headers, footers,
   * footnotes, endnotes, comments, glossary) so PII in text boxes and
   * running heads/feet is also anonymized.
   */
  async anonymizeDocx(
    inputPath: string,
    replacements: PiiReplacement[]
  ): Promise<{ filePath: string; filename: string }> {
    try {
      console.log('[DOCX] Starting anonymization with', replacements.length, 'replacements');

      const data = fs.readFileSync(inputPath);
      const zip = await JSZip.loadAsync(data);

      const xmlParts = this.listDocxTextXmlParts(zip);
      if (xmlParts.length === 0) {
        throw new Error('Invalid DOCX file: no word/*.xml parts with text content');
      }

      for (const part of xmlParts) {
        await this.transformDocxXmlPart(zip, part, replacements);
      }

      const filename = `anonymized-${Date.now()}-${Math.round(Math.random() * 1e9)}.docx`;
      const outputPath = path.join(this.downloadsDir, filename);
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      fs.writeFileSync(outputPath, buffer);

      console.log('[DOCX] Anonymization complete:', filename, '(parts:', xmlParts.length, ')');
      return { filePath: outputPath, filename };
    } catch (error) {
      console.error('[DOCX] Error anonymizing:', error);
      throw error;
    }
  }

  /**
   * List every XML part inside a DOCX ZIP that is likely to contain body text
   * (<w:t>). Covers document, headers, footers, footnotes, endnotes, comments.
   */
  private listDocxTextXmlParts(zip: JSZip): string[] {
    return Object.keys(zip.files).filter((name) => {
      if (!name.endsWith('.xml')) return false;
      if (!name.startsWith('word/')) return false;
      if (name.startsWith('word/_rels/')) return false;
      if (name.startsWith('word/theme/')) return false;
      if (name === 'word/settings.xml') return false;
      if (name === 'word/styles.xml') return false;
      if (name === 'word/fontTable.xml') return false;
      if (name === 'word/webSettings.xml') return false;
      if (name === 'word/numbering.xml') return false;
      return true;
    });
  }

  private async transformDocxXmlPart(
    zip: JSZip,
    partName: string,
    replacements: PiiReplacement[]
  ): Promise<void> {
    const xml = await zip.file(partName)?.async('string');
    if (!xml) return;
    if (!xml.includes('<w:t')) return;

    try {
      // String-based replacement only. Parsing + rebuilding with xml2js
      // reorders siblings of different tag names (e.g. groups all <w:p>
      // together then all <w:tbl>), which moves tables to the end of the body.
      const newXml = this.replaceInDocxXml(xml, replacements);
      if (newXml !== xml) zip.file(partName, newXml);
    } catch (err) {
      console.warn(`[DOCX] Skipped ${partName} (replace error):`, err);
    }
  }

  /**
   * Apply PII replacements to a DOCX XML string without touching its
   * structure. Two passes:
   *   1. Replace inside each individual <w:t>…</w:t> run.
   *   2. For each <w:p>…</w:p> with multiple <w:t> runs, concatenate the run
   *      texts and re-run replacement so PII split across runs is still caught;
   *      on match, the whole replaced string goes into the first run and the
   *      others are emptied (same trade-off as the previous implementation).
   */
  private replaceInDocxXml(xml: string, replacements: PiiReplacement[]): string {
    const tRegex = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;

    // Pass 1: per-run replacement
    let out = xml.replace(tRegex, (_m, open: string, inner: string, close: string) => {
      const decoded = this.xmlDecodeText(inner);
      const replaced = this.replaceAllOccurrences(decoded, replacements);
      if (replaced === decoded) return _m;
      return `${this.ensureXmlSpacePreserve(open, replaced)}${this.xmlEncodeText(replaced)}${close}`;
    });

    // Pass 2: cross-run replacement within each <w:p>…</w:p>
    const pRegex = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
    out = out.replace(pRegex, (pBlock: string) => {
      const tMatches = [...pBlock.matchAll(tRegex)];
      if (tMatches.length < 2) return pBlock;

      const texts = tMatches.map((m) => this.xmlDecodeText(m[2]));
      const combined = texts.join('');
      const replaced = this.replaceAllOccurrences(combined, replacements);
      if (replaced === combined) return pBlock;

      let idx = 0;
      return pBlock.replace(tRegex, (_m, open: string, _inner: string, close: string) => {
        const content = idx === 0 ? replaced : '';
        idx++;
        const finalOpen = content ? this.ensureXmlSpacePreserve(open, content) : open;
        return `${finalOpen}${this.xmlEncodeText(content)}${close}`;
      });
    });

    return out;
  }

  /**
   * Ensure a <w:t ...> opening tag carries xml:space="preserve" when the new
   * text contains leading/trailing whitespace — without it, Word trims spaces.
   */
  private ensureXmlSpacePreserve(openTag: string, text: string): string {
    if (/xml:space\s*=/.test(openTag)) return openTag;
    if (!/^\s|\s$/.test(text)) return openTag;
    return openTag.replace(/^<w:t\b/, '<w:t xml:space="preserve"');
  }

  private xmlDecodeText(s: string): string {
    return s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  private xmlEncodeText(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * Extract all text nodes from the parsed XML with their positions
   * Adds line breaks between paragraphs
   */
  private extractTextNodes(
    obj: any,
    textNodes: any[] = [],
    path: string[] = [],
    lastWasParagraph = false
  ): any[] {
    if (!obj || typeof obj !== 'object') {
      return textNodes;
    }

    // Check if we're at a paragraph boundary (w:p)
    // Add a line break after each paragraph
    if ('w:p' in obj) {
      // Process the paragraph content first
      const paragraphContent = obj['w:p'];
      if (Array.isArray(paragraphContent)) {
        paragraphContent.forEach((item, index) => {
          this.extractTextNodes(item, textNodes, [...path, 'w:p', `[${index}]`], false);
        });
      } else {
        this.extractTextNodes(paragraphContent, textNodes, [...path, 'w:p'], false);
      }

      // Add line break after paragraph
      const currentPos = textNodes.reduce((sum, node) => sum + node.text.length, 0);
      textNodes.push({
        text: '\n',
        startPos: currentPos,
        endPos: currentPos + 1,
        xmlPath: [...path, '__PARAGRAPH_BREAK__'],
      });

      return textNodes;
    }

    // Check if we found a w:t element (text node)
    if ('w:t' in obj) {
      const textContent = obj['w:t'];

      // Handle both string and array cases
      if (Array.isArray(textContent)) {
        textContent.forEach((item, index) => {
          if (typeof item === 'string') {
            const currentPos = textNodes.reduce((sum, node) => sum + node.text.length, 0);
            textNodes.push({
              text: item,
              startPos: currentPos,
              endPos: currentPos + item.length,
              xmlPath: [...path, 'w:t', `[${index}]`],
            });
          } else if (typeof item === 'object' && item._) {
            const text = item._;
            const currentPos = textNodes.reduce((sum, node) => sum + node.text.length, 0);
            textNodes.push({
              text,
              startPos: currentPos,
              endPos: currentPos + text.length,
              xmlPath: [...path, 'w:t', `[${index}]`],
            });
          }
        });
      } else if (typeof textContent === 'string') {
        const currentPos = textNodes.reduce((sum, node) => sum + node.text.length, 0);
        textNodes.push({
          text: textContent,
          startPos: currentPos,
          endPos: currentPos + textContent.length,
          xmlPath: [...path, 'w:t'],
        });
      } else if (typeof textContent === 'object' && textContent._) {
        const text = textContent._;
        const currentPos = textNodes.reduce((sum, node) => sum + node.text.length, 0);
        textNodes.push({
          text,
          startPos: currentPos,
          endPos: currentPos + text.length,
          xmlPath: [...path, 'w:t'],
        });
      }
    }

    // Recursively traverse the object
    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        this.extractTextNodes(item, textNodes, [...path, `[${index}]`], lastWasParagraph);
      });
    } else {
      Object.keys(obj).forEach((key) => {
        this.extractTextNodes(obj[key], textNodes, [...path, key], lastWasParagraph);
      });
    }

    return textNodes;
  }

  /**
   * Replace all occurrences of PII in a text string
   */
  private replaceAllOccurrences(text: string, replacements: PiiReplacement[]): string {
    let result = text;

    // Sort replacements by length (longest first) to avoid partial replacements
    const sortedReplacements = [...replacements].sort(
      (a, b) => b.original.length - a.original.length
    );

    for (const replacement of sortedReplacements) {
      // Use global replace to catch all occurrences
      const regex = new RegExp(this.escapeRegex(replacement.original), 'g');
      result = result.replace(regex, replacement.anonymized);
    }

    return result;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Extract plain text from DOCX (for anonymization). Walks every word/*.xml
   * part so headers, footers, and text boxes are sent to the LLM too.
   */
  async extractText(docxPath: string): Promise<string> {
    try {
      const data = fs.readFileSync(docxPath);
      const zip = await JSZip.loadAsync(data);

      const parts = this.listDocxTextXmlParts(zip);
      if (parts.length === 0) {
        throw new Error('Invalid DOCX file: no word/*.xml parts found');
      }

      // Keep document.xml first for readable context, then append other parts
      parts.sort((a, b) => {
        if (a === 'word/document.xml') return -1;
        if (b === 'word/document.xml') return 1;
        return a.localeCompare(b);
      });

      const pieces: string[] = [];
      for (const partName of parts) {
        const xml = await zip.file(partName)?.async('string');
        if (!xml || !xml.includes('<w:t')) continue;
        try {
          const parsed = await parseXml(xml);
          const textNodes = this.extractTextNodes(parsed);
          const joined = textNodes.map((n) => n.text).join('');
          if (joined.trim()) pieces.push(joined);
        } catch (err) {
          console.warn(`[DOCX] Skipped ${partName} (parse error):`, err);
        }
      }

      const text = pieces.join('\n\n');
      console.log('[DOCX] Extracted text length:', text.length, 'from', pieces.length, 'parts');
      return text;
    } catch (error) {
      console.error('[DOCX] Error extracting text:', error);
      throw error;
    }
  }

  /**
   * Parse a PII report txt file and return placeholder → original mapping as PiiReplacement[]
   * Uses the "=== Replacements ===" section with lines "[Placeholder] = original"
   */
  parsePiiReport(txtPath: string): PiiReplacement[] {
    const content = fs.readFileSync(txtPath, 'utf8');
    const lines = content.split(/\r?\n/);
    const reps: PiiReplacement[] = [];
    let inReplacements = false;
    for (const line of lines) {
      if (/^===\s*Replacements\s*===/i.test(line)) {
        inReplacements = true;
        continue;
      }
      if (/^===/.test(line)) {
        inReplacements = false;
        continue;
      }
      if (!inReplacements) continue;
      const m = line.match(/^(\[[^\]]+\])\s*=\s*(.+)$/);
      if (m) {
        reps.push({ original: m[1], anonymized: m[2] });
      }
    }
    return reps;
  }

  /**
   * De-anonymize a DOCX: replace placeholders with original values using a
   * PII report. Processes every word/*.xml part.
   */
  async deanonymizeDocx(
    inputPath: string,
    replacements: PiiReplacement[]
  ): Promise<{ filePath: string; filename: string }> {
    const data = fs.readFileSync(inputPath);
    const zip = await JSZip.loadAsync(data);

    const parts = this.listDocxTextXmlParts(zip);
    if (parts.length === 0) {
      throw new Error('Invalid DOCX file: no word/*.xml parts found');
    }
    for (const partName of parts) {
      await this.transformDocxXmlPart(zip, partName, replacements);
    }

    const filename = `deanonymized-${Date.now()}-${Math.round(Math.random() * 1e9)}.docx`;
    const outputPath = path.join(this.downloadsDir, filename);
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(outputPath, buffer);
    return { filePath: outputPath, filename };
  }

  /**
   * De-anonymize plain text content
   */
  deanonymizeText(text: string, replacements: PiiReplacement[]): string {
    return this.replaceAllOccurrences(text, replacements);
  }

  /**
   * Write a plain text file (used for de-anonymized TXT output)
   */
  writeTextFile(content: string, prefix = 'deanonymized'): { filePath: string; filename: string } {
    const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.txt`;
    const filePath = path.join(this.downloadsDir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return { filePath, filename };
  }

  /**
   * Write plain text content as a PDF file.
   * Formatting from the original PDF cannot be recovered from extracted text —
   * the output is a simple single-font layout.
   */
  writePdfFile(
    content: string,
    prefix = 'deanonymized'
  ): Promise<{ filePath: string; filename: string }> {
    const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
    const filePath = path.join(this.downloadsDir, filename);

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);
      stream.on('finish', () => resolve({ filePath, filename }));
      stream.on('error', reject);
      doc.on('error', reject);
      doc.pipe(stream);
      doc.font('Helvetica').fontSize(11).text(content, { align: 'left' });
      doc.end();
    });
  }

  /**
   * Modify the original PDF in place: for every extracted text item whose
   * content changes after applying replacements, paint a white rectangle over
   * the original glyphs and draw the new text at the same position. Images,
   * vector graphics, and non-PII text keep their original rendering.
   *
   * Text is drawn in Helvetica — the original embedded fonts are not reusable
   * for arbitrary new strings (they usually subset to only the glyphs actually
   * used in the file).
   */
  async anonymizePdfInPlace(
    originalPdfPath: string,
    structure: PdfStructure,
    replacements: PiiReplacement[],
    prefix = 'anonymized'
  ): Promise<{ filePath: string; filename: string }> {
    const pdfBytes = fs.readFileSync(originalPdfPath);
    const pdfDoc = await PDFLibDocument.load(pdfBytes, { ignoreEncryption: true });
    const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const pages = pdfDoc.getPages();
    const pageCount = Math.min(pages.length, structure.pages.length);

    for (let i = 0; i < pageCount; i++) {
      const page = pages[i];
      const structPage = structure.pages[i];

      for (const item of structPage.items) {
        const newText = this.replaceAllOccurrences(item.text, replacements);
        if (newText === item.text) continue;

        const fontSize = Math.max(1, item.fontSize);
        const safeText = this.sanitizeForWinAnsi(newText);

        let newWidth = 0;
        try {
          newWidth = helvetica.widthOfTextAtSize(safeText, fontSize);
        } catch {
          newWidth = item.width;
        }
        const coverWidth = Math.max(item.width, newWidth) + 2;

        // Cover the original glyphs. item.y is the baseline; descender reaches
        // ~0.25 * fontSize below, ascender ~0.8 above.
        page.drawRectangle({
          x: item.x - 1,
          y: item.y - fontSize * 0.25,
          width: coverWidth,
          height: fontSize * 1.15,
          color: rgb(1, 1, 1),
          borderWidth: 0,
        });

        try {
          page.drawText(safeText, {
            x: item.x,
            y: item.y,
            size: fontSize,
            font: helvetica,
            color: rgb(0, 0, 0),
          });
        } catch (err) {
          // If Helvetica can't encode a character, fall back to ASCII-only
          const ascii = safeText.replace(/[^\x20-\x7E]/g, '?');
          try {
            page.drawText(ascii, {
              x: item.x,
              y: item.y,
              size: fontSize,
              font: helvetica,
              color: rgb(0, 0, 0),
            });
          } catch {
            // Last resort: leave the white box, drop the text entirely
          }
        }
      }
    }

    const outBytes = await pdfDoc.save();
    const filename = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e9)}.pdf`;
    const filePath = path.join(this.downloadsDir, filename);
    fs.writeFileSync(filePath, outBytes);
    return { filePath, filename };
  }

  /**
   * Strip code points that Helvetica's WinAnsi encoding cannot represent.
   * Preserves Latin-1 (covers French accents, common punctuation).
   */
  private sanitizeForWinAnsi(text: string): string {
    return text
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2013\u2014\u2015]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/\u202F/g, ' ')
      .replace(/[\u2192\u2794\u27A1]/g, '->')
      .replace(/[\u2190]/g, '<-');
  }

  /**
   * Write a PII report as a plain text file to the downloads directory
   */
  writePiiReport(
    piiDetected: Record<string, string[]>,
    replacements: PiiReplacement[]
  ): { filePath: string; filename: string } {
    const filename = `pii-${Date.now()}-${Math.round(Math.random() * 1e9)}.txt`;
    const filePath = path.join(this.downloadsDir, filename);

    const lines: string[] = [];
    lines.push('=== PII Detected ===', '');
    for (const [category, items] of Object.entries(piiDetected)) {
      if (!items || items.length === 0) continue;
      lines.push(`[${category}]`);
      for (const item of items) lines.push(`  - ${item}`);
      lines.push('');
    }

    lines.push('=== Replacements ===', '');
    for (const rep of replacements) {
      lines.push(`${rep.anonymized} = ${rep.original}`);
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    return { filePath, filename };
  }

  /**
   * Check if file exists
   */
  fileExists(filename: string): boolean {
    const filePath = path.join(this.downloadsDir, filename);
    return fs.existsSync(filePath);
  }

  /**
   * Get file path
   */
  getFilePath(filename: string): string {
    return path.join(this.downloadsDir, filename);
  }

  /**
   * Delete file
   */
  deleteFile(filename: string): void {
    const filePath = path.join(this.downloadsDir, filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * Cleanup old files
   */
  cleanupOldFiles(hoursOld = 24): void {
    const files = fs.readdirSync(this.downloadsDir);
    const now = Date.now();
    const maxAge = hoursOld * 60 * 60 * 1000;

    files.forEach((file) => {
      const filePath = path.join(this.downloadsDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtimeMs;

      if (fileAge > maxAge) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up old file: ${file}`);
      }
    });
  }
}

export const docxFormatterService = new DocxFormatterService();
