import { normalizeAspectRatio } from '../aspect-ratio';
import { isFontSize } from '../deck-utils';
import { isThemeId } from '../theme';
import type { FontSize, ThemeId } from '../types';
import { ctx } from './context';
import { AppCommandError, defineCommand } from '@bundled/yaar';

export const themeCommands = {
  setTheme: defineCommand({
    description:
      'Change the deck theme. Valid themeId values: "classic-light", "midnight-dark", "ocean", "sunset". ' +
      'Returns { themeId } or throws for invalid IDs.',
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
    handler: (p) => {
      const themeId = p.themeId as ThemeId;
      if (!isThemeId(themeId)) throw new AppCommandError(`Invalid themeId: ${String(themeId)}`);
      ctx().getDeck().themeId = themeId;
      ctx().persist(false);
      ctx().bumpDeck();
      return { themeId: ctx().getDeck().themeId };
    },
  }),
  setAspectRatio: defineCommand({
    description:
      'Set slide aspect ratio. Pass a "W:H" string. ' +
      'Named presets: "16:9" (widescreen), "4:3" (standard), "1:1" (square). ' +
      'Custom: any "W:H" like "3:2" or "2.35:1". Returns { aspectRatio }.',
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
    handler: (p) => {
      ctx().getDeck().aspectRatio = normalizeAspectRatio(p.aspectRatio);
      ctx().persist(false);
      ctx().bumpDeck();
      return { aspectRatio: ctx().getDeck().aspectRatio };
    },
  }),
  setFontSize: defineCommand({
    description:
      'Set global font size scale for all slides. ' +
      'Scales heading and body text proportionally via a CSS multiplier. ' +
      '"sm" = 0.78x, "md" = 1.0x (default), "lg" = 1.22x, "xl" = 1.5x. ' +
      'Returns { fontSize } or throws for invalid values.',
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
    handler: (p) => {
      const size = p.size as FontSize;
      if (!isFontSize(size)) throw new AppCommandError(`Invalid size: ${String(size)}`);
      ctx().getDeck().fontSize = size;
      ctx().persist(false);
      ctx().bumpDeck();
      return { fontSize: ctx().getDeck().fontSize };
    },
  }),
};
