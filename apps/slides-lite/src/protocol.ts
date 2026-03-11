import { normalizeAspectRatio } from './aspect-ratio';
import { isFontSize, newSlide, normalizeDeck, normalizeSlideInput } from './deck-utils';
import { isThemeId } from './theme';
import type { Deck, FontSize, Slide, ThemeId } from './types';

// === Types used only in protocol ===
type StorageReadMode = 'text' | 'json' | 'auto';
type StorageMergeMode = 'replace' | 'append';

// === Shared JSON-Schema fragments ===
// Slide item schema — used inline in setDeck, setSlides, appendSlides
const SLIDE_ITEM_SCHEMA = {
  type: 'object',
  description:
    'A single slide. All fields are optional when creating; omitted fields are given safe defaults. ' +
    'id is auto-generated if absent. layout defaults to "title-body". ' +
    'body supports Markdown (bold, italic, lists, headings, code, blockquotes, links, hr). ' +
    'imageUrl is only rendered by the "title-image" layout.',
  properties: {
    id: {
      type: 'string',
      description: 'Optional stable UUID. Auto-generated if absent.',
    },
    layout: {
      type: 'string',
      enum: ['title-body', 'title-image', 'section'],
      description:
        '"title-body": title heading + markdown body (default). ' +
        '"title-image": title + embedded image (imageUrl) + optional body. ' +
        '"section": full-bleed accent section divider — title + optional body, no image.',
    },
    title: {
      type: 'string',
      description: 'Slide heading shown as an <h1>. Plain text only (no markdown).',
    },
    body: {
      type: 'string',
      description:
        'Slide body rendered as Markdown. Supports: **bold**, *italic*, # headings, ' +
        '- bullet lists, 1. ordered lists, > blockquotes, `code`, ```fenced code```, ' +
        '[links](url), --- horizontal rule.',
    },
    imageUrl: {
      type: 'string',
      description:
        'Absolute URL for an image. Only displayed when layout is "title-image". ' +
        'Rendered at max-width:100%, max-height:260px.',
    },
    notes: {
      type: 'string',
      description:
        'Private speaker notes. Never shown in the slide preview or presentation canvas. ' +
        'Readable via the activeSlide state key.',
    },
    fontSize: {
      type: 'string',
      enum: ['sm', 'md', 'lg', 'xl'],
      description:
        'Per-slide font size override. If set, overrides the deck-level fontSize for this slide only. ' +
        'Values: "sm" | "md" | "lg" | "xl". Omit or set to undefined to inherit the deck setting.',
    },
  },
} as const;

// === Context passed in from main.ts ===
export interface ProtocolContext {
  getDeck: () => Deck;
  setDeck: (d: Deck) => void;
  getFilterQuery: () => string;
  setFilterQuery: (q: string) => void;
  activeSlide: () => Slide;
  clampActive: () => void;
  persist: (showToast?: boolean) => void;
  bumpDeck: () => void;
  bumpActiveIndex: () => void;
}

// === Protocol helpers ===
function cloneDeckValue(ctx: ProtocolContext): Deck {
  return JSON.parse(JSON.stringify(ctx.getDeck())) as Deck;
}

function parseDeckOrSlidesFromStorage(
  raw: string,
  fallbackTitle: string,
): { title: string; slides: Slide[] } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const slides = parsed.map((item) => normalizeSlideInput(item as Partial<Slide>));
      return { title: fallbackTitle, slides: slides.length ? slides : [newSlide()] };
    }
    if (parsed && typeof parsed === 'object') {
      const maybeDeck = parsed as Partial<Deck>;
      if (Array.isArray(maybeDeck.slides)) {
        const normalized = normalizeDeck({
          title: maybeDeck.title || fallbackTitle,
          themeId: isThemeId(maybeDeck.themeId) ? maybeDeck.themeId : 'classic-light',
          slides: maybeDeck.slides.map((s) => normalizeSlideInput(s)),
          activeIndex: typeof maybeDeck.activeIndex === 'number' ? maybeDeck.activeIndex : 0,
          aspectRatio: normalizeAspectRatio((maybeDeck as Deck).aspectRatio),
          fontSize: isFontSize(maybeDeck.fontSize) ? maybeDeck.fontSize : 'md',
        });
        return { title: normalized.title, slides: normalized.slides };
      }
    }
  } catch { /* non-json */ }
  return { title: fallbackTitle, slides: [normalizeSlideInput({ title: fallbackTitle, body: raw })] };
}

