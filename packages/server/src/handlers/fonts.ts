/**
 * Font domain handlers for the verb layer — the faces YAAR serves, and subsets of them.
 *
 *   list('yaar://system/fonts')                              → the families served
 *   read('yaar://system/fonts')                              → catalog + the by-URL @font-face CSS
 *   invoke('yaar://system/fonts', { text, family, weights }) → subsetted faces as data: URLs
 *
 * The subset is the reason this exists. An app that rasterises its own DOM goes
 * through an SVG `foreignObject`, which Chrome draws in secure static mode: no
 * stylesheet, no network, and *no webfont by URL*. Only a `data:` URL
 * `@font-face` is honoured there, a whole face is ~1.6 MB, and so every app that
 * wanted its own typography in a picture had to fetch, parse and subset an
 * OpenType file by hand. `invoke` is that, done once, on the machine that
 * already has the file open.
 *
 * `read` and `list` are deliberately network-free and cheap — a UI can poll
 * either. Only `invoke` does work, and its cost is bounded by `MAX_SUBSET_CHARS`.
 */

import type { FontCatalog } from '@yaar/shared';
import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import { okJson, okLinks, error } from './utils.js';
import {
  FontRequestError,
  listFaces,
  listFamilies,
  subsetForText,
  urlFaceCss,
  MAX_SUBSET_CHARS,
} from '../features/fonts/index.js';

const INVOKE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description:
        "The characters to cover. Pass the page's text; duplicates and whitespace are harmless. " +
        `Up to ${MAX_SUBSET_CHARS} distinct characters per call.`,
    },
    family: {
      type: 'string',
      description:
        'Family to subset, as `read` reports it. Defaults to the first proportional family served.',
    },
    weights: {
      type: 'array',
      items: { type: 'number' },
      description:
        'CSS weights to cover (e.g. [400, 700]). Each is resolved by CSS font matching against ' +
        'the files served, so asking for 500 gets whichever face a browser would pick. Defaults to [400].',
    },
    outlineTable: {
      type: 'boolean',
      description:
        'Also return the raw CFF table, base64, for a PDF /FontFile3. Roughly doubles the response; ' +
        'only a caller embedding glyphs in a PDF needs it.',
    },
  },
  required: ['text'],
};

export function registerFontHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://system/fonts', {
    description:
      'The webfonts YAAR serves. Read for the catalog plus @font-face rules pointing at the full ' +
      'files (what a measuring pass wants). Invoke with `text` to get those faces subsetted to just ' +
      'those characters and inlined as data: URLs — which is what an SVG rasteriser, a print ' +
      'stylesheet or a PDF embedder needs, since none of them can fetch a font by URL. The subset ' +
      'preserves glyph indices, so it lays text out identically to the full face and a PDF can ' +
      'address glyphs by the ids returned in `gids`.',
    verbs: ['describe', 'read', 'list', 'invoke'],
    invokeSchema: INVOKE_SCHEMA,

    async list() {
      return okLinks(
        listFamilies().map((family) => ({
          uri: 'yaar://system/fonts',
          name: family.family,
          description: `${family.mono ? 'Monospace' : 'Proportional'} — weights ${family.weights.join(', ')}`,
        })),
      );
    },

    async read(): Promise<VerbResult> {
      const catalog: FontCatalog = {
        families: listFamilies(),
        faces: listFaces(),
        // The by-URL rules, so a caller measuring against the real face does not
        // have to reassemble them from `faces` and get the format hint wrong.
        css: urlFaceCss(),
      };
      return okJson(catalog);
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const request = (payload ?? {}) as {
        text?: string;
        family?: string;
        weights?: number[];
        outlineTable?: boolean;
      };
      if (typeof request.text !== 'string') {
        return error('Provide `text`: the characters the subset must cover.');
      }
      try {
        return okJson(
          await subsetForText({
            text: request.text,
            family: request.family,
            weights: request.weights,
            outlineTable: request.outlineTable === true,
          }),
        );
      } catch (err) {
        // A refused request is the caller's mistake and reads as one; anything
        // else is a bug here and should not be flattened into an error string.
        if (err instanceof FontRequestError) return error(err.message);
        throw err;
      }
    },
  });
}
