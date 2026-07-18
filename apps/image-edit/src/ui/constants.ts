import type { Command, Filters } from '../core/doc';
import type { Tool } from '../store';

export const FILTER_CONTROLS: Array<{
  key: keyof Filters;
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'brightness', label: 'Brightness', min: 0, max: 200, step: 1 },
  { key: 'contrast', label: 'Contrast', min: 0, max: 200, step: 1 },
  { key: 'saturation', label: 'Saturation', min: 0, max: 200, step: 1 },
  { key: 'blur', label: 'Blur', min: 0, max: 20, step: 0.1 },
];

export const TOOLS: Array<{ id: Tool; label: string; title: string }> = [
  { id: 'crop', label: 'Crop', title: 'Crop — drag a rectangle on the image' },
  { id: 'wand', label: 'Wand', title: 'Magic wand — click to select a colour region' },
  { id: 'lasso', label: 'Lasso', title: 'Lasso — paint a freehand selection' },
  { id: 'draw', label: 'Draw', title: 'Draw — paint or erase on the image' },
];

// Icon-only, because a row of six labelled transform buttons was most of the
// toolbar's width. The title is the affordance; the glyph is the target.
// Unicode characters directly, not HTML entities: Solid sets interpolated
// strings as textContent, so `&#8634;` would render as literal text.
export const TRANSFORMS: Array<{ icon: string; title: string; cmd: Command }> = [
  { icon: '⟲', title: 'Rotate left 90°', cmd: { type: 'rotate', degrees: -90 } },
  { icon: '⟳', title: 'Rotate right 90°', cmd: { type: 'rotate', degrees: 90 } },
  { icon: '⇆', title: 'Flip horizontal', cmd: { type: 'flip', axis: 'horizontal' } },
  { icon: '⇅', title: 'Flip vertical', cmd: { type: 'flip', axis: 'vertical' } },
];

export const HISTORY_ICONS = { undo: '↶', redo: '↷' } as const;

export const SELECT_MODES: Array<{ id: 'replace' | 'add' | 'subtract'; label: string }> = [
  { id: 'replace', label: 'New' },
  { id: 'add', label: 'Add' },
  { id: 'subtract', label: 'Subtract' },
];
