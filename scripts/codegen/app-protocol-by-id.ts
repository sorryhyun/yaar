/**
 * Print an app's extracted protocol manifest to stdout as sorted JSON.
 *
 * Usage: bun scripts/codegen/app-protocol-by-id.ts <appId>
 *
 * This is the same extraction pass the compiler runs, without the bundle step —
 * it is the fast acceptance test for protocol refactors: extract before, move
 * descriptors, extract after, diff.
 */

import {
  extractProtocolFromDir,
  formatProtocolError,
} from '../../packages/compiler/src/index.ts';
import { join } from 'node:path';

const appId = process.argv[2];
if (!appId) {
  console.error('usage: bun scripts/codegen/app-protocol-by-id.ts <appId>');
  process.exit(2);
}

const appRoot = join(import.meta.dir, '..', '..', 'apps', appId);

// Forwarded for the same reason `compile.ts` forwards it: a Zod `params` defers
// to the schema fold, and the fold builds a throwaway bundle that must resolve
// gated SDKs exactly as the app build did. Omitted, this tool refuses any app
// importing `@bundled/yaar-dev`/`-web`/`-ml` on a gate it already passed — and
// since this is the acceptance test for protocol refactors, that reads as "this
// app cannot use Zod params" rather than "this tool forgot an argument".
const appJson = await Bun.file(join(appRoot, 'app.json'))
  .json()
  .catch(() => ({}) as { bundles?: string[] });
const result = await extractProtocolFromDir(join(appRoot, 'src'), { bundles: appJson.bundles });

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
