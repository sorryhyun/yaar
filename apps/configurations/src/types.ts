export type Tab = 'settings' | 'shortcuts' | 'hooks' | 'domains';

export interface Shortcut {
  id: string;
  label: string;
  icon: string;
  iconType?: string;
  target: string;
  createdAt?: number;
}

export interface HookFilter {
  verb?: string;
  uri?: string;
  action?: string | string[];
  toolName?: string;
}

export interface HookAction {
  type: string;
  payload?: Record<string, unknown>;
}

export interface Hook {
  id: string;
  event: string;
  filter?: HookFilter;
  action: HookAction;
  label: string;
  enabled: boolean;
  createdAt?: string;
}

export interface DomainsData {
  allow_all_domains: boolean;
  allowed_domains: string[];
}
