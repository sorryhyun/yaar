import { createMemo, createSignal } from '@bundled/solid-js';
import type { PermissionMode, RemoteControlStatus } from './gateway';

export const [status, setStatus] = createSignal<RemoteControlStatus | null>(null);
export const running = createMemo(() => status()?.running ?? false);
/** Set while a start or stop is in flight — the start half includes the user's dialog. */
export const [busy, setBusy] = createSignal(false);
export const [lastError, setLastError] = createSignal('');

export const [sessionName, setSessionName] = createSignal('');
export const [permissionMode, setPermissionMode] = createSignal<PermissionMode>('default');
export const [reattach, setReattach] = createSignal(false);
