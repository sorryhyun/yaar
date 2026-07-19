import { setProtocolContext, type ProtocolContext } from './protocol/context';
import { deckCommands } from './protocol/deck';
import { storageCommands } from './protocol/storage';
import { themeCommands } from './protocol/theme';
import type { Deck } from './types';
import { app } from '@bundled/yaar';

export type { ProtocolContext };

// === Protocol helpers ===
function cloneDeckValue(ctx: ProtocolContext): Deck {
  return JSON.parse(JSON.stringify(ctx.getDeck())) as Deck;
}

// === Register App Protocol ===
export function registerProtocol(ctx: ProtocolContext): void {
  if (!app) return;

  setProtocolContext(ctx);

  app.register({
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
      ...deckCommands,
      ...themeCommands,
      ...storageCommands,
    },
  });
}
