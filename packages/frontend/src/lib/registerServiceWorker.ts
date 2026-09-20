/**
 * Install (or remove) the shell service worker.
 *
 * `public/sw.js` has the reasoning for why the shell is cached at all. This half is
 * about the two ways it can go wrong on the device that needs it most.
 *
 * **It may simply not be available.** A service worker needs a secure context, and the
 * common way to reach YAAR from a phone on the same network is `http://192.168.x.x:8000`,
 * which is not one. There `navigator.serviceWorker` is undefined and the desktop must
 * behave exactly as it always has — so this is a best-effort call that returns quietly,
 * never a step the app waits on. Remote mode over Tailscale Serve is HTTPS and does get
 * it, as does `localhost`.
 *
 * **It may be the thing that is broken.** A worker that caches a bad shell keeps serving
 * it, and the usual fix — clear this site's data — is a long way into a phone's settings
 * for someone who just wants their desktop back. `?nosw` is the way out: load YAAR once
 * with it and the worker unregisters itself and empties its caches, from the same URL bar
 * the user is already in.
 */

/** Load YAAR with this in the query string to tear the worker back out. */
const OPT_OUT_PARAM = 'nosw';

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    if (new URLSearchParams(window.location.search).has(OPT_OUT_PARAM)) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((n) => caches.delete(n)));
      }
      console.info('[sw] unregistered and caches cleared (?nosw)');
      return;
    }

    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (err) {
    // Nothing here is load-bearing — a desktop without a cached shell is the desktop
    // as it has always been. Say so and carry on.
    console.warn('[sw] registration failed; continuing without a cached shell', err);
  }
}
