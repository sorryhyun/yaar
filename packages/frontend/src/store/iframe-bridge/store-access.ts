/**
 * The one module in `iframe-bridge/` that knows about `desktop.ts`.
 *
 * The bridge and the store are mutually recursive: `desktop.ts` calls into the bridge to
 * capture windows and install handlers, and the bridge reads/writes store state to answer
 * server requests. That cycle is safe only because nothing is dereferenced at module-eval
 * time — `useDesktopStore` is a live ESM binding, read on the first *call*, long after both
 * modules have finished loading.
 *
 * Keeping the import here means that fragile property belongs to one file instead of seven.
 * Child modules take the store through these accessors and never import `desktop.ts`
 * themselves, so no future edit to `capture.ts` or `windows-sdk.ts` can widen the cycle.
 */
import { useDesktopStore } from '../desktop';

/** Current store state. Never call at module scope — see the file header. */
export function getDesktopState() {
  return useDesktopStore.getState();
}

/** The store itself, for the one consumer that needs `subscribe` (notification broadcast). */
export function getDesktopStore() {
  return useDesktopStore;
}
