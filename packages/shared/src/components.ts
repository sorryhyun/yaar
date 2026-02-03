/**
 * Component DSL - Flattened schema for LLM simplicity.
 * All properties at top level with .describe() documenting which types use them.
 */

import { z } from 'zod';

// ============ Shared Enums ============

const gapEnum = z.enum(['none', 'sm', 'md', 'lg']);
const sizeEnum = z.enum(['sm', 'md', 'lg']);

// ============ Component Types ============

const componentTypes = [
  'stack',
  'grid',
  'form',
  'list',
  'button',
  'input',
  'select',
  'text',
  'badge',
  'progress',
  'image',
  'markdown',
  'divider',
  'spacer',
] as const;

// ============ Flattened Component Schema ============

/**
 * Unified component schema - all properties flat for LLM simplicity.
 * Use .describe() to document which component types each property applies to.
 */
const baseComponentSchema = z.object({
  type: z.enum(componentTypes),

  // === Layout props (stack, grid) ===
  direction: z
    .enum(['horizontal', 'vertical'])
    .optional()
    .describe('stack: Layout direction (default: vertical)'),
  gap: gapEnum.optional().describe('stack, grid, form: Spacing between children (default: md)'),
  align: z
    .enum(['start', 'center', 'end', 'stretch'])
    .optional()
    .describe('stack: Cross-axis alignment'),
  columns: z
    .union([z.number(), z.literal('auto')])
    .optional()
    .describe('grid: Number of columns or "auto"'),

  // === Container props (form, list) ===
  id: z.string().optional().describe('form: Required form ID (referenced by button submitForm)'),
  layout: z.enum(['vertical', 'horizontal']).optional().describe('form: Field layout direction'),

  // === Children (recursive) ===
  children: z
    .lazy(() => z.array(componentSchema))
    .optional()
    .describe('stack, grid, form, list: Child components'),

  // === Form field props (input, select) ===
  name: z.string().optional().describe('input, select: Required field name in form data'),
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
  content: z.string().optional().describe('text, markdown: Required text content'),

  // === Variant (polymorphic - different enums per type) ===
  variant: z
    .string()
    .optional()
    .describe(
      'button: primary|secondary|ghost|danger, ' +
        'input: text|email|password|number|url, ' +
        'text: body|heading|subheading|caption|code, ' +
        'badge: default|success|warning|error|info, ' +
        'progress: default|success|warning|error, ' +
        'divider: solid|dashed, ' +
        'list: unordered|ordered'
    ),

  // === Size ===
  size: sizeEnum.optional().describe('button, spacer: Size'),

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
});

// ============ Recursive Schema Definition ============

/**
 * Component schema with recursive children support.
 * Note: We use `as any` cast because the flattened schema intentionally
 * has a simpler structure than the discriminated union types.
 * The LLM sends flat objects; TypeScript types provide stricter discrimination.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const componentSchema: z.ZodType<Component> = baseComponentSchema as any;

/** Component node schema (alias for backward compatibility) */
export const componentNodeSchema = componentSchema;

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

// ============ Discriminated Types for TypeScript ============
// These provide stricter TypeScript types while the schema remains flat

type Gap = 'none' | 'sm' | 'md' | 'lg';
type Size = 'sm' | 'md' | 'lg';

export type StackComponent = {
  type: 'stack';
  direction?: 'horizontal' | 'vertical';
  gap?: Gap;
  align?: 'start' | 'center' | 'end' | 'stretch';
  children: Component[];
};

export type GridComponent = {
  type: 'grid';
  columns?: number | 'auto';
  gap?: Gap;
  children: Component[];
};

export type FormComponent = {
  type: 'form';
  id: string;
  layout?: 'vertical' | 'horizontal';
  gap?: Gap;
  children: Component[];
};

export type ListComponent = {
  type: 'list';
  variant?: 'unordered' | 'ordered';
  children: Component[];
};

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
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  variant?: 'text' | 'email' | 'password' | 'number' | 'url';
  rows?: number; // If set, renders as textarea
  disabled?: boolean;
};

