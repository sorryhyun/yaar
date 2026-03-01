/**
 * Type definitions for @bundled/prismjs — syntax highlighting library.
 */

declare module '@bundled/prismjs' {
  interface Grammar {
    [key: string]: RegExp | GrammarToken | Array<RegExp | GrammarToken>;
  }

  interface GrammarToken {
    pattern: RegExp;
    lookbehind?: boolean;
    greedy?: boolean;
    alias?: string | string[];
    inside?: Grammar;
  }

  interface Token {
    type: string;
    content: string | Token | Array<string | Token>;
    alias?: string | string[];
    length: number;
  }

  namespace Prism {
    /** Highlight a code string and return HTML */
    function highlight(code: string, grammar: Grammar, language: string): string;

    /** Highlight all <code> elements on the page */
    function highlightAll(async?: boolean): void;

    /** Highlight a single DOM element */
    function highlightElement(element: Element, async?: boolean): void;

    /** Tokenize a string into Token objects */
    function tokenize(text: string, grammar: Grammar): Array<string | Token>;

    /** Registered language grammars */
    const languages: {
      [language: string]: Grammar;
      /** Extend an existing grammar */
      extend(id: string, redef: Grammar): Grammar;
      /** Insert tokens before an existing token in a grammar */
      insertBefore(inside: string, before: string, insert: Grammar, root?: Grammar): Grammar;
    };

    /** Map of hooks for plugins */
    const hooks: {
      add(name: string, callback: (...args: any[]) => void): void;
      run(name: string, env: Record<string, any>): void;
    };

    /** Utility functions */
    namespace util {
      function encode(tokens: string | Token | Array<string | Token>): string;
      function type(o: any): string;
      function clone<T>(o: T): T;
    }
  }

  export default Prism;
}
