export {};
import { signal } from '@bundled/yaar';
import type { StorageEntry, StorageSDK, AppSDK } from './types';

// ── Runtime SDK references ─────────────────────────────────────────────
const yaar = (window as unknown as { yaar?: { storage?: StorageSDK; app?: AppSDK } }).yaar;
export const storage = yaar?.storage!;
export const appApi = yaar?.app;

// ── Signals ───────────────────────────────────────────────────────────
export const currentPath = signal('');
export const entries = signal<StorageEntry[]>([]);
export const mountAliases = signal<string[]>([]);
export const selectedFile = signal<string | null>(null);
export const previewContent = signal<string | null>(null);
export const showPreview = signal(false);
export const showModal = signal(false);
export const statusText = signal('Ready');
export const previewTitleText = signal('Preview');
export const previewMetaText = signal('');

// ── DOM refs ──────────────────────────────────────────────────────────
export let elMountAlias!: HTMLInputElement;
export let elMountHostPath!: HTMLInputElement;
export let elMountReadonly!: HTMLInputElement;
export let elPreviewBody!: HTMLDivElement;

export function setElMountAlias(el: HTMLInputElement) { elMountAlias = el; }
export function setElMountHostPath(el: HTMLInputElement) { elMountHostPath = el; }
export function setElMountReadonly(el: HTMLInputElement) { elMountReadonly = el; }
export function setElPreviewBody(el: HTMLDivElement) { elPreviewBody = el; }