export type SelectComponent = {
  type: 'select';
  name: string;
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

export type MarkdownComponent = {
  type: 'markdown';
  content: string;
};

export type DividerComponent = {
  type: 'divider';
  variant?: 'solid' | 'dashed';
};

export type SpacerComponent = {
  type: 'spacer';
  size?: Size;
};

/** Union of all component types */
export type Component =
  | StackComponent
  | GridComponent
  | FormComponent
  | ListComponent
  | ButtonComponent
  | InputComponent
  | SelectComponent
  | TextComponent
  | BadgeComponent
  | ProgressComponent
  | ImageComponent
  | MarkdownComponent
  | DividerComponent
  | SpacerComponent;

/** Component node (alias for backward compatibility) */
export type ComponentNode = Component;

export type DisplayContent = z.infer<typeof displayContentSchema>;

// ============ Type Guards ============

export function isComponent(node: ComponentNode): node is Component {
  return typeof node === 'object' && node !== null && 'type' in node;
}

export function isStackComponent(node: ComponentNode): node is StackComponent {
  return isComponent(node) && node.type === 'stack';
}

export function isGridComponent(node: ComponentNode): node is GridComponent {
  return isComponent(node) && node.type === 'grid';
}

export function isButtonComponent(node: ComponentNode): node is ButtonComponent {
  return isComponent(node) && node.type === 'button';
}

export function isTextComponent(node: ComponentNode): node is TextComponent {
  return isComponent(node) && node.type === 'text';
}

export function isListComponent(node: ComponentNode): node is ListComponent {
  return isComponent(node) && node.type === 'list';
}

export function isBadgeComponent(node: ComponentNode): node is BadgeComponent {
  return isComponent(node) && node.type === 'badge';
}

export function isProgressComponent(node: ComponentNode): node is ProgressComponent {
  return isComponent(node) && node.type === 'progress';
}

export function isImageComponent(node: ComponentNode): node is ImageComponent {
  return isComponent(node) && node.type === 'image';
}

export function isMarkdownComponent(node: ComponentNode): node is MarkdownComponent {
  return isComponent(node) && node.type === 'markdown';
}

export function isDividerComponent(node: ComponentNode): node is DividerComponent {
  return isComponent(node) && node.type === 'divider';
}

export function isSpacerComponent(node: ComponentNode): node is SpacerComponent {
  return isComponent(node) && node.type === 'spacer';
}

export function isFormComponent(node: ComponentNode): node is FormComponent {
  return isComponent(node) && node.type === 'form';
}

export function isInputComponent(node: ComponentNode): node is InputComponent {
  return isComponent(node) && node.type === 'input';
}

export function isSelectComponent(node: ComponentNode): node is SelectComponent {
  return isComponent(node) && node.type === 'select';
}

// ============ Individual Schema Exports (for backward compatibility) ============

export const stackSchema = z.object({
  type: z.literal('stack'),
  direction: z.enum(['horizontal', 'vertical']).optional(),
  gap: gapEnum.optional(),
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  children: z.lazy(() => z.array(componentSchema)).optional(),
});

export const gridSchema = z.object({
  type: z.literal('grid'),
  columns: z.union([z.number(), z.literal('auto')]).optional(),
  gap: gapEnum.optional(),
  children: z.lazy(() => z.array(componentSchema)).optional(),
});

export const formSchema = z.object({
  type: z.literal('form'),
  id: z.string().describe('Required - referenced by button submitForm'),
  gap: gapEnum.optional(),
  layout: z.enum(['vertical', 'horizontal']).optional(),
  children: z.lazy(() => z.array(componentSchema)).optional(),
});

export const listSchema = z.object({
  type: z.literal('list'),
  variant: z.enum(['unordered', 'ordered']).optional(),
  children: z.lazy(() => z.array(componentSchema)).optional(),
});

export const buttonSchema = z.object({
  type: z.literal('button'),
  label: z.string(),
  action: z.string().describe('Sent as message to agent on click'),
  variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).optional(),
  size: sizeEnum.optional(),
  disabled: z.boolean().optional(),
  icon: z.string().optional(),
  parallel: z.boolean().optional().describe('Run action in parallel (default true)'),
  submitForm: z.string().optional().describe('Form ID to collect data from on click'),
});

export const inputSchema = z.object({
  type: z.literal('input'),
  name: z.string().describe('Required - key in form data'),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  variant: z.enum(['text', 'email', 'password', 'number', 'url']).optional(),
  rows: z.number().optional().describe('If set, renders as textarea'),
  disabled: z.boolean().optional(),
});

export const selectSchema = z.object({
  type: z.literal('select'),
  name: z.string(),
  label: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultValue: z.string().optional(),
  placeholder: z.string().optional(),
  disabled: z.boolean().optional(),
});

export const textComponentSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
  variant: z.enum(['body', 'heading', 'subheading', 'caption', 'code']).optional(),
  color: z.enum(['default', 'muted', 'accent', 'success', 'warning', 'error']).optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
});

export const badgeSchema = z.object({
  type: z.literal('badge'),
  label: z.string(),
  variant: z.enum(['default', 'success', 'warning', 'error', 'info']).optional(),
});

export const progressSchema = z.object({
  type: z.literal('progress'),
  value: z.number().min(0).max(100),
  label: z.string().optional(),
  variant: z.enum(['default', 'success', 'warning', 'error']).optional(),
  showValue: z.boolean().optional(),
});

export const imageSchema = z.object({
  type: z.literal('image'),
  src: z.string(),
  width: z.union([z.number(), z.string()]).optional(),
  height: z.union([z.number(), z.string()]).optional(),
  fit: z.enum(['contain', 'cover', 'fill']).optional(),
});

export const markdownSchema = z.object({
  type: z.literal('markdown'),
  content: z.string(),
});

export const dividerSchema = z.object({
  type: z.literal('divider'),
  variant: z.enum(['solid', 'dashed']).optional(),
});

export const spacerSchema = z.object({
  type: z.literal('spacer'),
  size: sizeEnum.optional(),
});
