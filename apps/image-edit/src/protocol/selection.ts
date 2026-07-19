import { defineCommand } from '@bundled/yaar';
import {
  clearSelection,
  dispatch,
  magicWandAt,
  selectAll,
  setContiguous,
  setTolerance,
} from '../store';
import { docSummary, requireDoc } from './shared';

export const selectionCommands = {
  magicWand: defineCommand({
    description:
      'Select pixels similar in colour to the one at (x, y), in SOURCE image coordinates. Raise tolerance to catch more shades. contiguous=true (default) takes only the connected region touching that point; false takes every matching pixel in the image. Returns the resulting selection so you can check the size before acting on it.',
    params: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        tolerance: { type: 'number', description: '0-128 colour distance. Default 32.' },
        contiguous: { type: 'boolean' },
        mode: {
          type: 'string',
          enum: ['replace', 'add', 'subtract'],
          description: 'How to combine with the existing selection. Default replace.',
        },
      },
      required: ['x', 'y'],
    },
    handler: (p) => {
      requireDoc();
      if (p.tolerance != null) setTolerance(p.tolerance);
      if (p.contiguous != null) setContiguous(p.contiguous);
      magicWandAt(p.x, p.y, {
        tolerance: p.tolerance,
        contiguous: p.contiguous,
        mode: p.mode,
      });
      return docSummary(requireDoc());
    },
  }),

  selectAll: defineCommand({
    description: 'Select every pixel. Useful as a base for subtractive selection.',
    params: { type: 'object', properties: {} },
    handler: () => {
      selectAll();
      return docSummary(requireDoc());
    },
  }),

  clearSelection: defineCommand({
    description: 'Deselect everything. Does not undo a removal.',
    params: { type: 'object', properties: {} },
    handler: () => {
      clearSelection();
      return docSummary(requireDoc());
    },
  }),

  invertSelection: defineCommand({
    description:
      'Swap selected and unselected. With nothing selected this selects everything. Use after selecting a background to isolate the subject.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'invertSelection' })),
  }),

  cropToSelection: defineCommand({
    description:
      'Crop to the bounding box of the current selection AND make every pixel outside the selection mask transparent. This is the one-step way to isolate a non-rectangular subject: magicWand or lasso the subject, call cropToSelection, then export as PNG. jpeg has no alpha channel and flattens the transparency onto white.',
    params: { type: 'object', properties: {} },
    handler: () => {
      if (!requireDoc().selection) throw new Error('Nothing is selected. Call `magicWand` first.');
      return docSummary(dispatch({ type: 'cropToSelection' }));
    },
  }),

  removeSelection: defineCommand({
    description:
      'Make the selected pixels transparent and clear the selection. To isolate a subject: magicWand on the background, then removeSelection, then export as PNG — jpeg has no alpha channel and would fill the hole with black.',
    params: { type: 'object', properties: {} },
    handler: () => {
      if (!requireDoc().selection) throw new Error('Nothing is selected. Call `magicWand` first.');
      return docSummary(dispatch({ type: 'removeSelection' }));
    },
  }),

  restoreRemoved: defineCommand({
    description: 'Bring back every pixel removed by `removeSelection`.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'restoreRemoved' })),
  }),
};
