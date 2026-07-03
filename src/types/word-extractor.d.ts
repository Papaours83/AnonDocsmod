// Minimal type declarations for the untyped `word-extractor` package.
// Only the surface we use is declared.
declare module 'word-extractor' {
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(options?: { includeFooters?: boolean }): string;
    getFooters(): string;
    getEndnotes(): string;
    getAnnotations(): string;
    getTextboxes(options?: { includeHeadersAndFooters?: boolean; includeBody?: boolean }): string;
  }

  class WordExtractor {
    extract(filePathOrBuffer: string | Buffer): Promise<WordDocument>;
  }

  export = WordExtractor;
}
