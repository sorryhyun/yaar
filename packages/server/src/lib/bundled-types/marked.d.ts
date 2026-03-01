/**
 * Type definitions for @bundled/marked — markdown parser and compiler.
 */

declare module '@bundled/marked' {
  interface MarkedOptions {
    /** Enable GitHub Flavored Markdown (default: true) */
    gfm?: boolean;
    /** Add <br> on single line breaks (default: false) */
    breaks?: boolean;
    /** Sanitize output HTML (deprecated — use external sanitizer) */
    sanitize?: boolean;
    /** Use async rendering */
    async?: boolean;
  }

  interface Token {
    type: string;
    raw: string;
    text?: string;
    tokens?: Token[];
  }

  interface Lexer {
    lex(src: string): Token[];
  }

  interface Parser {
    parse(tokens: Token[]): string;
  }

  /** Parse markdown string to HTML */
  export function marked(src: string, options?: MarkedOptions): string | Promise<string>;

  export namespace marked {
    /** Parse markdown string to HTML */
    function parse(src: string, options?: MarkedOptions): string | Promise<string>;
    /** Set default options */
    function setOptions(options: MarkedOptions): typeof marked;
    /** Get current defaults */
    function getDefaults(): MarkedOptions;
    /** Tokenize markdown into token list */
    function lexer(src: string, options?: MarkedOptions): Token[];
    /** Parse tokens into HTML */
    function parser(tokens: Token[], options?: MarkedOptions): string;
    /** Register an extension */
    function use(
      ...extensions: Array<{
        renderer?: Record<string, (...args: any[]) => string>;
        tokenizer?: Record<string, (...args: any[]) => Token | undefined>;
        extensions?: Array<{
          name: string;
          level: 'block' | 'inline';
          start?: (src: string) => number | undefined;
          tokenizer?: (src: string) => Token | undefined;
          renderer?: (token: Token) => string;
        }>;
      }>
    ): void;
  }

  /** Lexer class */
  export const Lexer: { new (): Lexer; lex(src: string): Token[] };
  /** Parser class */
  export const Parser: { new (): Parser; parse(tokens: Token[]): string };
}
