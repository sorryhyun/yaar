/**
 * The agent-facing description of a bundled library.
 *
 * `getBundledLibraryDetail(name, query)` answers "what can I import from
 * `@bundled/<name>`?" by slicing the relevant `declare module` blocks out of
 * `bundled-types/index.d.ts` and prepending the `Yaar*` declarations they
 * reference — or, for a library sectioned with `// ── Title ──` headers, an index
 * of it and then one export or section on request. It is text-slicing over a `.d.ts` — no bundler, no TypeScript
 * program — which is why it lives beside the registry rather than in `plugins.ts`.
 */

import { readFileSync } from 'fs';
import { BUNDLED_TYPES_DTS } from '../paths.js';
import { describeDesignTokens } from '../design-tokens.js';
import { BUNDLED_LIBRARIES, getAvailableBundledLibraries } from './registry.js';

// Lazily cached .d.ts content
let _dtsContent: string | null = null;

function loadDtsContent(): string {
  if (_dtsContent == null) {
    _dtsContent = readFileSync(BUNDLED_TYPES_DTS, 'utf-8');
  }
  return _dtsContent;
}

/**
 * Pseudo-libraries: describable, but not importable.
 *
 * The design tokens are injected as CSS, so they have no `@bundled/*` module and
 * no `.d.ts` block — yet an app agent has to be able to ask what they are. Before
 * this existed, the app prompt told agents to call
 * `describeBundledLibrary({ name: 'design-tokens' })`, which fell through to
 * `null`: the agent asked for the token list, got nothing, and invented plausible
 * names (`--yaar-space-2`) that silently render to nothing.
 */
const PSEUDO_LIBRARIES: Record<string, () => string> = {
  'design-tokens': describeDesignTokens,
};

/**
 * Everything `getBundledLibraryDetail` can answer for: the importable modules plus
 * the pseudo-libraries.
 *
 * The list an agent reads and the set it can actually ask about have to be the same
 * set, derived rather than maintained. `getAvailableBundledLibraries()` answers a
 * narrower question — what may appear in an `@bundled/*` import — and listing that
 * as if it were this one is what left `design-tokens` describable but unadvertised:
 * an agent looking only at the list had no way to know the call would work.
 */
export function getDescribableLibraries(): string[] {
  return [...getAvailableBundledLibraries(), ...Object.keys(PSEUDO_LIBRARIES)].sort();
}

/**
 * What slice of a library to describe. With none of these set, a library whose
 * declarations carry `// ── Title ──` section headers answers with its **index**
 * instead of the whole block; one without headers answers in full, as it always has.
 */
export interface LibraryDetailQuery {
  /** One export — every overload of it — plus the declarations it references. */
  symbol?: string;
  /** Every export under one section header (case-insensitive title match). */
  section?: string;
  /** The whole declaration, as before the index existed. */
  full?: boolean;
}

/**
 * Get type information for a bundled library.
 *
 * The full answer is the `declare module '@bundled/<name>…'` block(s) plus the
 * `Yaar*` declarations they reference. For `@bundled/yaar` that is ~65KB — the
 * largest single describe payload by far — and an agent asking how
 * `createSharedSignal` works does not need `rasterize`'s font options to find out.
 * So a sectioned library answers with an index (section → export → the first
 * sentence of its doc), and `symbol`/`section` pull one slice with exactly the
 * types that slice references.
 */
export function getBundledLibraryDetail(
  name: string,
  query: LibraryDetailQuery = {},
): string | null {
  const pseudo = PSEUDO_LIBRARIES[name];
  if (pseudo) return pseudo();

  if (!(name in BUNDLED_LIBRARIES) && !name.includes('/')) return null;

  const content = loadDtsContent();

  // Collect all `declare module '@bundled/<name>...'` blocks
  const modulePattern = new RegExp(
    `^declare module '@bundled/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/[^']*)?'\\s*\\{`,
    'gm',
  );
  const blocks: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = modulePattern.exec(content)) !== null) {
    blocks.push(sliceBraceBlock(content, match.index));
  }

  if (blocks.length === 0) return null;

  const sections = blocks.flatMap(parseSections);
  const sectioned = sections.some((s) => s.title !== null);
  if (query.full || (!sectioned && !query.symbol && !query.section)) {
    return fullDetail(content, blocks);
  }

  const library = `@bundled/${name}`;
  if (query.symbol) {
    const members = sections.flatMap((s) =>
      s.members.filter((m) => m.name === query.symbol).map((m) => ({ ...m, section: s.title })),
    );
    if (members.length === 0) {
      return `No export \`${query.symbol}\` in ${library}.\n\n${renderIndex(library, sections)}`;
    }
    const where = members[0].section ? ` — section "${members[0].section}"` : '';
    const body = members.map((m) => m.text).join('\n\n');
    return withReferences(`// ${library}${where}\n\n${body}`, body, sections, content);
  }
  if (query.section) {
    const want = query.section.toLowerCase();
    const hit =
      sections.find((s) => s.title?.toLowerCase() === want) ??
      sections.find((s) => s.title?.toLowerCase().includes(want));
    if (!hit) {
      return `No section matching "${query.section}" in ${library}.\n\n${renderIndex(library, sections)}`;
    }
    const prose = hit.prose.length
      ? `\n${hit.prose.map((l) => `// ${l}`.trimEnd()).join('\n')}`
      : '';
    const body = hit.members.map((m) => m.text).join('\n\n');
    return withReferences(
      `// ${library} — ${hit.title}${prose}\n\n${body}`,
      body,
      sections,
      content,
    );
  }
  return renderIndex(library, sections);
}

