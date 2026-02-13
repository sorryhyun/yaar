/**
 * Component DSL - Flat schema for LLM simplicity.
 * No recursion, no containers. Components are a flat array with grid layout.
 */

import { z } from 'zod';

// ============ Shared Enums ============

const gapEnum = z.enum(['none', 'sm', 'md', 'lg']);
const sizeEnum = z.enum(['sm', 'md', 'lg']);

// ============ Component Types (leaf only) ============

const componentTypes = ['button', 'input', 'select', 'text', 'badge', 'progress', 'image'] as const;

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
      'button: primary|secondary|ghost|danger, ' +
        'input: text|email|password|number|url, ' +
        'text: body|heading|subheading|caption|code, ' +
        'badge: default|success|warning|error|info, ' +
        'progress: default|success|warning|error',
    ),

  // === Size ===
  size: sizeEnum.optional().describe('button: Size'),

  // === Text-specific props ===
  color: z
    .enum(['default', 'muted', 'accent', 'success', 'warning', 'error'])
    .optional()
    .describe('text: Text color'),
  textAlign: z.enum(['left', 'center', 'right']).optional().describe('text: Text alignment'),

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
  type: z.enum(componentTypes),
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
 * Display content schema - for markdown, html, text, iframe (no components).
 * Used by create_window and update_window tools.
 */
export const displayContentSchema = z.object({
  renderer: z.enum(['markdown', 'html', 'text', 'iframe']).describe('Content renderer type'),
  content: z
    .string()
    .describe('Content string (markdown text, HTML, plain text, or URL for iframe)'),
});

// ============ TypeScript Types ============

type Size = 'sm' | 'md' | 'lg';

export type ButtonComponent = {
  type: 'button';
  label: string;
  action: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: Size;
  disabled?: boolean;
  icon?: string;
  parallel?: boolean;
  submitForm?: string;
};

export type InputComponent = {
  type: 'input';
  name: string;
  formId?: string;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  variant?: 'text' | 'email' | 'password' | 'number' | 'url';
  rows?: number;
  disabled?: boolean;
};

export type SelectComponent = {
  type: 'select';
  name: string;
  formId?: string;
  label?: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
};

export type TextComponent = {
  type: 'text';
  content: string;
  variant?: 'body' | 'heading' | 'subheading' | 'caption' | 'code';
  color?: 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error';
  textAlign?: 'left' | 'center' | 'right';
};

export type BadgeComponent = {
  type: 'badge';
  label: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
};

export type ProgressComponent = {
  type: 'progress';
  value: number;
  label?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
  showValue?: boolean;
};

export type ImageComponent = {
  type: 'image';
  src: string;
  width?: number | string;
  height?: number | string;
  fit?: 'contain' | 'cover' | 'fill';
};

/** Union of all component types */
export type Component =
  | ButtonComponent
  | InputComponent
  | SelectComponent
  | TextComponent
  | BadgeComponent
  | ProgressComponent
  | ImageComponent;

/** Component layout: flat array + grid config */
export type ComponentLayout = z.infer<typeof componentLayoutSchema>;

export type DisplayContent = z.infer<typeof displayContentSchema>;

// ============ Type Guards ============

export function isComponent(node: unknown): node is Component {
  return typeof node === 'object' && node !== null && 'type' in node;
}

export function isButtonComponent(node: Component): node is ButtonComponent {
  return node.type === 'button';
}

export function isTextComponent(node: Component): node is TextComponent {
  return node.type === 'text';
}

export function isBadgeComponent(node: Component): node is BadgeComponent {
  return node.type === 'badge';
}

export function isProgressComponent(node: Component): node is ProgressComponent {
  return node.type === 'progress';
}

export function isImageComponent(node: Component): node is ImageComponent {
  return node.type === 'image';
}

export function isInputComponent(node: Component): node is InputComponent {
  return node.type === 'input';
}

export function isSelectComponent(node: Component): node is SelectComponent {
  return node.type === 'select';
}
