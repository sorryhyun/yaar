/**
 * A clone carries an app's binary assets intact.
 *
 * `Bun.file().text()` does not throw on binary — it decodes lossily. So cloning an
 * app with an image read the PNG as ~88k U+FFFD replacement characters, wrote that
 * to the devtools sandbox, and reported success; mascot's 216KB sprite arrived as
 * 390KB of garbage. Nothing failed until the app ran. These tests pin the two halves
 * of the fix: bytes that are not valid UTF-8 travel as base64 and survive the round
 * trip, and text files are untouched by it.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { cloneAppSource } from '../features/dev/clone.js';
import { USER_APPS_DIR } from '../features/apps/roots.js';

// cloneAppSource resolves an app by id through the real roots, so the fixture has to
// be a real app directory. user-apps/ is the git-ignored root, and the id is unique.
const APP_ID = 'clone-binary-fixture';
const appDir = join(USER_APPS_DIR, APP_ID);

/** A one-pixel PNG: real image bytes, and invalid UTF-8 in the header alone. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const MAIN_TS = 'export const greeting = "hello";\n';

async function writeFixture(): Promise<void> {
  await mkdir(join(appDir, 'src', 'assets'), { recursive: true });
  await writeFile(join(appDir, 'src', 'main.ts'), MAIN_TS);
  await writeFile(join(appDir, 'src', 'assets', 'sprite.png'), PNG_BYTES);
  await writeFile(join(appDir, 'app.json'), JSON.stringify({ name: 'Clone Fixture' }));
}

afterEach(async () => {
  await rm(appDir, { recursive: true, force: true });
});

describe('cloneAppSource with binary assets', () => {
  it('carries a PNG as base64, byte-for-byte', async () => {
    await writeFixture();
    const result = await cloneAppSource(APP_ID);
    expect(result.success).toBe(true);

    const png = result.files?.find((f) => f.path === 'src/assets/sprite.png');
    expect(png).toBeDefined();
    expect(png!.encoding).toBe('base64');
    // The round trip is the whole point: decoding must give back the original bytes.
    expect(Buffer.from(png!.content, 'base64').equals(PNG_BYTES)).toBe(true);
  });

  it('leaves text files as plain UTF-8', async () => {
    await writeFixture();
    const result = await cloneAppSource(APP_ID);

    const main = result.files?.find((f) => f.path === 'src/main.ts');
    expect(main).toBeDefined();
    expect(main!.encoding).toBeUndefined();
    expect(main!.content).toBe(MAIN_TS);
  });

  it('does not silently lose the asset to a lossy decode', async () => {
    await writeFixture();
    const result = await cloneAppSource(APP_ID);

    const png = result.files?.find((f) => f.path === 'src/assets/sprite.png');
    // What the old path produced: a string that re-encodes to a different byte count.
    const asWritten = Buffer.from(png!.content, png!.encoding === 'base64' ? 'base64' : 'utf-8');
    expect(asWritten.byteLength).toBe(PNG_BYTES.byteLength);
    expect(png!.content).not.toContain('�');
  });
});
