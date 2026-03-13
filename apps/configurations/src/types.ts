export type Tab = 'settings' | 'shortcuts' | 'hooks';

export interface Shortcut {
  id: string;
  label: string;
  icon: string;
  shortcutType: 'skill' | 'app' | 'url';
  skill?: string;
  appId?: string;
  url?: string;
}

export interface Hook {
  id: string;
  event: string;
  action: string;
  label: string;
}
