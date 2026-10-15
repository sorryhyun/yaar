export {};

// Agents write search regexes in the PCRE / ripgrep dialect, where a leading `(?i)` sets a
// flag for the whole pattern. JavaScript has no such group, so `new RegExp('(?i)foo')` throws.
// A leading group of the flags JavaScript has (i, m, s) becomes RegExp flags; everything else
// after `(?` is left to the engine, so lookarounds and the scoped `(?i:…)` keep their meaning.
// Same rule as the server's `compilePattern` (packages/server/src/lib/regex-pattern.ts).

const LEADING_FLAGS = /^\(\?([a-zA-Z]+)\)/;
const SUPPORTED_FLAGS = new Set(['i', 'm', 's']);

/** Compile a caller's search pattern; throws with a message naming the fix. */
export function compileSearchPattern(pattern: string): RegExp {
  const inline = LEADING_FLAGS.exec(pattern);
  if (!inline) return new RegExp(pattern);
  const letters = [...new Set(inline[1])];
  const unsupported = letters.filter((f) => !SUPPORTED_FLAGS.has(f));
  if (unsupported.length > 0) {
    throw new Error(
      `Inline flag${unsupported.length > 1 ? 's' : ''} "${unsupported.join('')}" in ` +
        `"${inline[0]}" not supported; a leading group may only combine i, m and s ` +
        '(e.g. "(?i)foo").',
    );
  }
  return new RegExp(pattern.slice(inline[0].length), letters.join(''));
}
