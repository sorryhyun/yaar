/**
 * Extract App Protocol manifest from TypeScript source.
 *
 * Parses the `register({...})` call in app source code using brace matching
 * and regex extraction. Works on human-written TypeScript (not minified code).
 *
 * Best-effort: returns null if extraction fails for any reason.
 */

import type { AppManifest } from '@yaar/shared';

type Protocol = Pick<AppManifest, 'state' | 'commands'>;

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
 */
function extractStringProp(body: string, propName: string): string | null {
  const pattern = new RegExp(`\\b${propName}\\s*:\\s*(['"\`])`);
  const match = body.match(pattern);
  if (!match || match.index === undefined) return null;
  const quote = match[1];
  const strStart = body.indexOf(quote, match.index + propName.length);
  const strEnd = skipString(body, strStart);
  if (strEnd === -1) return null;
  return body.slice(strStart + 1, strEnd);
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
    // Normalize to valid JSON: quote unquoted keys, replace single quotes
    raw = raw
      .replace(/\/\/[^\n]*/g, '') // strip line comments
      .replace(/,\s*([}\]])/g, '$1') // strip trailing commas
      .replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":') // quote unquoted keys
      .replace(/'/g, '"'); // single → double quotes
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

/**
 * Parse top-level keys from an object body, extracting each key's block.
 * Yields [keyName, blockContent] pairs for keys whose value is `{ ... }`.
 */
function* iterateTopLevelKeys(body: string): Generator<[string, string]> {
  // Match key: { at the top level of the body
  let pos = 0;
  while (pos < body.length) {
    // Skip whitespace and commas
    const keyMatch = body.slice(pos).match(/^\s*,?\s*(\w+)\s*:\s*\{/);
    if (!keyMatch || keyMatch.index === undefined) break;

    const keyName = keyMatch[1];
    const bracePos = pos + keyMatch.index + keyMatch[0].length - 1; // points to {
    const blockContent = extractBlock(body, bracePos);
    if (blockContent === null) break;

    yield [keyName, blockContent];

    // Move past this block
    const endBrace = findMatchingBrace(body, bracePos);
    pos = endBrace + 1;
  }
}

/**
 * Extract app protocol from TypeScript source code.
 * Looks for `.register({...})` and extracts state/command descriptors.
 */
export function extractProtocolFromSource(source: string): Protocol | null {
  try {
    // Find the register call: .register({ or register({
    const registerMatch = source.match(/\.register\s*\(\s*\{/);
    if (!registerMatch || registerMatch.index === undefined) return null;

    // Find the opening brace of the config object
    const configStart = source.indexOf('{', registerMatch.index);
    const configBody = extractBlock(source, configStart);
    if (!configBody) return null;

    // Extract state and commands sections
    const stateBody = findPropertyBlock(configBody, 'state');
    const commandsBody = findPropertyBlock(configBody, 'commands');

    const protocol: Protocol = { state: {}, commands: {} };

    // Parse state descriptors
    if (stateBody) {
      for (const [key, block] of iterateTopLevelKeys(stateBody)) {
        if (key === 'manifest') continue; // Built-in, skip
        const description = extractStringProp(block, 'description');
        if (description) {
          protocol.state[key] = { description };
          const schema = extractObjectProp(block, 'schema');
          if (schema) protocol.state[key].schema = schema;
        }
      }
    }

    // Parse command descriptors
    if (commandsBody) {
      for (const [key, block] of iterateTopLevelKeys(commandsBody)) {
        const description = extractStringProp(block, 'description');
        if (description) {
          protocol.commands[key] = { description };
          const params = extractObjectProp(block, 'params');
          if (params) protocol.commands[key].params = params;
          const returns = extractObjectProp(block, 'returns');
          if (returns) protocol.commands[key].returns = returns;
        }
      }
    }

    if (Object.keys(protocol.state).length === 0 && Object.keys(protocol.commands).length === 0) {
      return null;
    }

    return protocol;
  } catch {
    return null;
  }
}
