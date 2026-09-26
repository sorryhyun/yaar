/**
 * `@yaar/lib` — the utilities YAAR uses that are not about YAAR.
 *
 * Everything here is bytes-in/bytes-out or process-shaped: a font subsetter, a PDF
 * rasterizer, an SSRF guard, a DPI-bypassing proxy, a tunnel driver, an id generator.
 * None of it knows what a session, a monitor, a window or an app is, and none of it
 * reads `config/` — see CLAUDE.md for the rule and why it is worth keeping.
 *
 * Subpath exports (`@yaar/lib/fonts`, `@yaar/lib/ssrf`, …) are the way in; this barrel
 * exists so that a consumer wanting several of them can say so once.
 */

export * from './errors.js';
export * from './ids.js';
export * from './image.js';
export * from './json-file.js';
export * from './open-url.js';
export * from './paths.js';
export * from './pick-directory.js';
export * from './process.js';
export * from './ssrf.js';
export * from './archive/index.js';
export * from './download/index.js';
export * from './fonts/index.js';
export * from './freedpi/index.js';
export * from './pdf/index.js';
export * from './termux/index.js';
export * from './tls/index.js';
export * from './tunnel/index.js';
export * from './ytdlp/index.js';
