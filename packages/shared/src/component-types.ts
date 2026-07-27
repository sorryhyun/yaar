/**
 * Component DSL — the Zod-free half.
 *
 * Everything here is plain TypeScript: the canonical enum value lists, the narrow per-component
 * types the renderers pattern-match on, and the one lightweight runtime guard. `components.ts`
 * builds the Zod schemas on top of these.
 *
 * The split exists so the frontend can import the DSL without pulling Zod into its bundle — the
 * package barrel (`index.ts`) re-exports *this* file's values, and only `@yaar/shared/schemas`
 * reaches the schemas. See `CLAUDE.md` → Export Strategy.
 */

// ============ Canonical Enum Values ============
// Single source of truth for the DSL enum value lists. The Zod schemas in `components.ts` derive
// from these arrays (via z.enum), and the hand-written component types below are bound to them via
// `satisfies` checks. The frontend ComponentRenderer imports these instead of re-declaring.

export const GAP_VALUES = ['none', 'sm', 'md', 'lg'] as const;
export const SIZE_VALUES = ['sm', 'md', 'lg'] as const;
export const BUTTON_VARIANTS = [
  'primary',
  'secondary',
  'ghost',
  'danger',
] as const satisfies readonly NonNullable<ButtonComponent['variant']>[];
export const INPUT_VARIANTS = [
  'text',
  'email',
  'password',
  'number',
  'url',
] as const satisfies readonly NonNullable<InputComponent['variant']>[];
export const TEXT_VARIANTS = [
  'body',
  'heading',
  'subheading',
  'caption',
  'code',
] as const satisfies readonly NonNullable<TextComponent['variant']>[];
export const TEXT_COLORS = [
  'default',
  'muted',
  'accent',
  'success',
  'warning',
  'error',
] as const satisfies readonly NonNullable<TextComponent['color']>[];
export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const satisfies readonly NonNullable<
  TextComponent['textAlign']
>[];
export const BADGE_VARIANTS = [
  'default',
  'success',
  'warning',
  'error',
  'info',
] as const satisfies readonly NonNullable<BadgeComponent['variant']>[];
export const PROGRESS_VARIANTS = [
  'default',
  'success',
  'warning',
  'error',
] as const satisfies readonly NonNullable<ProgressComponent['variant']>[];

/** Component types the DSL admits (leaf only — no recursion, no containers). */
export const COMPONENT_TYPES = [
  'button',
  'input',
  'select',
  'text',
  'badge',
  'progress',
  'image',
] as const;

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

// ============ Type Guards ============

export function isComponent(node: unknown): node is Component {
  return typeof node === 'object' && node !== null && 'type' in node;
}
