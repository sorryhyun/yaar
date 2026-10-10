/**
 * The two places a YAAR.app is assembled must write the same Info.plist.
 *
 * `scripts/build/exe-bundle.js` builds `dist/YAAR.app` on a Mac; `install.sh` assembles
 * the installed one on the user's Mac, because the release is built on Linux, where
 * `codesign`, `sips` and `iconutil` do not exist. install.sh is piped into bash from a
 * URL, so it cannot share a template file with the build — it carries its own copy.
 *
 * The keys are not decoration. Without NSMicrophoneUsageDescription, WKWebView hides
 * `navigator.mediaDevices` from every frame and no app can record; without
 * NSCameraUsageDescription, a camera request is refused with no macOS prompt; the bundle id is what
 * macOS files the microphone grant under, so the two copies disagreeing would mean a
 * grant given to a dev build does not carry over. Only the templated values (executable
 * name, version) may differ in spelling.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** key → value (`true` for `<true/>`), with any `${…}` template reduced to `*`. */
function plistEntries(source: string): Map<string, string> {
  const entries = new Map<string, string>();
  const re = /<key>([^<]+)<\/key>\s*(?:<string>([^<]*)<\/string>|<(true|false)\/>)/g;
  for (const m of source.matchAll(re)) {
    const value = m[2] !== undefined ? m[2].replace(/\$\{[^}]+\}/g, '*') : m[3];
    entries.set(m[1], value);
  }
  return entries;
}

describe('YAAR.app Info.plist', () => {
  const build = plistEntries(readFileSync(join(ROOT, 'scripts', 'build', 'exe-bundle.js'), 'utf8'));
  const install = plistEntries(readFileSync(join(ROOT, 'install.sh'), 'utf8'));

  it('is the same in the build script and the installer', () => {
    expect(Object.fromEntries(install)).toEqual(Object.fromEntries(build));
  });

  it('asks for the microphone, which is what exposes mediaDevices to the window', () => {
    expect(build.get('NSMicrophoneUsageDescription')).toBeTruthy();
    expect(build.get('CFBundleIdentifier')).toBe('io.github.sorryhyun.yaar');
  });

  it('asks for the camera, without which WebKit refuses video capture before macOS is asked', () => {
    expect(build.get('NSCameraUsageDescription')).toBeTruthy();
  });
});
