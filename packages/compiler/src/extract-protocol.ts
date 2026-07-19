/**
 * Extract App Protocol manifest from TypeScript source — FALLBACK PATH.
 *
 * `extract-protocol-ast.ts` is the real extractor. This text scanner survives
 * for one reason: `typescript` is a devDependency and is absent in bundled-exe
 * mode, where a compile still has to produce *some* manifest.
 *
 * It is strictly less capable, and the gap is the point of the AST rewrite:
 * this parser sees one file, stops at the first spread, and drops a
 * `params`/`returns` block that contains a `+`-concatenated string. Those are
 * silent degradations, which is why it reports warnings and the caller
 * (`extract-protocol-dir.ts`) refuses to build on the blocking ones.
 *
 * Do not extend this to reach further. Reach belongs in the AST path.
 *
 * Parses the `register({...})` call using brace matching and regex extraction.
 * Works on human-written TypeScript (not minified code).
 *
 * Best-effort: returns null if extraction fails for any reason.
 */

import type { AppManifest } from '@yaar/shared';

type Protocol = Pick<AppManifest, 'state' | 'commands' | 'events'>;

export interface ProtocolExtraction {
  protocol: Protocol | null;
  /** Diagnostics from partial parses — see `stopWarning()` for the format. */
  warnings: string[];
}

/**
 * Find the matching closing brace for an opening brace at `start`.
 * Handles nested braces, string literals (single, double, template), and comments.
 * Returns the index of the closing brace, or -1 if not found.
 */
function findMatchingBrace(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    // Skip string literals
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i);
      if (i === -1) return -1;
      continue;
    }

    // Skip line comments
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }

    // Skip block comments
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i++; // skip past '/'
      continue;
    }

    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Skip past a string literal starting at `start`. Returns index of closing quote. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
      // Template literal interpolation — find matching }
      i = findMatchingBrace(source, i + 1);
      if (i === -1) return -1;
      continue;
    }
    if (source[i] === quote) return i;
  }
  return -1;
}

/**
 * Extract the content of a brace-delimited block starting at `start`.
 * `start` should point to the opening `{`.
 * Returns the inner content (without outer braces), or null.
 */
function extractBlock(source: string, start: number): string | null {
  if (source[start] !== '{') return null;
  const end = findMatchingBrace(source, start);
  if (end === -1) return null;
  return source.slice(start + 1, end);
}

/**
 * Find a top-level property in an object literal body.
 * Returns the value block content for `propName: { ... }`, or null.
 */
function findPropertyBlock(body: string, propName: string): string | null {
  // Match propName followed by : and {
  const pattern = new RegExp(`\\b${propName}\\s*:\\s*\\{`);
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;
  const braceStart = body.indexOf('{', match.index + propName.length);
  return extractBlock(body, braceStart);
}

/**
 * Extract a string value for a property like `description: 'some text'`.
 *
 * Descriptions routinely exceed the line limit and get written as adjacent
 * literals joined by `+`. Those are concatenated here — taking only the first
 * literal would silently truncate the text the agent reads. Concatenation stops
 * at the first non-literal operand (`'a' + name`), yielding the literal prefix.
 */
function extractStringProp(body: string, propName: string): string | null {
  const pattern = new RegExp(`\\b${propName}\\s*:\\s*(['"\`])`);
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;

  let pos = body.indexOf(match[1], match.index + propName.length);
  let out = '';
  for (;;) {
    const end = skipString(body, pos);
    if (end === -1) return out || null;
    out += body.slice(pos + 1, end);

    const next = body.slice(end + 1).match(/^\s*\+\s*(?=['"`])/);
    if (!next) return out;
    pos = end + 1 + next[0].length;
  }
}

/**
 * Extract a string array value for a property like `aliases: ['foo', 'bar']`.
 * Returns the parsed array, or null.
 */
function extractStringArrayProp(body: string, propName: string): string[] | null {
  const pattern = new RegExp(`\\b${propName}\\s*:\\s*\\[`);
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;
  const bracketStart = body.indexOf('[', match.index + propName.length);
  const end = findMatchingBrace(body, bracketStart);
  if (end === -1) return null;
  const raw = body.slice(bracketStart, end + 1);
  try {
    const parsed = JSON.parse(normalizeToJson(raw));
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize a JS object literal to valid JSON.
 * Handles single-quoted strings (including those containing double quotes),
 * line/block comments, trailing commas, and unquoted keys — all string-aware.
 */
function normalizeToJson(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // Skip line comments
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i === -1) break;
      continue;
    }
    // Skip block comments
    if (ch === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) break;
      i += 2;
      continue;
    }

    // Single-quoted string → double-quoted, escaping inner double quotes
    if (ch === "'") {
      out += '"';
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\\') {
          const escaped = src[i + 1];
          if (escaped === "'") out += "'";
          else if (escaped === '"') out += '\\"';
          else out += src[i] + escaped;
          i += 2;
          continue;
        }
        if (src[i] === '"') out += '\\"';
        else out += src[i];
        i++;
      }
      out += '"';
      i++; // skip closing '
      continue;
    }

    // Double-quoted string — pass through as-is
    if (ch === '"') {
      out += ch;
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          out += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        out += src[i];
        i++;
      }
      if (i < src.length) out += src[i++]; // closing "
      continue;
    }

    // Unquoted key before `:` — quote it
    if (/[a-zA-Z_$]/.test(ch)) {
      let word = '';
      while (i < src.length && /[\w$]/.test(src[i])) word += src[i++];
      // Check if this is a key (followed by `:`)
      const rest = src.slice(i).match(/^\s*:/);
      if (rest) {
        out += `"${word}"`;
      } else {
        out += word; // value like true/false/null
      }
      continue;
    }

    // Strip trailing commas before } or ]
    if (ch === ',') {
      const after = src.slice(i + 1).match(/^\s*([}\]])/);
      if (after) {
        i++;
        continue; // skip the comma
      }
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract a JSON-like object value for a property like `params: { type: 'object', ... }`.
 * Returns the parsed object, or null.
 */
