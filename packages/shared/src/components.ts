/**
 * Component DSL — the Zod half. Flat schema for LLM simplicity.
 * No recursion, no containers. Components are a flat array with grid layout.
 *
 * The value lists and the narrow renderer-facing types live in `component-types.ts`, which imports
 * no Zod; this file derives the schemas from them. Import from `@yaar/shared/schemas` to reach the
 * schemas — the package barrel deliberately exposes only the Zod-free half plus these inferred
 * types, so the frontend does not bundle Zod.
 */

import { z } from 'zod';
import {
  BADGE_VARIANTS,
  BUTTON_VARIANTS,
  COMPONENT_TYPES,
  GAP_VALUES,
  INPUT_VARIANTS,
  PROGRESS_VARIANTS,
  SIZE_VALUES,
  TEXT_ALIGNMENTS,
  TEXT_COLORS,
  TEXT_VARIANTS,
} from './component-types.js';

// Re-exported so `components.ts` stays the one place that describes the whole DSL for anyone
// reading it top to bottom; the barrel takes the values from `component-types.js` directly.
export * from './component-types.js';

// ============ Shared Enums ============

const gapEnum = z.enum(GAP_VALUES);
const sizeEnum = z.enum(SIZE_VALUES);

// ============ Base Fields ============

/**
 * All properties shared across leaf components (flat for LLM simplicity).
 * Use .describe() to document which component types each property applies to.
 */
const baseFields = {
  // === Form field props (input, select) ===
  name: z.string().optional().describe('input, select: Required field name in form data'),
  formId: z
    .string()
    .optional()
    .describe('input, select: Form ID to associate with (referenced by button submitForm)'),
  placeholder: z.string().optional().describe('input, select: Placeholder text'),
  defaultValue: z.string().optional().describe('input, select: Initial value'),
  disabled: z.boolean().optional().describe('button, input, select: Disabled state'),

  // === Button props ===
  label: z
    .string()
    .optional()
    .describe('button, badge: Required label. input, select, progress: Optional label'),
  action: z.string().optional().describe('button: Required - message sent to agent on click'),
  submitForm: z.string().optional().describe('button: Form ID to collect data from on click'),
  icon: z.string().optional().describe('button: Icon name'),
  parallel: z.boolean().optional().describe('button: Run action in parallel (default: true)'),

  // === Display content props ===
  content: z.string().optional().describe('text: Required text content'),

  // === Variant (polymorphic - different enums per type) ===
  variant: z
    .string()
    .optional()
    .describe(
      `button: ${BUTTON_VARIANTS.join('|')}, ` +
        `input: ${INPUT_VARIANTS.join('|')}, ` +
        `text: ${TEXT_VARIANTS.join('|')}, ` +
        `badge: ${BADGE_VARIANTS.join('|')}, ` +
        `progress: ${PROGRESS_VARIANTS.join('|')}`,
    ),

  // === Size ===
  size: sizeEnum.optional().describe('button: Size'),

  // === Text-specific props ===
  color: z.enum(TEXT_COLORS).optional().describe('text: Text color'),
  textAlign: z.enum(TEXT_ALIGNMENTS).optional().describe('text: Text alignment'),

  // === Progress props ===
  value: z.number().min(0).max(100).optional().describe('progress: Required value 0-100'),
  showValue: z.boolean().optional().describe('progress: Show percentage text'),

  // === Input multiline props ===
  rows: z.number().optional().describe('input: Number of rows (renders as textarea if set)'),

  // === Image props ===
  src: z.string().optional().describe('image: Required source URL'),
  width: z.union([z.number(), z.string()]).optional().describe('image: Width (px or CSS value)'),
  height: z.union([z.number(), z.string()]).optional().describe('image: Height (px or CSS value)'),
  fit: z.enum(['contain', 'cover', 'fill']).optional().describe('image: Object fit mode'),

  // === Select props ===
  options: z
    .array(z.object({ value: z.string(), label: z.string() }))
    .optional()
    .describe('select: Required options array'),
} as const;

// ============ Component Schema (flat, no recursion) ============

/** Single flat component schema — no children, no containers */
export const componentSchema = z.object({
  type: z.enum(COMPONENT_TYPES),
  ...baseFields,
});

// ============ Layout Schema ============

const colsInner = z.union([z.array(z.number().min(0)).min(1), z.coerce.number().int().min(1)]);
// Handle stringified JSON from AI (e.g., "[7,3]" instead of [7,3])
const colsSchema = z.union([
  colsInner,
  z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(colsInner),
]);

/** Component layout — flat array of components with grid layout */
export const componentLayoutSchema = z.object({
  components: z.array(componentSchema),
  cols: colsSchema
    .optional()
    .describe(
      'Columns: number for equal cols (e.g. 2), array for ratio (e.g. [8,2] = 80/20 split). Default: 1',
    ),
  gap: gapEnum.optional().describe('Spacing between components (default: md)'),
});

// ============ Display Content Schema ============

/**
 * Display content schema - for markdown, html, text, table, iframe (no components).
 * Used by create_window and update_window tools.
 */
const displayRendererSchema = z.enum(['markdown', 'html', 'text', 'iframe', 'table']);

const displayDataSchema = z.union([
  z.string().describe('Content string (markdown text, HTML, plain text, or URL for iframe)'),
  z
    .object({
      headers: z.array(z.string()).describe('Column header labels'),
      rows: z.array(z.array(z.string())).describe('Table rows'),
    })
    .describe('Table data (for table renderer only)'),
]);

export const displayContentSchema = z.object({
  renderer: displayRendererSchema.describe('Content renderer type'),
  content: displayDataSchema.describe(
    'String for markdown/html/text/iframe, or { headers, rows } for table',
  ),
});

// ============ Inferred Types ============

/** Component layout: flat array + grid config */
export type ComponentLayout = z.infer<typeof componentLayoutSchema>;

export type DisplayContent = z.infer<typeof displayContentSchema>;
