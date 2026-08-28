// Boundary schema for the browser session's SSE stream.
//
// `/api/browser/:id/events` is served by YAAR's own origin, but it still crosses
// a boundary: the frames arrive as opaque text over an EventSource, are produced
// by a server that ships independently of this app, and drive both the URL bar
// and the screenshot refresh. Validating the frame is what lets a *malformed*
// event be logged and skipped instead of quietly writing `undefined` into the
// URL bar or defeating the `version` de-duplication.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.looseObject({...})`, `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB;
// standard Zod would add ~260KB.
import * as z from '@bundled/zod';

// The server sends `{ url, title, version, driving?, isSelf }` on connect and on
// every update (packages/server/src/http/routes/browser.ts). `version` is required
// because it is the de-duplication key — a frame without one cannot be ordered
// against the last, so it is not usable. `url`/`title` are read straight into the
// URL bar. Loose so added fields (`driving`, `isSelf`, future ones) pass through.
export const BrowserEventSchema = z.looseObject({
  url: z.string(),
  title: z.string(),
  version: z.number(),
  // Present on the frame that announces a popup this tab opened. Such a frame
  // repeats the tab's own state and does NOT advance `version`, so it has to be
  // read before the version gate (sse.ts).
  popup: z.optional(
    z.looseObject({
      browserId: z.string(),
      url: z.string(),
      openerBrowserId: z.optional(z.string()),
    }),
  ),
});