function extractObjectProp(body: string, propName: string): object | null {
  const pattern = new RegExp(`\\b${propName}\\s*:\\s*\\{`);
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;
  const braceStart = body.indexOf('{', match.index + propName.length);
  const end = findMatchingBrace(body, braceStart);
  if (end === -1) return null;

  let raw = body.slice(braceStart, end + 1);
  // Clean up for JSON parsing: add quotes to unquoted keys, replace single quotes
  try {
    // Try direct JSON parse first
    return JSON.parse(raw);
  } catch {
    // Normalize to valid JSON using a string-aware approach
    raw = normalizeToJson(raw);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/** True when the property exists syntactically (`propName: {`), parseable or not. */
function hasObjectProp(body: string, propName: string): boolean {
  return new RegExp(`\\b${propName}\\s*:\\s*\\{`).test(body);
}

/**
 * Like extractObjectProp, but a block that is present yet unparseable pushes a
 * warning instead of vanishing — an agent reading the manifest would otherwise
 * see the command and have no idea its schema was dropped. The usual culprit is
 * a description built with `+` string concatenation inside the block.
 *
 * These warnings are entry-scoped (`` `commands.name`: ... ``), deliberately NOT
 * the `commands:` prefix `isBlockingProtocolWarning` matches: the entry itself
 * survives with its description, so this reports degradation without failing
 * builds (several shipped apps have such blocks today).
 */
function extractObjectPropChecked(
  body: string,
  propName: string,
  section: SectionName,
  entryName: string,
  warnings: string[],
): object | null {
  const value = extractObjectProp(body, propName);
  if (value === null && hasObjectProp(body, propName)) {
    warnings.push(
      `\`${section}.${entryName}\`: its \`${propName}\` block could not be parsed ` +
        `(often a string built with \`+\` concatenation inside it); the entry was kept ` +
        `but its \`${propName}\` was dropped from the manifest`,
    );
  }
  return value;
}

type SectionName = 'commands' | 'state' | 'events';

/** Clip text to a short single-line, printable-ASCII snippet for warning messages. */
function asciiSnippet(text: string, maxLen = 40): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen)
    .replace(/[^\x20-\x7e]/g, '?');
}

/**
 * Describe why parsing a section stopped mid-body. Warning messages start with
 * the section name (`commands: ...`) — `isBlockingProtocolWarning` relies on it.
 * ASCII only: compiler error paths mangle non-ASCII bytes.
 */
function stopWarning(section: SectionName, rest: string, parsedCount: number): string {
  const blocker = rest.startsWith('...')
    ? 'a `...` spread entry (not statically extractable)'
    : `an unparseable entry starting at \`${asciiSnippet(rest)}\``;
  const parsed = parsedCount === 1 ? '1 entry was parsed' : `${parsedCount} entries were parsed`;
  return (
    `${section}: parsing stopped at ${blocker}; ${parsed} before this point, ` +
    `and every entry after it was dropped from the manifest`
  );
}

/**
 * True when an extraction warning concerns `commands` or `state` — the manifest
 * content agents act on. `events` warnings are informational, as are the
 * entry-scoped `` `commands.name`: ... `` warnings for unparseable
 * params/schema/returns blocks (the entry itself survived).
 */
export function isBlockingProtocolWarning(warning: string): boolean {
  return warning.startsWith('commands:') || warning.startsWith('state:');
}

/**
 * Parse top-level keys from an object body, extracting each key's block.
 * Returns [keyName, blockContent] pairs for keys whose value is `{ ... }`.
 *
 * A single identifier call may wrap the literal — `navigate: defineCommand({ ... })`
 * — in which case the wrapper is stepped over and the inner block is returned.
 * The trailing `)` is consumed by the inter-key skip below.
 *
 * When the next non-skippable token is not a parseable `key: {` entry (a spread,
 * computed key, shorthand, or method shorthand), parsing stops and a warning is
 * pushed — everything after that point is invisible to the extractor.
 */
