/**
 * Compile a caller's search pattern (a grep, a `read { pattern }`, an in-browser search).
 *
 * Agents write regexes in the PCRE / ripgrep / Python dialect, where a leading
 * `(?i)` turns on case-insensitivity for the whole pattern. JavaScript has no such
 * global-flag group (only the scoped `(?i:…)` modifier), so `new RegExp('(?i)foo')`
 * threw "unrecognized character after (?" and the search failed outright.
 *
 * A leading group of flags JavaScript supports — `i`, `m`, `s` — is lifted off the
 * pattern and passed as RegExp flags. Anything else after `(?` is left to the engine,
 * so lookarounds, named groups and `(?i:…)` keep their meaning; an unsupported inline
 * flag (`(?x)`) gets an error naming the flags that do work.
 *
 * Pure and dependency-free on purpose: the server imports it, and the `@bundled/yaar-dev`
 * shim bundles it into the browser so an app's search follows the same rule.
 */

const LEADING_FLAGS = /^\(\?([a-zA-Z]+)\)/;
const SUPPORTED_FLAGS = new Set(['i', 'm', 's']);

export type CompiledPattern = { regex: RegExp } | { error: string };

export function compilePattern(pattern: string): CompiledPattern {
  let source = pattern;
  let flags = '';
  const inline = LEADING_FLAGS.exec(pattern);
  if (inline) {
    const letters = [...new Set(inline[1])];
    const unsupported = letters.filter((f) => !SUPPORTED_FLAGS.has(f));
    if (unsupported.length > 0) {
      return {
        error:
          `Inline flag${unsupported.length > 1 ? 's' : ''} "${unsupported.join('')}" in ` +
          `"${inline[0]}" not supported; a leading group may only combine i, m and s ` +
          '(e.g. "(?i)foo").',
      };
    }
    source = pattern.slice(inline[0].length);
    flags = letters.join('');
  }
  try {
    return { regex: new RegExp(source, flags) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid regex' };
  }
}
