import { defineCommand } from '@bundled/yaar';
import { dispatch } from '../store';
import { docSummary } from './shared';

export const filterCommands = {
  filter: defineCommand({
    description:
      'Set filter values. brightness/contrast/saturation are percentages where 100 is unchanged; blur is pixels at full resolution. Only the supplied keys change.',
    params: {
      type: 'object',
      properties: {
        brightness: { type: 'number' },
        contrast: { type: 'number' },
        saturation: { type: 'number' },
        blur: { type: 'number' },
      },
    },
    handler: (p) => {
      const values = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'number'));
      if (!Object.keys(values).length) throw new Error('Provide at least one filter value.');
      return docSummary(dispatch({ type: 'filter', values }));
    },
  }),

  resetFilters: defineCommand({
    description: 'Return all filters to their neutral values.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'resetFilters' })),
  }),

  reset: defineCommand({
    description: 'Discard every edit and return to the original image. Undoable.',
    params: { type: 'object', properties: {} },
    handler: () => docSummary(dispatch({ type: 'reset' })),
  }),
};
