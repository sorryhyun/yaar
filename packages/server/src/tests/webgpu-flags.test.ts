/**
 * The Linux WebGPU flag sets, and the line between them.
 *
 * Three launchers open a Chrome that YAAR's ML apps run in, and they disagreed: the
 * exe's launcher (`exe-entry.ts`) shipped with no GPU flags at all, so WebGPU worked
 * under `make claude-dev` and not under `yaar` — same machine, same GPU, same app.
 * Linux Chrome soft-blocklists the Vulkan backend WebGPU needs, so the flags are not
 * a tuning knob; without them there is no adapter.
 *
 * Two things are worth pinning. That the visible-window set stays a *subset* of the
 * headless one — they must not drift into two unrelated lists. And that it never
 * acquires `--disable-vulkan-surface`, which is the trap: it reads like a companion to
 * the other Vulkan flags, and it would disable the surface a visible window presents
 * through. `scripts/dev.sh` holds a bash copy this cannot reach; its comment carries
 * the pointer.
 */
import { describe, it, expect } from 'bun:test';
import { LINUX_WEBGPU_FLAGS, LINUX_WEBGPU_FLAGS_HEADLESS } from '../lib/browser/webgpu-flags.js';

describe('LINUX_WEBGPU_FLAGS', () => {
  it('turns WebGPU on and lifts the NVIDIA fp16 hold', () => {
    // The three dev.sh has passed all along, and the exe now passes too.
    expect(LINUX_WEBGPU_FLAGS).toEqual([
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--enable-dawn-features=vulkan_enable_f16_on_nvidia',
    ]);
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