function parseTopLevelKeys(
  body: string,
  section: SectionName,
  warnings: string[],
): Array<[string, string]> {
  // Match key: { at the top level of the body
  // Supports bare identifiers (navigate) and quoted keys ('current-path', "select-file")
  const entries: Array<[string, string]> = [];
  let pos = 0;
  while (pos < body.length) {
    // Skip whitespace, commas, close parens (from a descriptor-builder call),
    // line comments, and block comments before the next key
    const skip = body.slice(pos).match(/^(?:\s|,|\)|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/);
    if (skip) pos += skip[0].length;
    if (pos >= body.length) break;

    // Optional `ident(` or `ident<T>(` between the colon and the opening brace.
    const keyMatch = body
      .slice(pos)
      .match(/^(?:(['"])([^'"]+)\1|(\w+))\s*:\s*(?:[A-Za-z_$][\w$]*\s*(?:<[^<>]*>\s*)?\(\s*)?\{/);
    if (!keyMatch || keyMatch.index === undefined) {
      warnings.push(stopWarning(section, body.slice(pos), entries.length));
      break;
    }

    const keyName = keyMatch[2] ?? keyMatch[3]; // quoted group or bare group
    const bracePos = pos + keyMatch.index + keyMatch[0].length - 1; // points to {
    const blockContent = extractBlock(body, bracePos);
    if (blockContent === null) {
      warnings.push(
        `${section}: parsing stopped at \`${keyName}\` because its braces never close; ` +
          `${entries.length} entries were parsed before this point, ` +
          `and every entry after it was dropped from the manifest`,
      );
      break;
    }

    entries.push([keyName, blockContent]);

    // Move past this block
    const endBrace = findMatchingBrace(body, bracePos);
    pos = endBrace + 1;
  }
  return entries;
}

/**
 * Extract app protocol from TypeScript source code, reporting where the parser
 * had to give up. `warnings` is non-empty when a section's body was only
 * partially parsed — the manifest then silently misses every entry after the
 * stop, which is exactly the failure mode callers should surface or refuse.
 */
export function extractProtocolWithDiagnostics(source: string): ProtocolExtraction {
  const warnings: string[] = [];
  try {
    // Find the register call: .register({ or register({
    const registerMatch = source.match(/\.register\s*\(\s*\{/);
    if (!registerMatch || registerMatch.index === undefined) {
      return { protocol: null, warnings };
    }

    // Find the opening brace of the config object
    const configStart = source.indexOf('{', registerMatch.index);
    const configBody = extractBlock(source, configStart);
    if (!configBody) return { protocol: null, warnings };

    // Extract state, commands, and events sections
    const stateBody = findPropertyBlock(configBody, 'state');
    const commandsBody = findPropertyBlock(configBody, 'commands');
    const eventsBody = findPropertyBlock(configBody, 'events');

    const protocol: Protocol = { state: {}, commands: {} };

    // Parse state descriptors
    if (stateBody) {
      for (const [key, block] of parseTopLevelKeys(stateBody, 'state', warnings)) {
        if (key === 'manifest') continue; // Built-in, skip
        const description = extractStringProp(block, 'description');
        if (description) {
          protocol.state[key] = { description };
          const schema = extractObjectPropChecked(block, 'schema', 'state', key, warnings);
          if (schema) protocol.state[key].schema = schema;
        }
      }
    }

    // Parse command descriptors
    if (commandsBody) {
      for (const [key, block] of parseTopLevelKeys(commandsBody, 'commands', warnings)) {
        const description = extractStringProp(block, 'description');
        if (description) {
          protocol.commands[key] = { description };
          const aliases = extractStringArrayProp(block, 'aliases');
          if (aliases) protocol.commands[key].aliases = aliases;
          const params = extractObjectPropChecked(block, 'params', 'commands', key, warnings);
          if (params) protocol.commands[key].params = params;
          const returns = extractObjectPropChecked(block, 'returns', 'commands', key, warnings);
          if (returns) protocol.commands[key].returns = returns;
        }
      }
    }

    // Parse event channel descriptors
    if (eventsBody) {
      const events: NonNullable<Protocol['events']> = {};
      for (const [key, block] of parseTopLevelKeys(eventsBody, 'events', warnings)) {
        const description = extractStringProp(block, 'description');
        if (description) events[key] = { description };
      }
      if (Object.keys(events).length > 0) protocol.events = events;
    }

    if (
      Object.keys(protocol.state).length === 0 &&
      Object.keys(protocol.commands).length === 0 &&
      !protocol.events
    ) {
      return { protocol: null, warnings };
    }

    return { protocol, warnings };
  } catch {
    return { protocol: null, warnings };
  }
}

/**
 * Extract app protocol from TypeScript source code.
 * Looks for `.register({...})` and extracts state/command descriptors.
 */
export function extractProtocolFromSource(source: string): Protocol | null {
  return extractProtocolWithDiagnostics(source).protocol;
}
