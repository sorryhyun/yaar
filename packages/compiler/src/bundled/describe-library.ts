/**
 * The agent-facing description of a bundled library.
 *
 * `getBundledLibraryDetail(name)` answers "what can I import from
 * `@bundled/<name>`?" by slicing the relevant `declare module` blocks out of
 * `bundled-types/index.d.ts` and prepending the `Yaar*` declarations they
 * reference. It is text-slicing over a `.d.ts` — no bundler, no TypeScript
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
 * Get detailed type information for a specific bundled library.
 * Extracts the `declare module '@bundled/...'` block(s) from the .d.ts file,
 * plus any preceding interface/type declarations that the module references.
 */
export function getBundledLibraryDetail(name: string): string | null {
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

  // For yaar/yaar-dev/yaar-web, also include the declarations they reference.
  //
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
  const preambles: string[] = [];
  const resolved = new Set<string>();
  let frontier = collectYaarRefs(blocks.join('\n\n'));
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const name of frontier) {
      if (resolved.has(name)) continue;
      resolved.add(name);
      const decl = extractTypeDeclaration(content, name);
      if (!decl) continue;
      preambles.push(decl);
      next.push(...collectYaarRefs(decl));
    }
    frontier = next;
  }

  const parts = preambles.length > 0 ? [...preambles, '', ...blocks] : blocks;
  return parts.join('\n\n');
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
