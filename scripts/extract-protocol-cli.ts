/**
 * Print an app's extracted protocol manifest to stdout as sorted JSON.
 *
 * Usage: bun scripts/extract-protocol-cli.ts <appId>
 *
 * This is the same extraction pass the compiler runs, without the bundle step —
 * it is the fast acceptance test for protocol refactors: extract before, move
 * descriptors, extract after, diff.
 */

import { extractProtocolFromDir } from '../packages/compiler/src/extract-protocol-dir.ts';
import { formatProtocolError } from '../packages/compiler/src/extract-protocol-ast.ts';
import { join } from 'node:path';

const appId = process.argv[2];
if (!appId) {
  console.error('usage: bun scripts/extract-protocol-cli.ts <appId>');
  process.exit(2);
}

const srcDir = join(import.meta.dir, '..', 'apps', appId, 'src');
const result = await extractProtocolFromDir(srcDir);

if (result.errors.length > 0) {
  for (const err of result.errors) console.error(formatProtocolError(err));
  process.exit(1);
}
if (result.degraded) console.error('[warn] typescript unavailable — text scanner used');

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
