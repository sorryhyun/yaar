export type Tab = 'settings' | 'shortcuts' | 'hooks' | 'domains' | 'updates';

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
// record.
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

// Mirrors `UpdateStatus` in `packages/server/src/features/update/updater.ts`, which is
// the only thing that decides any of it — this app renders the answer, it does not
// re-derive it. Keep the two in step when the server's shape grows.
export interface UpdateProgress {
  stage: 'idle' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error';
  detail?: string;
  /** 0..1 for the current download; absent when the step has no measurable size. */
  fraction?: number;
  targetVersion?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

// Mirrors `ChildProcessLimitStatus` in
// `packages/server/src/features/android/child-process-limit.ts`, plus `platform`.
export interface AndroidStatus {
  platform: string;
  restrictions: 'not-applicable' | 'disabled' | 'enabled' | 'unknown';
  sdk?: number;
  maxMonitors: number;
}

export interface UpdateStatus {
  current: string;
  bundled: boolean;
  platform: string;
  arch: string;
  asset: string | null;
  canInstall: boolean;
  blockedReason?: 'source-checkout' | 'unsupported-platform' | 'no-asset';
  latest?: {
    version: string;
    tag: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string | null;
    updateAvailable: boolean;
    assetMissing: boolean;
  };
  checkedAt?: number;
  checkError?: string;
  progress: UpdateProgress;
}
