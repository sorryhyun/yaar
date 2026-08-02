import { uid } from './signals';
import type { Cell } from '../types';

/** The two cells a brand-new notebook opens with. Content only — no behaviour. */
export function starterCells(): Cell[] {
  return [
    {
      id: uid('c'),
      type: 'markdown',
      source:
        '# Lab\n\nJS cells run in a Web Worker. Variables persist between cells; the last expression is the output.\n\nHelpers in scope: `store`, `csv`, `df`, `stats`, `plot`, `http`, `show()`, `md()`, `sleep()`.',
    },
    {
      id: uid('c'),
      type: 'code',
      source:
        "// Shift+Enter runs a cell.\nconst sales = [\n  { region: 'North', month: 'Jan', amount: 120 },\n  { region: 'North', month: 'Feb', amount: 180 },\n  { region: 'South', month: 'Jan', amount: 90 },\n  { region: 'South', month: 'Feb', amount: 140 },\n];\ndf(sales).groupBy('region').agg({ amount: 'sum' })",
    },
  ];
}
