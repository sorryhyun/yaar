import { newSlide, normalizeDeck, normalizeSlideInput } from '../deck-utils';
import type { Deck, Slide } from '../types';
import { ctx, type StorageMergeMode } from './context';
import { defineCommand } from '@bundled/yaar';

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

export const deckCommands = {
  setDeck: defineCommand({
    description:
      'Replace the entire deck at once. All fields are normalized on write. ' +
      'Deck-level fontSize defaults to "md" if absent. ' +
      'Individual slides may include a fontSize field to override the deck-level setting per slide. ' +
      'Returns { slideCount }.',
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
    handler: (p) => {
      ctx().setDeck(normalizeDeck(p.deck as Deck));
      ctx().setFilterQuery('');
      ctx().persist(false);
      ctx().bumpDeck();
      ctx().bumpActiveIndex();
      return { slideCount: ctx().getDeck().slides.length };
    },
  }),
  setSlides: defineCommand({
    description:
      'Set slides in "replace" (default) or "append" mode. ' +
      'In replace mode the existing slides are discarded and replaced with the provided array. ' +
      'In append mode the new slides are added after the last existing slide. ' +
      'Each slide may include an optional fontSize field to override the deck-level fontSize for that slide only. ' +
      'Returns { mode, slideCount }.',
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
    handler: (p) => {
      const deck = ctx().getDeck();
      const slides = (Array.isArray(p.slides) ? (p.slides as Partial<Slide>[]) : []).map((s) =>
        normalizeSlideInput(s),
      );
      const mode = (p.mode as StorageMergeMode) || 'replace';
      if (mode === 'append') {
        if (slides.length) deck.slides.push(...slides);
        deck.activeIndex = Math.max(0, deck.slides.length - 1);
      } else {
        deck.slides = slides.length ? slides : [newSlide()];
        deck.activeIndex = 0;
      }
      ctx().clampActive();
      ctx().persist(false);
      ctx().bumpDeck();
      ctx().bumpActiveIndex();
      return { mode, slideCount: deck.slides.length };
    },
  }),
  appendSlides: defineCommand({
    description:
      'Append one or more slides to the end of the deck and select the last appended slide. ' +
      'Equivalent to setSlides with mode "append". ' +
      'Each slide may include an optional fontSize field to override the deck-level fontSize for that slide only. ' +
      'Returns { appended, slideCount }.',
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
    handler: (p) => {
      const deck = ctx().getDeck();
      const slides = (Array.isArray(p.slides) ? (p.slides as Partial<Slide>[]) : []).map((s) =>
        normalizeSlideInput(s),
      );
      if (slides.length) {
        deck.slides.push(...slides);
        deck.activeIndex = deck.slides.length - 1;
        ctx().clampActive();
        ctx().persist(false);
        ctx().bumpDeck();
        ctx().bumpActiveIndex();
      }
      return { appended: slides.length, slideCount: deck.slides.length };
    },
  }),
  setActiveIndex: defineCommand({
    description:
      'Select a slide by zero-based index. Clamped to valid range. Returns { activeIndex }.',
    aliases: ['selectSlide', 'goToSlide', 'jumpToSlide'],
    params: {
      type: 'object',
      properties: { index: { type: 'number', description: 'Zero-based slide index.' } },
      required: ['index'],
    },
    handler: (p) => {
      const deck = ctx().getDeck();
      deck.activeIndex = Math.max(0, Math.min(Math.floor(p.index), deck.slides.length - 1));
      ctx().bumpDeck();
      ctx().bumpActiveIndex();
      return { activeIndex: deck.activeIndex };
    },
  }),
};
