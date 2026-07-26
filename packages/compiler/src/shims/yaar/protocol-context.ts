// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Runtime context for statically-declared command handlers.
 *
 * The protocol extractor reads descriptor maps out of the source text, so a map
 * has to be a top-level `const` — it cannot close over a parameter, and it
 * cannot be produced by a factory (`buildCommands(ctx)` is a call result, which
 * the extractor refuses by design). But handlers legitimately need something
 * supplied at registration time: a controller, a set of signal accessors, a
 * store.
 *
 * This is the seam between those two facts. The descriptor map stays static;
 * the context arrives later and handlers reach it through the accessor.
 */

/**
 * Create a set-once holder for the context a protocol's handlers need.
 *
 * Two failure modes are made loud rather than silent, because both otherwise
 * produce handlers that run against the wrong state and report nothing:
 *
 * - **Read before set** throws instead of returning `undefined`, which would
 *   surface later as an unrelated `TypeError` inside a handler.
 * - **Set twice with a different context** throws. The holder is module state,
 *   so a second registration would silently retarget the *first*
 *   registration's handlers. An app that genuinely needs two live contexts in
 *   one document needs a different design, not a quietly shared one.
 */
export function createProtocolContext(label) {
  let current = null;
  let isSet = false;

  return {
    set(value) {
      if (isSet && current !== value) {
        throw new Error(
          `${label}: protocol context set twice with different values. ` +
            `Handlers declared at module scope share one context, so the second ` +
            `registration would retarget the first one's handlers.`,
        );
      }
      current = value;
      isSet = true;
    },
    get() {
      if (!isSet) {
        throw new Error(
          `${label}: protocol context read before it was set. ` +
            `Call the setter at module scope, before defineApp().`,
        );
      }
      return current;
    },
  };
}
