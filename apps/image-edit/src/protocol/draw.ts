import { defineCommand } from '@bundled/yaar';
import { dispatch, setTool, type Tool } from '../store';
import { docSummary, requireDoc } from './shared';

export const drawCommands = {
  draw: defineCommand({
    description:
      'Paint a brush stroke through a list of points in SOURCE image coordinates. size is the brush diameter in source pixels. erase=true punches through to transparency instead of painting. A single point draws a dot.',
    params: {
      type: 'object',
      properties: {
        points: {
          type: 'array',
          description: 'Ordered [{x, y}, ...] in source pixels.',
          items: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } },
            required: ['x', 'y'],
          },
        },
        color: { type: 'string', description: 'Any CSS colour. Default #e5534b.' },
        size: { type: 'number', description: 'Diameter in source pixels. Default 12.' },
        erase: { type: 'boolean' },
      },
      required: ['points'],
    },
    handler: (p) => {
      requireDoc();
      const points = (p.points ?? []).filter(
        (pt: { x: number; y: number }) => typeof pt?.x === 'number' && typeof pt?.y === 'number',
      );
      if (!points.length) throw new Error('Provide at least one point.');
      return docSummary(
        dispatch({
          type: 'draw',
          stroke: {
            color: p.color ?? '#e5534b',
            size: Math.max(1, p.size ?? 12),
            erase: p.erase ?? false,
            points,
          },
        }),
      );
    },
  }),

  clearDrawing: defineCommand({
    description: 'Discard every brush stroke, leaving other edits in place.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'clearStrokes' })),
  }),

  setTool: defineCommand({
    description:
      'Switch the active pointer tool so the user can carry on by hand. none disables dragging on the canvas.',
    params: {
      type: 'object',
      properties: {
        tool: { type: 'string', enum: ['none', 'crop', 'wand', 'lasso', 'draw'] },
      },
      required: ['tool'],
    },
    handler: (p) => {
      setTool(p.tool as Tool);
      return { tool: p.tool };
    },
  }),
};
