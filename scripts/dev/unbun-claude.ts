/**
 * Extract the JS module graph from a `bun build --compile` executable — the `claude`
 * binary in `@anthropic-ai/claude-agent-sdk-linux-*` — into a plain directory a regular
 * `bun` can run.
 *
 * This is how Claude Code gets onto Android: the SDK ships glibc and musl builds only,
 * and Android's linker refuses both, but the chunks inside are stored as source next to
 * their bytecode, so the Android build of Bun runs them fine. `start-termux.sh` drives it.
 *
 * Usage:
 *   bun scripts/dev/unbun-claude.ts <path/to/claude> <outDir>
 *   bun <outDir>/cli.js --version
 *
 * Layout (Bun 1.4.x StandaloneModuleGraph): [graph bytes][Offsets: u64 byteCount,
 * u32 modulesOff, u32 modulesLen, u32 entryId, u32 argvOff, u32 argvLen, u32 flags]
 * ["\n---- Bun! ----\n"]. Each module record is 13 u32s: name, contents, sourcemap,
 * bytecode, moduleInfo, bytecodeOriginPath (offset,len pairs), then packed flags. The
 * format is Bun-internal, so a record-size mismatch is refused rather than guessed at.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const [bin, outArg] = process.argv.slice(2);
if (!bin || !outArg) throw new Error('usage: bun unbun-claude.ts <claude-binary> <outDir>');
const out = resolve(outArg);

const buf = readFileSync(bin);
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const trailer = buf.lastIndexOf(Buffer.from('\n---- Bun! ----\n'));
if (trailer < 0) throw new Error('no Bun module graph trailer found');

const o = trailer - 32;
const byteCount = Number(view.getBigUint64(o, true));
const modulesOff = view.getUint32(o + 8, true);
const modulesLen = view.getUint32(o + 12, true);
const entryId = view.getUint32(o + 16, true);
const base = o - byteCount;
const RECORD = 52;
if (modulesLen % RECORD) {
  throw new Error(
    `module table length ${modulesLen} is not a multiple of ${RECORD} — graph format changed`,
  );
}

const slice = (off: number, len: number) => buf.subarray(base + off, base + off + len);
const PREFIX = '/$bunfs/root/';
const TEXT = /\.(m?js|cjs)$|^cli$/;

let entry = '';
const count = modulesLen / RECORD;
for (let i = 0; i < count; i++) {
  const r = base + modulesOff + i * RECORD;
  const u = (k: number) => view.getUint32(r + k * 4, true);
  const name = slice(u(0), u(1)).toString('utf8');
  const rel = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name.replace(/^\/+/, '');
  let body: Buffer | string = slice(u(2), u(3));
  // Chunks import each other by absolute /$bunfs/root/ path; point them at the extraction dir.
  if (TEXT.test(rel)) body = body.toString('utf8').replaceAll(PREFIX, out + '/');
  const dest = join(out, rel === 'cli' ? 'cli.js' : rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  if (i === entryId) entry = dest;
}
// Some code resolves its own entry as "<root>/cli"; keep both names.
writeFileSync(join(out, 'cli'), readFileSync(entry));
console.log(`extracted ${count} modules → ${out}\nentry: ${entry}`);
