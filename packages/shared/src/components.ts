/**
 * Component DSL - Single source of truth for schemas, types, and validation.
 * Organized by category with shared base patterns.
 */

import { z } from 'zod';

// ============ Shared Base Patterns ============

const gapEnum = z.enum(['none', 'sm', 'md', 'lg']);

/** Gap with default - LLM doesn't need to specify */
const gapWithDefault = gapEnum.default('md');

// ============ Leaf Component Schemas (non-recursive) ============

const buttonSchema = z.object({
  type: z.literal('button'),
  label: z.string(),
  action: z.string().describe('Sent as message to agent on click'),
  variant: z.enum(['primary', 'secondary', 'ghost', 'danger']).optional(),
  size: z.enum(['sm', 'md', 'lg']).optional(),
  disabled: z.boolean().optional(),
  icon: z.string().optional(),
  parallel: z.boolean().optional().describe('Run action in parallel (default true)'),
  submitForm: z.string().optional().describe('Form ID to collect data from on click'),
});

const inputSchema = z.object({
  type: z.literal('input'),
  name: z.string().describe('Required - key in form data'),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  variant: z.enum(['text', 'email', 'password', 'number', 'url']).optional(),
  disabled: z.boolean().optional(),
});

const textareaSchema = z.object({
  type: z.literal('textarea'),
  name: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  defaultValue: z.string().optional(),
  rows: z.number().optional(),
  disabled: z.boolean().optional(),
});

const selectSchema = z.object({
  type: z.literal('select'),
  name: z.string(),
  label: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })),
  defaultValue: z.string().optional(),
  placeholder: z.string().optional(),
  disabled: z.boolean().optional(),
});

const textComponentSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
  variant: z.enum(['body', 'heading', 'subheading', 'caption', 'code']).optional(),
  color: z.enum(['default', 'muted', 'accent', 'success', 'warning', 'error']).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const badgeSchema = z.object({
  type: z.literal('badge'),
  label: z.string(),
  variant: z.enum(['default', 'success', 'warning', 'error', 'info']).optional(),
});

const progressSchema = z.object({
  type: z.literal('progress'),
  value: z.number().min(0).max(100),
  label: z.string().optional(),
  variant: z.enum(['default', 'success', 'warning', 'error']).optional(),
  showValue: z.boolean().optional(),
});

const alertSchema = z.object({
  type: z.literal('alert'),
  title: z.string().optional(),
  message: z.string().optional().describe('Alert message text'),
  variant: z.enum(['info', 'success', 'warning', 'error']).optional(),
});

const imageSchema = z.object({
  type: z.literal('image'),
  src: z.string(),
  alt: z.string().optional(),
  width: z.union([z.number(), z.string()]).optional(),
  height: z.union([z.number(), z.string()]).optional(),
  fit: z.enum(['contain', 'cover', 'fill']).optional(),
});

const markdownSchema = z.object({
  type: z.literal('markdown'),
  content: z.string(),
});

const dividerSchema = z.object({
  type: z.literal('divider'),
  variant: z.enum(['solid', 'dashed']).optional(),
});

const spacerSchema = z.object({
  type: z.literal('spacer'),
  size: z.enum(['sm', 'md', 'lg']).optional(),
});

// ============ Recursive Types (defined first for schema typing) ============

type StackComponentType = {
  type: 'stack';
  /** @default 'vertical' */
  direction?: 'horizontal' | 'vertical';
  /** @default 'md' */
  gap?: 'none' | 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  children: ComponentNodeType[];
};

type GridComponentType = {
  type: 'grid';
  columns?: number | 'auto';
  /** @default 'md' */
  gap?: 'none' | 'sm' | 'md' | 'lg';
  children: ComponentNodeType[];
};

type FormComponentType = {
  type: 'form';
  id: string;
  children: ComponentNodeType[];
  layout?: 'vertical' | 'horizontal';
  /** @default 'md' */
  gap?: 'none' | 'sm' | 'md' | 'lg';
};

type ListComponentType = {
  type: 'list';
  variant?: 'unordered' | 'ordered';
  children: ComponentNodeType[];
};

/** Union of all component types */
type ComponentType =
  | StackComponentType
  | GridComponentType
  | FormComponentType
  | ListComponentType
  | z.infer<typeof buttonSchema>
  | z.infer<typeof inputSchema>
  | z.infer<typeof textareaSchema>
  | z.infer<typeof selectSchema>
  | z.infer<typeof textComponentSchema>
  | z.infer<typeof badgeSchema>
  | z.infer<typeof progressSchema>
  | z.infer<typeof alertSchema>
  | z.infer<typeof imageSchema>
  | z.infer<typeof markdownSchema>
  | z.infer<typeof dividerSchema>
  | z.infer<typeof spacerSchema>;

