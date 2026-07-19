import { defineCommand } from '@bundled/yaar';
import { outputSize, sourceRect } from '../core/doc';
import { dispatch } from '../store';
import { docSummary, requireDoc } from './shared';

export const transformCommands = {
  crop: defineCommand({
    description:
      'Crop to a rectangle in SOURCE image pixels (independent of current rotation). Clamped to the image bounds.',
    params: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
    },
    handler: (p) => docSummary(dispatch({ type: 'crop', rect: p })),
  }),

  cropAspect: defineCommand({
    description:
      'Crop to an aspect ratio, centred, taking the largest area that fits. Use for "make this square" (1:1) or "make this 16:9".',
    params: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Aspect width, e.g. 16' },
        height: { type: 'number', description: 'Aspect height, e.g. 9' },
      },
      required: ['width', 'height'],
    },
    handler: (p) => {
      const d = requireDoc();
      if (p.width <= 0 || p.height <= 0) throw new Error('Aspect values must be positive.');
      // Fit inside the CURRENT source rect, so successive aspect crops
      // narrow the region instead of jumping back to the full image.
      const src = sourceRect(d);
      const target = p.width / p.height;
      let w = src.w;
      let h = Math.round(w / target);
      if (h > src.h) {
        h = src.h;
        w = Math.round(h * target);
      }
      return docSummary(
        dispatch({
          type: 'crop',
          rect: {
            x: src.x + Math.round((src.w - w) / 2),
            y: src.y + Math.round((src.h - h) / 2),
            w,
            h,
          },
        }),
      );
    },
  }),

  uncrop: defineCommand({
    description: 'Remove the crop and restore the full image area.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'uncrop' })),
  }),

  rotate: defineCommand({
    description:
      'Rotate by a relative amount in degrees, snapped to the nearest 90. Negative rotates counter-clockwise.',
    params: {
      type: 'object',
      properties: { degrees: { type: 'number' } },
      required: ['degrees'],
    },
    handler: (p) => docSummary(dispatch({ type: 'rotate', degrees: p.degrees })),
  }),

  flip: defineCommand({
    description: 'Mirror the image along an axis.',
    params: {
      type: 'object',
      properties: { axis: { type: 'string', enum: ['horizontal', 'vertical'] } },
      required: ['axis'],
    },
    handler: (p) => docSummary(dispatch({ type: 'flip', axis: p.axis })),
  }),

  resize: defineCommand({
    description:
      'Set output dimensions. Supply only width or only height to scale proportionally (lockAspect defaults to true).',
    params: {
      type: 'object',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        lockAspect: { type: 'boolean' },
      },
    },
    handler: (p) => {
      if (p.width == null && p.height == null) throw new Error('Provide width, height, or both.');
      return docSummary(
        dispatch({
          type: 'resize',
          width: p.width,
          height: p.height,
          lockAspect: p.lockAspect,
        }),
      );
    },
  }),

  scale: defineCommand({
    description: 'Resize by a factor of the current output size. 0.5 halves it, 2 doubles it.',
    params: {
      type: 'object',
      properties: { factor: { type: 'number' } },
      required: ['factor'],
    },
    handler: (p) => {
      const d = requireDoc();
      if (!(p.factor > 0)) throw new Error('Factor must be greater than 0.');
      const out = outputSize(d);
      return docSummary(
        dispatch({
          type: 'resize',
          width: Math.max(1, Math.round(out.w * p.factor)),
          height: Math.max(1, Math.round(out.h * p.factor)),
          lockAspect: false,
        }),
      );
    },
  }),
};
