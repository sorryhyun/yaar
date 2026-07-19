import { app, defineCommand } from '@bundled/yaar';
import {
  cells,
  styles,
  mutable,
  pushHistory,
  refreshAll,
  scheduleAutosave,
  setSelection,
  importWorkbook,
} from './state';
import { getStyleForRef, normalizeStyle } from './style-utils';
import { rangeRect, refsInRect } from './ref-utils';

export function registerAppProtocol() {
  if (!app) return;

  app.register({
    appId: 'excel-lite',
    name: 'Excel Lite',
    state: {
      cells: {
        description:
          'All cell values as a { [ref]: rawValue } object (e.g., {"A1":"Hello","B2":"=A1+1"})',
        handler: () => ({ ...cells }),
      },
      styles: {
        description: 'All cell styles as a { [ref]: CellStyle } object',
        handler: () => ({ ...styles }),
      },
      selection: {
        description: 'Current selection: { active, start, end }',
        handler: () => ({
          active: mutable.selected,
          start: mutable.selectionStart,
          end: mutable.selectionEnd,
        }),
      },
    },
    commands: {
      setCells: defineCommand({
        description: 'Set one or more cell values. Params: { cells: { [ref]: value } }',
        params: {
          type: 'object',
          properties: { cells: { type: 'object', additionalProperties: { type: 'string' } } },
          required: ['cells'],
        },
        handler: (p) => {
          pushHistory();
          for (const [ref, value] of Object.entries(p.cells)) {
            const upper = ref.toUpperCase();
            if (value) cells[upper] = value;
            else delete cells[upper];
          }
          refreshAll();
          scheduleAutosave();
          return { count: Object.keys(p.cells).length };
        },
      }),
      setStyles: defineCommand({
        description:
          'Set styles for one or more cells. Params: { styles: { [ref]: Partial<CellStyle> } }',
        params: {
          type: 'object',
          properties: {
            styles: {
              type: 'object',
              description: 'Map of cell ref (e.g. "A1") to a partial style patch.',
              additionalProperties: {
                type: 'object',
                properties: {
                  bold: { type: 'boolean' },
                  italic: { type: 'boolean' },
                  underline: { type: 'boolean' },
                  fontSize: { type: 'number' },
                  color: { type: 'string' },
                  bg: { type: 'string' },
                  align: { type: 'string', enum: ['left', 'center', 'right'] },
                },
              },
            },
          },
          required: ['styles'],
        },
        handler: (p) => {
          pushHistory();
          for (const [ref, patch] of Object.entries(p.styles)) {
            const upper = ref.toUpperCase();
            const merged = { ...getStyleForRef(styles, upper), ...patch };
            const normalized = normalizeStyle(merged);
            if (normalized) styles[upper] = normalized;
            else delete styles[upper];
          }
          refreshAll();
          scheduleAutosave();
        },
      }),
      selectCell: defineCommand({
        description:
          'Select a cell or range. Params: { ref: string } or { start: string, end: string }',
        params: {
          type: 'object',
          properties: {
            ref: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
          },
        },
        handler: (p) => {
          const start = (p.start ?? p.ref ?? 'A1').toUpperCase();
          const end = (p.end ?? start).toUpperCase();
          mutable.selected = start;
          setSelection(start, end, true);
        },
      }),
      clearRange: defineCommand({
        description: 'Clear all cell values in a range. Params: { start: string, end: string }',
        params: {
          type: 'object',
          properties: { start: { type: 'string' }, end: { type: 'string' } },
          required: ['start', 'end'],
        },
        handler: (p) => {
          pushHistory();
          const rect = rangeRect(p.start.toUpperCase(), p.end.toUpperCase());
          let count = 0;
          for (const ref of refsInRect(rect)) {
            if (cells[ref]) {
              delete cells[ref];
              count++;
            }
          }
          refreshAll();
          scheduleAutosave();
          return { cleared: count };
        },
      }),
      importWorkbook: defineCommand({
        description:
          'Import a full workbook JSON. Params: { data: { cells: {...}, styles?: {...} } }',
        params: { type: 'object', properties: { data: { type: 'object' } }, required: ['data'] },
        handler: (p) => {
          importWorkbook(p.data);
        },
      }),
    },
  });
}