/** Component node - always an object (no string shorthand for LLM clarity) */
type ComponentNodeType = ComponentType;

// ============ Recursive Schemas (using z.lazy) ============

/** Component node schema - objects only (no string shorthand for LLM clarity) */
const componentNodeSchema: z.ZodType<ComponentNodeType> = z.lazy(() => componentSchema);

// Layout schemas (with children)
const stackSchema = z.object({
  type: z.literal('stack'),
  direction: z.enum(['horizontal', 'vertical']).default('vertical'),
  gap: gapWithDefault,
  align: z.enum(['start', 'center', 'end', 'stretch']).optional(),
  justify: z.enum(['start', 'center', 'end', 'between', 'around']).optional(),
  wrap: z.boolean().optional(),
  children: z.array(componentNodeSchema),
});

const gridSchema = z.object({
  type: z.literal('grid'),
  columns: z.union([z.number(), z.literal('auto')]).optional(),
  gap: gapWithDefault,
  children: z.array(componentNodeSchema),
});

const formSchema = z.object({
  type: z.literal('form'),
  id: z.string().describe('Required - referenced by button submitForm'),
  gap: gapWithDefault,
  layout: z.enum(['vertical', 'horizontal']).optional(),
  children: z.array(componentNodeSchema),
});

const listSchema = z.object({
  type: z.literal('list'),
  variant: z.enum(['unordered', 'ordered']).optional(),
  children: z.array(componentNodeSchema).describe('List items'),
});

// ============ Organized by Category ============

const layoutSchemas = [stackSchema, gridSchema] as const;
const containerSchemas = [formSchema, listSchema] as const;
const displaySchemas = [
  textComponentSchema,
  badgeSchema,
  progressSchema,
  alertSchema,
  imageSchema,
  markdownSchema,
  dividerSchema,
  spacerSchema,
] as const;
const inputSchemas = [buttonSchema, inputSchema, textareaSchema, selectSchema] as const;

// ============ Union Schema ============

const componentSchema: z.ZodType<ComponentType> = z.discriminatedUnion('type', [
  ...layoutSchemas,
  ...containerSchemas,
  ...displaySchemas,
  ...inputSchemas,
]);

/**
 * Display content schema - for markdown, html, text, iframe (no components).
 * Used by create_window and update_window tools.
 */
const displayContentSchema = z.object({
  renderer: z.enum(['markdown', 'html', 'text', 'iframe']).describe('Content renderer type'),
  content: z.string().describe('Content string (markdown text, HTML, plain text, or URL for iframe)'),
});

// ============ Exported Types ============

// Leaf types (inferred from schemas)
export type ButtonComponent = z.infer<typeof buttonSchema>;
export type InputComponent = z.infer<typeof inputSchema>;
export type TextareaComponent = z.infer<typeof textareaSchema>;
export type SelectComponent = z.infer<typeof selectSchema>;
export type TextComponent = z.infer<typeof textComponentSchema>;
export type BadgeComponent = z.infer<typeof badgeSchema>;
export type ProgressComponent = z.infer<typeof progressSchema>;
export type AlertComponent = z.infer<typeof alertSchema>;
export type ImageComponent = z.infer<typeof imageSchema>;
export type MarkdownComponent = z.infer<typeof markdownSchema>;
export type DividerComponent = z.infer<typeof dividerSchema>;
export type SpacerComponent = z.infer<typeof spacerSchema>;

// Recursive types (manually defined due to z.lazy)
export type StackComponent = StackComponentType;
export type GridComponent = GridComponentType;
export type FormComponent = FormComponentType;
export type ListComponent = ListComponentType;

export type Component = ComponentType;
export type ComponentNode = ComponentNodeType;
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

export function isAlertComponent(node: ComponentNode): node is AlertComponent {
  return isComponent(node) && node.type === 'alert';
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

export function isTextareaComponent(node: ComponentNode): node is TextareaComponent {
  return isComponent(node) && node.type === 'textarea';
}

export function isSelectComponent(node: ComponentNode): node is SelectComponent {
  return isComponent(node) && node.type === 'select';
}


// ============ Schema Exports ============

export { componentNodeSchema, componentSchema, displayContentSchema };

export {
  stackSchema,
  gridSchema,
  buttonSchema,
  formSchema,
  inputSchema,
  textareaSchema,
  selectSchema,
  textComponentSchema,
  listSchema,
  badgeSchema,
  progressSchema,
  alertSchema,
  imageSchema,
  markdownSchema,
  dividerSchema,
  spacerSchema,
};
