/**
 * Chrome command-line flags that make WebGPU usable on Linux.
 *
 * WebGPU is off by default in Linux Chrome — it needs the Vulkan backend, which is
 * soft-blocklisted there — so `@bundled/yaar-ml` gets "Failed to get GPU adapter" and
 * falls back to (much slower) single-thread wasm, or fails outright. Windows and macOS
 * enable WebGPU by default and need none of this.
 *
 * `vulkan_enable_f16_on_nvidia`: Dawn withholds shader-f16 on every NVIDIA Vulkan
 * adapter pending CTS failures (crbug.com/42251215), even where the driver advertises
 * full fp16 support — which is why fp16 models run on Windows (D3D12) and macOS (Metal)
 * but not here. The toggle lifts that hold and is consulted only for NVIDIA, so it is a
 * no-op elsewhere. Dawn toggles have no `chrome://flags` entry, so the command line is
 * the only way to set it.
 *
 * Every launcher that opens a *visible* Chrome for a human to use YAAR in wants exactly
 * this set, and there are three of them (`scripts/dev.sh`, `exe-entry.ts`, and the
 * headless pool in `chrome.ts`, which adds its own).
 *
 * `scripts/dev.sh` is bash and cannot import this; it keeps its own copy. Change one,
 * change both.
 */
export const LINUX_WEBGPU_FLAGS = [
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--enable-dawn-features=vulkan_enable_f16_on_nvidia',
];

/**
 * The above, plus what only a *headless* Chrome wants.
 *
 * `--use-angle=vulkan` and `--disable-vulkan-surface` belong to the offscreen pool: the
 * surface flag disables the very thing a visible window presents through, so a launcher
 * that opens a real window must not borrow them. This is why the two sets are named
 * separately rather than one being spread into the other by default.
 */
export const LINUX_WEBGPU_FLAGS_HEADLESS = [
  ...LINUX_WEBGPU_FLAGS,
  '--use-angle=vulkan',
  '--disable-vulkan-surface',
];
