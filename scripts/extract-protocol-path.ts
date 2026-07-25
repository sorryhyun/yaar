/**
 * Print the extracted protocol manifest for an app at an arbitrary path.
 *
 * Usage: bun scripts/extract-protocol-path.ts <appDir>     # e.g. user-apps/word-lite
 *
 * `extract-protocol-cli.ts` resolves ids against `apps/` only; user-installed
 * apps live in the git-ignored `user-apps/` root, and porting them to
 * `defineApp` needs the same extract-before / extract-after diff as the bundled
 * ones. Same extraction pass, path instead of id.
 */

import { extractProtocolFromDir } from '../packages/compiler/src/extract-protocol-dir.ts';
import { formatProtocolError } from '../packages/compiler/src/extract-protocol-ast.ts';
import { isAbsolute, join, resolve } from 'node:path';

const appDir = process.argv[2];
if (!appDir) {
  console.error('usage: bun scripts/extract-protocol-path.ts <appDir>');
  process.exit(2);
}

const root = isAbsolute(appDir) ? appDir : resolve(import.meta.dir, '..', appDir);

// `bundles` is forwarded for the same reason `compile.ts` forwards it: a Zod
// `params` defers to the schema fold, and the fold builds a throwaway bundle
// that must resolve gated SDKs exactly as the app build did. Without it an app
// importing `@bundled/yaar-web` fails extraction on a gate it already passed —
// which reads as "this app cannot use Zod params" rather than "this tool forgot
// an argument".
const appJson = await Bun.file(join(root, 'app.json'))
  .json()
  .catch(() => ({}) as { bundles?: string[] });
const result = await extractProtocolFromDir(join(root, 'src'), { bundles: appJson.bundles });

if (result.errors.length > 0) {
  for (const err of result.errors) console.error(formatProtocolError(err));
  process.exit(1);
}
if (result.degraded)
  console.error('[warn] typescript unavailable — only defineApp apps can be extracted');

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

console.log(JSON.stringify(sortKeys(result.protocol), null, 2));
