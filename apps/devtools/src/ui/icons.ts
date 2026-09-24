import { ChevronDown, Code, Copy, Eye, Folder, icon, PanelLeft, Upload } from '@bundled/lucide';

// Stroke icons drawn in currentColor, so they take the colour and hover state of
// whatever button or row holds them (emoji render differently on every platform).
// Size and stroke come from `.dt-icon` in base.css.

const ICONS = {
  code: Code,
  eye: Eye,
  upload: Upload,
  folder: Folder,
  copy: Copy,
  chevron: ChevronDown,
  sidebar: PanelLeft,
};

export type IconName = keyof typeof ICONS;

export function Icon(name: IconName, extraClass = '') {
  return icon(ICONS[name], { class: `dt-icon ${extraClass}`.trim() });
}