// === Register App Protocol ===
export function registerProtocol(ctx: ProtocolContext): void {
  const appApi = (window as any).yaar?.app;
  if (!appApi) return;

  appApi.register({
    appId: 'slides-lite',
    name: 'Slides Lite',
    state: {
      deck: {
        description:
          'Full deck object. Shape: { title: string, themeId: ThemeId, slides: Slide[], ' +
          'activeIndex: number, aspectRatio: string, fontSize: "sm"|"md"|"lg"|"xl" }. ' +
          'Each slide may also carry an optional fontSize field that overrides the deck-level fontSize for that slide only. ' +
          'Use setDeck to replace the whole deck, or setSlides/appendSlides to update only slides.',
        handler: () => cloneDeckValue(ctx),
      },
      activeSlide: {
        description:
          'Currently selected slide. Shape: { id, layout, title, body, imageUrl, notes, fontSize? }. ' +
          'Includes notes which are hidden in the slide canvas. ' +
          'fontSize is optional — if present it overrides the deck-level fontSize for this slide only.',
        handler: () => ({ ...ctx.activeSlide() }),
      },
      title: {
        description: 'Deck title (string).',
        handler: () => ctx.getDeck().title,
      },
      theme: {
        description:
          'Current theme ID. Valid values: "classic-light" (white bg, blue accent), ' +
          '"midnight-dark" (dark bg, blue accent), "ocean" (light-blue bg), ' +
          '"sunset" (warm bg, orange accent).',
        handler: () => ctx.getDeck().themeId,
      },
      aspectRatio: {
        description:
          'Slide aspect ratio as "W:H" string (e.g. "16:9", "4:3", "1:1" or custom like "3:2"). ' +
          'Presets: "16:9", "4:3", "1:1".',
        handler: () => ctx.getDeck().aspectRatio,
      },
      activeIndex: {
        description: 'Zero-based index of the currently active (selected) slide.',
        handler: () => ctx.getDeck().activeIndex,
      },
      slideCount: {
        description: 'Total number of slides in the deck.',
        handler: () => ctx.getDeck().slides.length,
      },
      fontSize: {
        description:
          'Global text scale for all slides. Values: "sm" (0.78x), "md" (1.0x, default), ' +
          '"lg" (1.22x), "xl" (1.5x). Scales both heading and body text proportionally.',
        handler: () => ctx.getDeck().fontSize,
      },
    },
    commands: {
      setDeck: {
        description:
          'Replace the entire deck at once. All fields are normalized on write. ' +
          'Deck-level fontSize defaults to "md" if absent. ' +
          'Individual slides may include a fontSize field to override the deck-level setting per slide. ' +
          'Returns { ok, slideCount }.',
        params: {
          type: 'object',
          properties: {
            deck: {
              type: 'object',
              description: 'Full deck object to load.',
              properties: {
                title: { type: 'string', description: 'Deck title.' },
                themeId: {
                  type: 'string',
                  enum: ['classic-light', 'midnight-dark', 'ocean', 'sunset'],
                  description: 'Theme ID.',
                },
                aspectRatio: {
                  type: 'string',
                  description: 'Aspect ratio string, e.g. "16:9".',
                },
                fontSize: {
                  type: 'string',
                  enum: ['sm', 'md', 'lg', 'xl'],
                  description: 'Global font size scale.',
                },
                activeIndex: {
                  type: 'number',
                  description: 'Zero-based index of slide to show on load.',
                },
                slides: {
                  type: 'array',
                  description: 'Array of slide objects.',
                  items: SLIDE_ITEM_SCHEMA,
                },
              },
              required: ['slides'],
            },
          },
          required: ['deck'],
        },
        handler: (p: { deck: Deck }) => {
          ctx.setDeck(normalizeDeck(p.deck));
          ctx.setFilterQuery('');
          ctx.persist(false);
          ctx.bumpDeck();
          ctx.bumpActiveIndex();
          return { ok: true, slideCount: ctx.getDeck().slides.length };
        },
      },
      setSlides: {
        description:
          'Set slides in "replace" (default) or "append" mode. ' +
          'In replace mode the existing slides are discarded and replaced with the provided array. ' +
          'In append mode the new slides are added after the last existing slide. ' +
          'Each slide may include an optional fontSize field to override the deck-level fontSize for that slide only. ' +
          'Returns { ok, mode, slideCount }.',
        params: {
          type: 'object',
          properties: {
            slides: {
              type: 'array',
              description: 'Array of slide objects to set or append.',
              items: SLIDE_ITEM_SCHEMA,
            },
            mode: {
              type: 'string',
              enum: ['replace', 'append'],
              description: '"replace" (default) clears existing slides; "append" adds to the end.',
            },
          },
          required: ['slides'],
        },
        handler: (p: { slides: Partial<Slide>[]; mode?: StorageMergeMode }) => {
          const deck = ctx.getDeck();
          const slides = (Array.isArray(p.slides) ? p.slides : []).map((s) => normalizeSlideInput(s));
          if ((p.mode || 'replace') === 'append') {
            if (slides.length) deck.slides.push(...slides);
            deck.activeIndex = Math.max(0, deck.slides.length - 1);
          } else {
            deck.slides = slides.length ? slides : [newSlide()];
            deck.activeIndex = 0;
          }
          ctx.clampActive();
          ctx.persist(false);
          ctx.bumpDeck();
          ctx.bumpActiveIndex();
          return { ok: true, mode: p.mode || 'replace', slideCount: deck.slides.length };
        },
      },
      appendSlides: {
        description:
          'Append one or more slides to the end of the deck and select the last appended slide. ' +
          'Equivalent to setSlides with mode "append". ' +
          'Each slide may include an optional fontSize field to override the deck-level fontSize for that slide only. ' +
          'Returns { ok, appended, slideCount }.',
        params: {
          type: 'object',
          properties: {
            slides: {
              type: 'array',
              description: 'Array of slide objects to append.',
              items: SLIDE_ITEM_SCHEMA,
            },
          },
          required: ['slides'],
        },
        handler: (p: { slides: Partial<Slide>[] }) => {
          const deck = ctx.getDeck();
          const slides = (Array.isArray(p.slides) ? p.slides : []).map((s) => normalizeSlideInput(s));
          if (slides.length) {
            deck.slides.push(...slides);
            deck.activeIndex = deck.slides.length - 1;
            ctx.clampActive();
            ctx.persist(false);
            ctx.bumpDeck();
            ctx.bumpActiveIndex();
          }
          return { ok: true, appended: slides.length, slideCount: deck.slides.length };
        },
      },
      setActiveIndex: {
        description: 'Select a slide by zero-based index. Clamped to valid range. Returns { ok, activeIndex }.',
        aliases: ['selectSlide', 'goToSlide', 'jumpToSlide'],
        params: { type: 'object', properties: { index: { type: 'number', description: 'Zero-based slide index.' } }, required: ['index'] },
        handler: (p: { index: number }) => {
          const deck = ctx.getDeck();
          deck.activeIndex = Math.max(0, Math.min(Math.floor(p.index), deck.slides.length - 1));
          ctx.bumpDeck();
          ctx.bumpActiveIndex();
          return { ok: true, activeIndex: deck.activeIndex };
        },
      },
      setTheme: {
        description:
          'Change the deck theme. Valid themeId values: "classic-light", "midnight-dark", "ocean", "sunset". ' +
          'Returns { ok, themeId } or { ok: false, error } for invalid IDs.',
        params: {
          type: 'object',
          properties: {
            themeId: {
              type: 'string',
              enum: ['classic-light', 'midnight-dark', 'ocean', 'sunset'],
              description:
                'Theme identifier. ' +
                '"classic-light": white background, dark text, blue accent. ' +
                '"midnight-dark": dark background, light text, blue accent. ' +
                '"ocean": light-blue background, dark-blue text, cyan accent. ' +
                '"sunset": warm/cream background, brown text, orange accent.',
            },
          },
          required: ['themeId'],
        },
        handler: (p: { themeId: ThemeId }) => {
          if (!isThemeId(p.themeId)) return { ok: false, error: `Invalid themeId: ${String(p.themeId)}` };
          ctx.getDeck().themeId = p.themeId;
          ctx.persist(false);
          ctx.bumpDeck();
          return { ok: true, themeId: ctx.getDeck().themeId };
        },
      },
      setAspectRatio: {
        description:
          'Set slide aspect ratio. Pass a "W:H" string. ' +
          'Named presets: "16:9" (widescreen), "4:3" (standard), "1:1" (square). ' +
          'Custom: any "W:H" like "3:2" or "2.35:1". Returns { ok, aspectRatio }.',
        params: {
          type: 'object',
          properties: {
            aspectRatio: {
              type: 'string',
              description: 'Aspect ratio string, e.g. "16:9", "4:3", "1:1", or custom "W:H".',
            },
          },
          required: ['aspectRatio'],
        },
        handler: (p: { aspectRatio: string }) => {
          ctx.getDeck().aspectRatio = normalizeAspectRatio(p.aspectRatio);
          ctx.persist(false);
          ctx.bumpDeck();
          return { ok: true, aspectRatio: ctx.getDeck().aspectRatio };
        },
      },
      setFontSize: {
        description:
          'Set global font size scale for all slides. ' +
          'Scales heading and body text proportionally via a CSS multiplier. ' +
          '"sm" = 0.78x, "md" = 1.0x (default), "lg" = 1.22x, "xl" = 1.5x. ' +
          'Returns { ok, fontSize } or { ok: false, error } for invalid values.',
        params: {
          type: 'object',
          properties: {
            size: {
              type: 'string',
              enum: ['sm', 'md', 'lg', 'xl'],
              description: 'Font size preset: "sm" | "md" | "lg" | "xl".',
            },
          },
          required: ['size'],
        },
        handler: (p: { size: FontSize }) => {
          if (!isFontSize(p.size)) return { ok: false, error: `Invalid size: ${String(p.size)}` };
          ctx.getDeck().fontSize = p.size;
          ctx.persist(false);
          ctx.bumpDeck();
          return { ok: true, fontSize: ctx.getDeck().fontSize };
        },
      },
      saveToStorage: {
        description: 'Save current deck JSON to YAAR storage at the given path. Returns { ok, path, slideCount }.',
        params: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Storage path, e.g. "slides-lite/my-deck.json".' } },
          required: ['path'],
        },
        handler: async (p: { path: string }) => {
          const yaarStorage = (window as any).yaar?.storage;
          if (!yaarStorage) return { ok: false, error: 'Storage API not available' };
          await yaarStorage.save(p.path, JSON.stringify(ctx.getDeck(), null, 2));
          return { ok: true, path: p.path, slideCount: ctx.getDeck().slides.length };
        },
      },
      loadFromStorage: {
        description:
          'Load one or many deck JSON files from YAAR storage and merge into the current deck. ' +
          'Accepts path (single) and/or paths (array). mode "replace" (default) resets slides; ' +
          '"append" adds to existing. Returns { ok, mode, loaded, paths }.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Single storage path to load.' },
            paths: { type: 'array', items: { type: 'string' }, description: 'Multiple storage paths to load.' },
            mode: { type: 'string', enum: ['replace', 'append'], description: 'Merge mode.' },
          },
        },
        handler: async (p: { path?: string; paths?: string[]; mode?: StorageMergeMode }) => {
          const yaarStorage = (window as any).yaar?.storage;
          if (!yaarStorage) return { ok: false, error: 'Storage API not available' };
          const candidatePaths = [
            ...(p.path ? [p.path] : []),
            ...(Array.isArray(p.paths) ? p.paths : []),
          ].filter(Boolean);
          if (!candidatePaths.length) return { ok: false, error: 'Provide path or paths' };
          const deck = ctx.getDeck();
          const loadedSlides: Slide[] = [];
          let firstTitle = deck.title;
          for (const path of candidatePaths) {
            const raw: string = await yaarStorage.read(path, { as: 'text' });
            const fallbackTitle =
              (path.split('/').pop() || path).replace(/\.[^/.]+$/, '') || 'Imported Deck';
            const parsed = parseDeckOrSlidesFromStorage(raw, fallbackTitle);
            if (!firstTitle || firstTitle === 'Untitled Deck') firstTitle = parsed.title || firstTitle;
            loadedSlides.push(...parsed.slides);
          }
          const mode = p.mode || 'replace';
          if (mode === 'append') {
            if (loadedSlides.length) deck.slides.push(...loadedSlides);
            deck.activeIndex = Math.max(0, deck.slides.length - 1);
          } else {
            deck.slides = loadedSlides.length ? loadedSlides : [newSlide()];
            deck.activeIndex = 0;
            deck.title = firstTitle || deck.title;
          }
          ctx.clampActive();
          ctx.persist(false);
          ctx.bumpDeck();
          ctx.bumpActiveIndex();
          return { ok: true, mode, loaded: loadedSlides.length, paths: candidatePaths };
        },
      },
      readStorageFile: {
        description: 'Read a single file from YAAR storage and return its content. Returns { ok, path, as, content }.',
        params: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Storage path to read.' },
            as: { type: 'string', enum: ['text', 'json', 'auto'], description: 'Read mode (default: "text").' },
          },
          required: ['path'],
        },
        handler: async (p: { path: string; as?: StorageReadMode }) => {
          const yaarStorage = (window as any).yaar?.storage;
          if (!yaarStorage) return { ok: false, error: 'Storage API not available' };
          const content = await yaarStorage.read(p.path, { as: p.as || 'text' });
          return { ok: true, path: p.path, as: p.as || 'text', content };
        },
      },
      readStorageFiles: {
        description: 'Read multiple files from YAAR storage. Returns { ok, as, files: [{ path, content }] }.',
        params: {
          type: 'object',
          properties: {
            paths: { type: 'array', items: { type: 'string' }, description: 'Storage paths to read.' },
            as: { type: 'string', enum: ['text', 'json', 'auto'], description: 'Read mode (default: "text").' },
          },
          required: ['paths'],
        },
        handler: async (p: { paths: string[]; as?: StorageReadMode }) => {
          const yaarStorage = (window as any).yaar?.storage;
          if (!yaarStorage) return { ok: false, error: 'Storage API not available' };
          const paths = (Array.isArray(p.paths) ? p.paths : []).filter(Boolean);
          const files = await Promise.all(
            paths.map(async (path) => ({
              path,
              content: await yaarStorage.read(path, { as: p.as || 'text' }),
            })),
          );
          return { ok: true, as: p.as || 'text', files };
        },
      },
    },
  });
}
