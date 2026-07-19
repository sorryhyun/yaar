import { normalizeAspectRatio } from '../aspect-ratio';
import { isFontSize, newSlide, normalizeDeck, normalizeSlideInput } from '../deck-utils';
import { isThemeId } from '../theme';
import type { Deck, Slide } from '../types';
import { ctx, type StorageMergeMode, type StorageReadMode } from './context';
import { storage, AppCommandError, defineCommand } from '@bundled/yaar';

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
  } catch {
    /* non-json */
  }
  return {
    title: fallbackTitle,
    slides: [normalizeSlideInput({ title: fallbackTitle, body: raw })],
  };
}

export const storageCommands = {
  saveToStorage: defineCommand({
    description:
      'Save current deck JSON to YAAR storage at the given path. Returns { path, slideCount }.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Storage path, e.g. "my-deck.json".' },
      },
      required: ['path'],
    },
    handler: async (p) => {
      if (!storage) throw new AppCommandError('Storage API not available');
      await storage.save(p.path, JSON.stringify(ctx().getDeck(), null, 2));
      return { path: p.path, slideCount: ctx().getDeck().slides.length };
    },
  }),
  loadFromStorage: defineCommand({
    description:
      'Load one or many deck JSON files from YAAR storage and merge into the current deck. ' +
      'Accepts path (single) and/or paths (array). mode "replace" (default) resets slides; ' +
      '"append" adds to existing. Returns { mode, loaded, paths }.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Single storage path to load.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Multiple storage paths to load.',
        },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'Merge mode.' },
      },
    },
    handler: async (p) => {
      if (!storage) throw new AppCommandError('Storage API not available');
      const candidatePaths = [
        ...(p.path ? [p.path as string] : []),
        ...(Array.isArray(p.paths) ? (p.paths as string[]) : []),
      ].filter(Boolean);
      if (!candidatePaths.length) throw new AppCommandError('Provide path or paths');
      const deck = ctx().getDeck();
      const loadedSlides: Slide[] = [];
      let firstTitle = deck.title;
      for (const path of candidatePaths) {
        const raw = (await storage.read(path, { as: 'text' })) as unknown as string;
        const fallbackTitle =
          (path.split('/').pop() || path).replace(/\.[^/.]+$/, '') || 'Imported Deck';
        const parsed = parseDeckOrSlidesFromStorage(raw, fallbackTitle);
        if (!firstTitle || firstTitle === 'Untitled Deck') firstTitle = parsed.title || firstTitle;
        loadedSlides.push(...parsed.slides);
      }
      const mode = (p.mode as StorageMergeMode) || 'replace';
      if (mode === 'append') {
        if (loadedSlides.length) deck.slides.push(...loadedSlides);
        deck.activeIndex = Math.max(0, deck.slides.length - 1);
      } else {
        deck.slides = loadedSlides.length ? loadedSlides : [newSlide()];
        deck.activeIndex = 0;
        deck.title = firstTitle || deck.title;
      }
      ctx().clampActive();
      ctx().persist(false);
      ctx().bumpDeck();
      ctx().bumpActiveIndex();
      return { mode, loaded: loadedSlides.length, paths: candidatePaths };
    },
  }),
  readStorageFile: defineCommand({
    description:
      'Read a single file from YAAR storage and return its content. Returns { path, as, content }.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Storage path to read.' },
        as: {
          type: 'string',
          enum: ['text', 'json', 'auto'],
          description: 'Read mode (default: "text").',
        },
      },
      required: ['path'],
    },
    handler: async (p) => {
      if (!storage) throw new AppCommandError('Storage API not available');
      const as = (p.as as StorageReadMode) || 'text';
      const content = await storage.read(p.path, { as });
      return { path: p.path, as, content };
    },
  }),
  readStorageFiles: defineCommand({
    description:
      'Read multiple files from YAAR storage. Returns { as, files: [{ path, content }] }.',
    params: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Storage paths to read.',
        },
        as: {
          type: 'string',
          enum: ['text', 'json', 'auto'],
          description: 'Read mode (default: "text").',
        },
      },
      required: ['paths'],
    },
    handler: async (p) => {
      if (!storage) throw new AppCommandError('Storage API not available');
      const as = (p.as as StorageReadMode) || 'text';
      const paths = (Array.isArray(p.paths) ? (p.paths as string[]) : []).filter(Boolean);
      const files = await Promise.all(
        paths.map(async (path) => ({
          path,
          content: await storage!.read(path, { as }),
        })),
      );
      return { as, files };
    },
  }),
};
