import fs from 'fs';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';

const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  fontSize: number;
  width: number;
  height: number;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfPage {
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfStructure {
  pages: PdfPage[];
}

export class ParserService {
  private readonly wordExtractor = new WordExtractor();

  /**
   * Parse document based on mime type
   */
  async parseDocument(filePath: string, mimeType: string): Promise<string> {
    switch (mimeType) {
      case 'application/pdf':
        return this.parsePdf(filePath);
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return this.parseDocx(filePath);
      case 'application/msword':
        return this.parseDoc(filePath);
      case 'text/plain':
        return this.parseTxt(filePath);
      default:
        throw new Error(`Unsupported file type: ${mimeType}`);
    }
  }

  /**
   * Extract text from a legacy binary Word document (.doc, Word 97-2003).
   * mammoth only handles .docx, so we use word-extractor here. Formatting is
   * NOT preserved — callers should return the anonymized result as plain text.
   */
  async parseDoc(filePath: string): Promise<string> {
    const doc = await this.wordExtractor.extract(filePath);
    return doc.getBody();
  }

  private async parsePdf(filePath: string): Promise<string> {
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdf(dataBuffer);
    return data.text;
  }

  /**
   * Parse a PDF keeping per-item positions so the anonymized output can be
   * rebuilt at the same coordinates (preserves pagination and layout).
   */
  async parsePdfStructured(filePath: string): Promise<PdfStructure> {
    const data = new Uint8Array(fs.readFileSync(filePath));
    const loadingTask = pdfjsLib.getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
    });
    const doc = await loadingTask.promise;

    const pages: PdfPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();

      const items: PdfTextItem[] = [];
      for (const raw of textContent.items as any[]) {
        if (!raw || typeof raw.str !== 'string') continue;
        if (raw.str.length === 0) continue;
        const t = raw.transform as number[];
        // fontSize = Euclidean norm of scale components (handles rotation/skew)
        const fontSize = Math.hypot(t[2], t[3]) || Math.hypot(t[0], t[1]) || 10;
        items.push({
          text: raw.str,
          x: t[4],
          y: t[5],
          fontSize,
          width: raw.width ?? 0,
          height: raw.height ?? fontSize,
          fontName: raw.fontName,
          hasEOL: !!raw.hasEOL,
        });
      }

      pages.push({ width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }

    await doc.cleanup();
    await doc.destroy();

    return { pages };
  }

  /**
   * Flatten a structured PDF into the same plain text the LLM anonymizer expects.
   * Items on the same visual line are separated by a space; new lines split pages.
   */
  flattenPdfStructure(structure: PdfStructure): string {
    const pageTexts: string[] = [];
    for (const page of structure.pages) {
      const lines: string[] = [];
      let current: string[] = [];
      let lastY: number | null = null;
      const Y_TOLERANCE = 2; // points

      for (const item of page.items) {
        const sameLine = lastY !== null && Math.abs(item.y - lastY) < Y_TOLERANCE;
        if (!sameLine && current.length > 0) {
          lines.push(current.join(' '));
          current = [];
        }
        current.push(item.text);
        lastY = item.y;
        if (item.hasEOL) {
          lines.push(current.join(' '));
          current = [];
          lastY = null;
        }
      }
      if (current.length > 0) lines.push(current.join(' '));
      pageTexts.push(lines.join('\n'));
    }
    return pageTexts.join('\n\n');
  }

  private async parseDocx(filePath: string): Promise<string> {
    // Use HTML conversion (not extractRawText) so table structure survives.
    // Mammoth's raw-text mode concatenates cell text without delimiters,
    // which hides row/column boundaries from the LLM and tanks detection
    // inside tables.
    const result = await mammoth.convertToHtml({ path: filePath });
    return this.htmlToTextWithTables(result.value);
  }

  /**
   * Strip HTML to plain text while keeping table layout visible:
   * - rows end with newline
   * - cells separated by tabs
   * - paragraphs / list items / line breaks become newlines
   * The LLM then sees tables as readable tabular text instead of a blob.
   */
  private htmlToTextWithTables(html: string): string {
    let out = html;
    out = out.replace(/<\/tr>/gi, '\n');
    out = out.replace(/<\/t[dh]>/gi, '\t');
    out = out.replace(/<\/p>/gi, '\n');
    out = out.replace(/<br\s*\/?>/gi, '\n');
    out = out.replace(/<\/li>/gi, '\n');
    out = out.replace(/<[^>]+>/g, '');
    out = out
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
    out = out.replace(/\t+\n/g, '\n');
    out = out.replace(/[ \t]+\n/g, '\n');
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }

  private async parseTxt(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, 'utf-8');
  }
}

export const parserService = new ParserService();