/** The whole answer: module blocks plus every `Yaar*` declaration they reach. */
function fullDetail(content: string, blocks: string[]): string {
  // Resolution is transitive and covers `type` aliases as well as `interface`es,
  // because a single `:`-anchored `interface`-only pass answered the question the
  // caller did not ask. The case that forced it was the old `app.register(config:
  // YaarAppRegistration)`: the reference sat behind `=` in an `export type
  // AppRegistration = ...` alias, so it pulled in nothing, and even reaching through
  // `YaarApp` never rescanned that body. An agent therefore saw a signature naming a
  // type with no body anywhere in the response, and had to discover the descriptor
  // shape by assigning `{}` and reading the compile error. `register()` is gone, but
  // `defineApp`'s `YaarAppDefinition` -> `YaarAppCommands` -> `YaarAppRunParams` chain
  // has the same depth.
  const preambles = resolveTopLevelRefs(content, blocks.join('\n\n'), new Set());
  const parts = preambles.length > 0 ? [...preambles, '', ...blocks] : blocks;
  return parts.join('\n\n');
}

/** Top-level `Yaar*` declarations reachable from `text`, transitively. */
function resolveTopLevelRefs(content: string, text: string, resolved: Set<string>): string[] {
  const out: string[] = [];
  let frontier = collectYaarRefs(text);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const name of frontier) {
      if (resolved.has(name)) continue;
      resolved.add(name);
      const decl = extractTypeDeclaration(content, name);
      if (!decl) continue;
      out.push(decl);
      next.push(...collectYaarRefs(decl));
    }
    frontier = next;
  }
  return out;
}

interface Member {
  name: string;
  kind: string;
  /** Doc comment plus declaration, dedented to column 0. */
  text: string;
  /** First sentence of the doc comment, or the declaration's first line. */
  summary: string;
}

interface Section {
  /** `null` for exports above the block's first header. */
  title: string | null;
  prose: string[];
  members: Member[];
}

const HEADER = /^ {2}\/\/ ── (.+?) ─*\s*$/;
const EXPORT =
  /^ {2}export (?:declare )?(?:async )?(function|const|let|class|type|interface|namespace|enum)\s+(\w+)/;
/** Listed as `types:` in the index; a class is a value you throw or construct, so it gets a bullet. */
const TYPE_KINDS = new Set(['type', 'interface', 'enum']);
/** Pulled in when a slice names them. */
const REF_KINDS = new Set(['type', 'interface', 'class', 'enum']);

/**
 * Split one `declare module` block into sections of exports. Only column-2 lines are
 * boundaries — a doc comment, an `export`, a `//` comment or a header — so a member's
 * nested body (`  };`, `  ): {`, deeper-indented lines) stays with it.
 */
function parseSections(block: string): Section[] {
  const lines = block.split('\n').slice(1, -1);
  const sections: Section[] = [{ title: null, prose: [], members: [] }];
  let pending: string[] = [];
  let current: { name: string; kind: string; lines: string[]; doc: string[] } | null = null;
  let inDoc = false;
  let proseOpen = false;

  const flush = () => {
    if (!current) return;
    while (current.lines.length && !current.lines[current.lines.length - 1].trim())
      current.lines.pop();
    const text = [...current.doc, ...current.lines].map((l) => l.replace(/^ {2}/, '')).join('\n');
    sections[sections.length - 1].members.push({
      name: current.name,
      kind: current.kind,
      text,
      summary: summarize(current.doc, current.lines),
    });
    current = null;
  };

  for (const line of lines) {
    if (inDoc) {
      pending.push(line);
      if (line.includes('*/')) inDoc = false;
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      flush();
      pending = [];
      sections.push({ title: header[1].trim(), prose: [], members: [] });
      proseOpen = true;
      continue;
    }
    if (/^ {2}\/\//.test(line)) {
      if (proseOpen && !current) {
        sections[sections.length - 1].prose.push(line.replace(/^ {2}\/\/ ?/, ''));
      } else {
        flush();
        pending.push(line);
      }
      continue;
    }
    proseOpen = false;
    if (/^ {2}\/\*\*/.test(line)) {
      flush();
      pending = [line];
      inDoc = !line.includes('*/');
      continue;
    }
    const exp = EXPORT.exec(line);
    if (exp) {
      flush();
      current = { name: exp[2], kind: exp[1], lines: [line], doc: pending };
      pending = [];
      continue;
    }
    if (/^ {2}export /.test(line)) {
      // `export default x;`, `export * from …` — nothing to index.
      flush();
      pending = [];
      continue;
    }
    if (current) current.lines.push(line);
  }
  flush();
  for (const s of sections) {
    while (s.prose.length && !s.prose[0].trim()) s.prose.shift();
    while (s.prose.length && !s.prose[s.prose.length - 1].trim()) s.prose.pop();
  }
  return sections.filter((s) => s.title !== null || s.members.length > 0);
}

