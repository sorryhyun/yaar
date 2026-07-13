/**
 * Static guard for solid-js/html tagged templates.
 *
 * `solid-js/html` does not parse the template — it joins the static parts with a
 * `<!--#-->` comment marker, generates JS source text from the result, and hands
 * that text to `new Function(...)` on first instantiation. Its parser
 * (`lit-dom-expressions`' `parse()`) only ever appends text nodes from *inside* a
 * matched-tag callback, so **any top-level text before the first tag is silently
 * discarded**, and a template whose only surviving top-level node is the marker
 * generates `_$el = .firstChild` — a SyntaxError thrown from the Function
 * constructor, with no file, no line, and a broken stack.
 *
 * That single root cause produces three distinct symptoms, classified here.
 * Because the check runs on the same `statics` array the runtime sees, it has no
 * false positives from nested templates or multi-line markup.
 */

/** The comment marker solid substitutes for each `${...}` expression. */
const MARKER = '<!--#-->';

/**
 * The subset of solid's own `replaceList` normalization that can change which
 * node ends up first, or whether a node survives at all. Attribute-level rewrites
 * (`selfClosing`, `attrSeeker`) are omitted: they cannot turn a flagged template
 * into a safe one, or vice versa.
 */
function normalizeMarkup(markup: string): string {
  return markup
    .replace(/<(<!--#-->)/g, '<###') // `<${Comp}>` becomes a real tag
    .replace(/\.\.\.(<!--#-->)/g, '###') // `...${props}` spread
    .replace(/>\n+\s*/g, '>')
    .replace(/\n+\s*</g, '<')
    .replace(/\s+</g, ' <')
    .replace(/>\s+/g, '> ');
}

/** Matches a tag, a comment, or an expression marker — solid's `tagRE`. */
const TAG_RE = /(?:<!--[\S\s]*?-->|<(?:"[^"]*"['"]*|'[^']*'['"]*|[^'">])+>)/g;

export type SolidHtmlDefectKind = 'no-tag' | 'leading-text' | 'lone-expression';

export interface SolidHtmlDefect {
  kind: SolidHtmlDefectKind;
  /** What goes wrong at runtime. */
  problem: string;
  /** What the author should write instead. */
  fix: string;
}

/**
 * Classify a `html` template by its static parts (the `TemplateStringsArray`
 * contents, cooked). Returns `null` when the template is safe.
 */
export function classifyTemplate(statics: readonly string[]): SolidHtmlDefect | null {
  const markup = normalizeMarkup(statics.join(MARKER));

  const firstTag = markup.indexOf('<');
  if (firstTag === -1) {
    return {
      kind: 'no-tag',
      problem: 'template has no elements and no expressions, so solid parses it to zero nodes',
      fix: 'return a plain string, or wrap the content in an element',
    };
  }

  const leading = markup.slice(0, firstTag);
  if (leading.trim()) {
    return {
      kind: 'leading-text',
      problem: `top-level text ${JSON.stringify(leading.trim())} sits before the first tag and is silently dropped at render time`,
      fix: 'wrap the text in an element, e.g. html`<span>text ${x}</span>`',
    };
  }

  const tags = markup.match(TAG_RE) ?? [];
  const trailing = markup.slice(markup.lastIndexOf('>') + 1);
  const topLevelNodes = tags.length + (trailing.trim() ? 1 : 0);
  if (topLevelNodes === 1 && tags.length === 1 && tags[0] === MARKER) {
    return {
      kind: 'lone-expression',
      problem:
        'the only top-level node is the expression, so solid emits `.firstChild` with no parent and `new Function` throws a SyntaxError',
      // ASCII only: this reaches the user through Bun's plugin error path, which
      // mangles non-ASCII bytes (an em dash arrives as `â`).
      fix: 'return the accessor directly instead of wrapping it (`() => x` rather than html`${x}`), or give the template markup',
    };
  }

  return null;
}

export interface SolidHtmlFinding extends SolidHtmlDefect {
  line: number;
  column: number;
  snippet: string;
}

/** Minimal structural view of the `typescript` module this scanner needs. */
type TsModule = typeof import('typescript');

/**
 * Walk `source` for `` html`...` `` tagged templates and classify each one.
 *
 * Uses the TypeScript AST rather than a regex so nested templates and `${}`
 * expressions containing braces or backticks are handled exactly.
 */
export function scanSource(ts: TsModule, source: string, fileName: string): SolidHtmlFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: SolidHtmlFinding[] = [];

  const visit = (node: import('typescript').Node): void => {
    if (ts.isTaggedTemplateExpression(node) && node.tag.getText(sf) === 'html') {
      const tpl = node.template;
      const statics = ts.isNoSubstitutionTemplateLiteral(tpl)
        ? [tpl.text]
        : [tpl.head.text, ...tpl.templateSpans.map((s) => s.literal.text)];

      const defect = classifyTemplate(statics);
      if (defect) {
        const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        findings.push({
          ...defect,
          line: line + 1,
          column: character + 1,
          snippet: node.getText(sf).replace(/\s+/g, ' ').slice(0, 72),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return findings;
}

/** Render findings as a compile error body. */
export function formatFindings(fileName: string, findings: SolidHtmlFinding[]): string {
  const lines = findings.map(
    (f) =>
      `${fileName}:${f.line}:${f.column}: ${f.snippet}\n` +
      `  problem: ${f.problem}\n` +
      `  fix:     ${f.fix}`,
  );
  return `solid-js/html: ${findings.length} broken template${findings.length === 1 ? '' : 's'}\n\n${lines.join('\n\n')}`;
}
