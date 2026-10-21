/**
 * Solid `html` closing-tag rewrite, shared by the bundler plugin and the project guard scan.
 *
 * solid-js/html has no `</${Component}>` form; the closing tag is `</>`. Apps write
 * the readable spelling and the compile step rewrites it. The rewrite must stay
 * inside `html`-tagged templates: a plain string such as `<${tag}></${tag}>` is
 * ordinary user text and rewriting it corrupts the output.
 */

import { createAppSourceFile, type TsModule, type TsSourceFile } from './guard-report.js';

const CLOSING_TAG = /<\/\$\{([^}]+)\}>/g;

/**
 * Rewrite `</${X}>` to `</>` inside `html\`...\`` templates only.
 *
 * Files without `html\`` come back untouched without a parse. With no TypeScript
 * module (absent in a plain server install) the rewrite falls back to the whole
 * file, which is the old behavior: a build still works, string templates just
 * are not protected there.
 */
export function rewriteHtmlClosingTags(
  ts: TsModule | null,
  fileName: string,
  text: string,
): string {
  return rewriteHtmlClosingTagsParsed(ts, fileName, text).text;
}

/** The rewritten text, plus the `SourceFile` parsed on the way when it still matches. */
export interface HtmlClosingTagRewrite {
  text: string;
  /**
   * The parse of `text`, when the rewrite parsed the file and changed nothing — a
   * caller that scans the result reuses it instead of parsing the same text again.
   * Null when no parse happened or the text changed.
   */
  sourceFile: TsSourceFile | null;
}

/** `rewriteHtmlClosingTags`, keeping the parse for a caller that scans the result. */
export function rewriteHtmlClosingTagsParsed(
  ts: TsModule | null,
  fileName: string,
  text: string,
): HtmlClosingTagRewrite {
  if (!text.includes('html`')) return { text, sourceFile: null };
  if (!ts) return { text: text.replace(CLOSING_TAG, '</>'), sourceFile: null };

  const sf = createAppSourceFile(ts, fileName, text);
  const spans: Array<[number, number]> = [];
  const visit = (node: import('typescript').Node): void => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'html'
    ) {
      // Outermost only: an `html` nested in its `${}` is inside this span already.
      spans.push([node.template.getStart(sf), node.template.end]);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Back to front so earlier offsets stay valid as the text changes length.
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const [start, end] = spans[i];
    out = out.slice(0, start) + out.slice(start, end).replace(CLOSING_TAG, '</>') + out.slice(end);
  }
  return { text: out, sourceFile: out === text ? sf : null };
}