/** The first sentence of a JSDoc block, or the collapsed declaration when there is none. */
function summarize(doc: string[], declaration: string[]): string {
  const prose = doc
    .filter((l) => !/^\s*\/\/\s/.test(l))
    .map((l) => l.replace(/^\s*(\/\*\*|\*\/|\*)\s?/, '').replace(/\*\/\s*$/, ''))
    .join('\n')
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const text = prose
    ? (/^(.+?[.!?])(\s|$)/.exec(prose)?.[1] ?? prose)
    : declaration
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^export (declare )?/, '')
        .replace(/;$/, '');
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function renderIndex(library: string, sections: Section[]): string {
  const count = new Set(sections.flatMap((s) => s.members.map((m) => m.name))).size;
  const titled = sections.filter((s) => s.title !== null).length;
  const out = [
    `${library} — ${count} exports in ${titled} sections. This is the index. Describe again ` +
      'with `symbol` for one export (with the types it references), `section` for a whole ' +
      'section, or `full: true` for everything.',
  ];
  for (const s of sections) {
    out.push('', `## ${s.title ?? '(top)'}`);
    if (s.prose.length) out.push(s.prose.join('\n'));
    const seen = new Set<string>();
    const types: string[] = [];
    for (const m of s.members) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      if (TYPE_KINDS.has(m.kind)) types.push(m.name);
      else out.push(`- \`${m.name}\` — ${m.summary}`);
    }
    if (types.length) out.push(`- types: ${types.map((t) => `\`${t}\``).join(', ')}`);
  }
  return out.join('\n');
}

/**
 * Append what `body` references: exported types declared in the same module
 * (`DialogOptions`, `KeyState`) and top-level `Yaar*` declarations, both
 * transitively, so a slice never names a type it does not show.
 */
function withReferences(head: string, body: string, sections: Section[], content: string): string {
  const local = new Map<string, string>();
  for (const s of sections) {
    for (const m of s.members) {
      if (REF_KINDS.has(m.kind))
        local.set(m.name, local.has(m.name) ? `${local.get(m.name)}\n\n${m.text}` : m.text);
    }
  }
  const included = new Set<string>();
  for (const m of body.matchAll(
    /^(?:export )?(?:declare )?(?:type|interface|class|enum)\s+(\w+)/gm,
  ))
    included.add(m[1]);
  const refs: string[] = [];
  let frontier = [body];
  while (frontier.length) {
    const next: string[] = [];
    for (const text of frontier) {
      for (const [, id] of text.matchAll(/\b([A-Z]\w*)\b/g)) {
        if (included.has(id) || !local.has(id)) continue;
        included.add(id);
        refs.push(local.get(id)!);
        next.push(local.get(id)!);
      }
    }
    frontier = next;
  }
  const topLevel = resolveTopLevelRefs(content, [body, ...refs].join('\n\n'), new Set(included));
  const all = [...refs, ...topLevel];
  return all.length ? `${head}\n\n// Referenced types\n\n${all.join('\n\n')}` : head;
}

/** Slice a brace-delimited declaration starting at `start`, balancing nesting. */
function sliceBraceBlock(content: string, start: number): string {
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return content.slice(start);
}

/** Every distinct `Yaar*` type name mentioned in a chunk of declaration text. */
function collectYaarRefs(text: string): string[] {
  const names = new Set<string>();
  const pattern = /\bYaar\w+/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) names.add(m[0]);
  return [...names];
}

/** Extract a top-level `interface X { ... }` or `type X = ...;` declaration. */
function extractTypeDeclaration(content: string, name: string): string | null {
  const ifaceStart = content.search(new RegExp(`^interface ${name}[\\s<{]`, 'm'));
  if (ifaceStart !== -1) return sliceBraceBlock(content, ifaceStart);

  const alias = new RegExp(`^type ${name}[\\s<=]`, 'm').exec(content);
  if (!alias) return null;
  // A type alias runs to the first `;` at brace depth 0 — object-literal and mapped
  // types nest braces, so the first `;` overall truncates mid-body.
  let depth = 0;
  for (let i = alias.index; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ';' && depth === 0) return content.slice(alias.index, i + 1);
  }
  return null;
}
