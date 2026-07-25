export type Tab = 'settings' | 'shortcuts' | 'hooks' | 'domains';

export interface Shortcut {
  id: string;
  label: string;
  icon: string;
  iconType?: string;
  target: string;
  folderId?: string;
  createdAt?: number;
}

// Mirrors `packages/server/src/features/config/hooks.ts`. Every filter field is
// `string | string[]` there, and `payload` is a string for `interaction` hooks
// and an OS Action (or array of them) for `os_action` hooks — never a plain
// record. These were narrower than the server for both, which meant a hook the
// server writes routinely did not typecheck as one of ours.
export interface HookFilter {
  verb?: string | string[];
  uri?: string | string[];
  action?: string | string[];
  toolName?: string | string[];
}

export interface HookAction {
  type: string;
  payload?: unknown;
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
