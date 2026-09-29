/**
 * Regenerates the Android APK's `window.yaarHost` adapter from the generator the desktop
 * window uses, so the two hosts cannot drift.
 *
 *   bun scripts/codegen/android-host-script.ts
 *
 * Emits `hosts/android/app/src/main/assets/yaar-host.js`. A server test asserts the
 * checked-in file matches `androidHostScript()`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { androidHostScript } from '../../packages/server/src/desktop-window/host-bridge.ts';

const target = join(import.meta.dir, '../../hosts/android/app/src/main/assets/yaar-host.js');
writeFileSync(target, androidHostScript());
console.log(`wrote ${target}`);
