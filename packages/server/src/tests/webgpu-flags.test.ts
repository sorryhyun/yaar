/**
 * The Linux WebGPU flag sets, and the line between them.
 *
 * Three launchers open a Chrome that YAAR's ML apps run in, and they disagreed: the
 * exe's launcher (`exe-entry.ts`) shipped with no GPU flags at all, so WebGPU worked
 * under `make claude-dev` and not under `yaar` — same machine, same GPU, same app.
 * Linux Chrome soft-blocklists the Vulkan backend WebGPU needs, so the flags are not
 * a tuning knob; without them there is no adapter.
 *
 * Three things are worth pinning. That the visible-window set stays a *subset* of the
 * headless one — they must not drift into two unrelated lists. That it never acquires
 * `--disable-vulkan-surface`, which is the trap: it reads like a companion to the other
 * Vulkan flags, and it would disable the surface a visible window presents through. And
 * that `--enable-unsafe-webgpu` stays out: it reads like *the* WebGPU flag and was in this
 * list for a while, but all it earns is Chrome's "unsupported command-line flag" infobar in
 * the user's face — no adapter and no shader-f16 that the flags below don't already give.
 * `scripts/dev/start.sh` holds a bash copy this cannot reach; its comment carries the
 * pointer.
 */
import { describe, it, expect } from 'bun:test';
import { LINUX_WEBGPU_FLAGS, LINUX_WEBGPU_FLAGS_HEADLESS } from '../lib/browser/webgpu-flags.js';

describe('LINUX_WEBGPU_FLAGS', () => {
  it('turns WebGPU on and lifts the NVIDIA fp16 hold', () => {
    // What dev/start.sh passes, and what the exe passes too.
    expect(LINUX_WEBGPU_FLAGS).toEqual([
      '--enable-features=Vulkan',
      '--enable-dawn-features=vulkan_enable_f16_on_nvidia',
    ]);
  });

  it('never carries the flag that makes Chrome warn the user', () => {
    // --enable-unsafe-webgpu is on Chrome's kBadFlags list, so it shows the
    // "unsupported command-line flag ... stability and security will suffer"
    // infobar on every launch. Measured on Chrome 149: passing it changes
    // neither the adapter nor its feature set, visible or headless. Ridding the
    // user of that bar is the whole reason it is gone; don't put it back.
    for (const set of [LINUX_WEBGPU_FLAGS, LINUX_WEBGPU_FLAGS_HEADLESS]) {
      expect(set).not.toContain('--enable-unsafe-webgpu');
    }
  });

  it('never carries the headless-only surface flags into a visible window', () => {
    expect(LINUX_WEBGPU_FLAGS).not.toContain('--disable-vulkan-surface');
    expect(LINUX_WEBGPU_FLAGS).not.toContain('--use-angle=vulkan');
  });

  it('is what the headless set builds on, not a separate list', () => {
    for (const flag of LINUX_WEBGPU_FLAGS) {
      expect(LINUX_WEBGPU_FLAGS_HEADLESS).toContain(flag);
    }
    expect(LINUX_WEBGPU_FLAGS_HEADLESS).toContain('--use-angle=vulkan');
    expect(LINUX_WEBGPU_FLAGS_HEADLESS).toContain('--disable-vulkan-surface');
  });
});
