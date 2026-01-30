/**
 * Component DSL - Typed components for rich UI rendering.
 *
 * The AI generates JSON conforming to these types, and the frontend
 * renders them as interactive React components.
 */

// ============ Component Types ============

export interface CardComponent {
  type: 'card';
  title?: string;
  subtitle?: string;
  content: ComponentNode;
  actions?: ComponentNode;
  variant?: 'default' | 'outlined' | 'elevated';
}

export interface StackComponent {
  type: 'stack';
  direction?: 'horizontal' | 'vertical';
  gap?: 'none' | 'sm' | 'md' | 'lg';
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between' | 'around';
  wrap?: boolean;
  children: ComponentNode[];
}

export interface GridComponent {
  type: 'grid';
  columns?: number | 'auto';
  gap?: 'none' | 'sm' | 'md' | 'lg';
  children: ComponentNode[];
}

export interface ButtonComponent {
  type: 'button';
  label: string;
  action: string; // Sent as message to agent on click
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  icon?: string;
  parallel?: boolean; // Actions run in parallel by default; set to false for sequential
}

export interface TextComponent {
  type: 'text';
  content: string;
  variant?: 'body' | 'heading' | 'subheading' | 'caption' | 'code';
  color?: 'default' | 'muted' | 'accent' | 'success' | 'warning' | 'error';
  align?: 'left' | 'center' | 'right';
}

export interface ListComponent {
  type: 'list';
  variant?: 'unordered' | 'ordered';
  items: ComponentNode[];
}

export interface BadgeComponent {
  type: 'badge';
  label: string;
  variant?: 'default' | 'success' | 'warning' | 'error' | 'info';
}

export interface ProgressComponent {
  type: 'progress';
  value: number; // 0-100
  label?: string;
  variant?: 'default' | 'success' | 'warning' | 'error';
  showValue?: boolean;
}

export interface AlertComponent {
  type: 'alert';
  title?: string;
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
}

export interface ImageComponent {
  type: 'image';
  src: string;
  alt?: string;
  width?: number | string;
  height?: number | string;
  fit?: 'contain' | 'cover' | 'fill';
}

export interface MarkdownComponent {
  type: 'markdown';
  content: string;
}

export interface DividerComponent {
  type: 'divider';
  variant?: 'solid' | 'dashed';
}

export interface SpacerComponent {
  type: 'spacer';
  size?: 'sm' | 'md' | 'lg';
}

// ============ Union Type ============

export type Component =
  | CardComponent
  | StackComponent
  | GridComponent
  | ButtonComponent
  | TextComponent
  | ListComponent
  | BadgeComponent
  | ProgressComponent
  | AlertComponent
  | ImageComponent
  | MarkdownComponent
  | DividerComponent
  | SpacerComponent;

/**
 * ComponentNode can be a component object or a plain string (text shorthand).
 */
export type ComponentNode = Component | string;

// ============ Type Guards ============

export function isComponent(node: ComponentNode): node is Component {
  return typeof node === 'object' && node !== null && 'type' in node;
}

export function isCardComponent(node: ComponentNode): node is CardComponent {
  return isComponent(node) && node.type === 'card';
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
