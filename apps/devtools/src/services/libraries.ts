export {};
import { bundledLibraries } from '@bundled/yaar-dev';
import { setBundledLibs } from '../core';

export async function loadBundledLibraries(): Promise<void> {
  try {
    const libs = await bundledLibraries();
    setBundledLibs(libs);
  } catch {
    /* non-fatal */
  }
}
