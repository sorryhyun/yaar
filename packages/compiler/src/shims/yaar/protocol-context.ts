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
 * ```ts
 * // src/protocol/context.ts
 * export const { set: setProtocolContext, get: ctx } =
 *   createProtocolContext<ProtocolContext>('slides-lite');
 *
 * // src/protocol/deck.ts — descriptors stay statically readable
 * export const deckCommands = {
 *   setDeck: defineCommand({
 *     description: 'Replace the whole deck',
 *     params: { ... },
 *     handler: (p) => ctx().setDeck(p.deck),
 *   }),
 * };
 *
 * // src/protocol.ts
 * export function registerProtocol(context: ProtocolContext) {
 *   setProtocolContext(context);
 *   app.register({ commands: { ...deckCommands } });
 * }
 * ```
 *
 * `label` names the app and appears in both error messages.
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
 *
 * Re-setting the identical context is allowed and is a no-op.
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
            `Call the setter at the top of registerProtocol(), before app.register().`,
        );
      }
      return current;
    },
  };
}
