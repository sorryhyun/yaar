export {};
import { createSignal } from '@bundled/solid-js';
import type { StorageEntry, StorageSDK, AppSDK } from './types';

// ── Runtime SDK references ─────────────────────────────────────────────
const yaar = (window as unknown as { yaar?: { storage?: StorageSDK; app?: AppSDK } }).yaar;
export const storage = yaar?.storage!;
export const appApi = yaar?.app;

// ── Signals ───────────────────────────────────────────────────────────
export const [currentPath, setCurrentPath] = createSignal('');
export const [entries, setEntries] = createSignal<StorageEntry[]>([]);
export const [mountAliases, setMountAliases] = createSignal<string[]>([]);
export const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
export const [previewContent, setPreviewContent] = createSignal<string | null>(null);
export const [showPreview, setShowPreview] = createSignal(false);
export const [showModal, setShowModal] = createSignal(false);
export const [statusText, setStatusText] = createSignal('Ready');
export const [previewTitleText, setPreviewTitleText] = createSignal('Preview');
export const [previewMetaText, setPreviewMetaText] = createSignal('');

// ── DOM refs ──────────────────────────────────────────────────────────
export let elMountAlias!: HTMLInputElement;
export let elMountHostPath!: HTMLInputElement;
export let elMountReadonly!: HTMLInputElement;
export let elPreviewBody!: HTMLDivElement;

export function setElMountAlias(el: HTMLInputElement) { elMountAlias = el; }
export function setElMountHostPath(el: HTMLInputElement) { elMountHostPath = el; }
export function setElMountReadonly(el: HTMLInputElement) { elMountReadonly = el; }
export function setElPreviewBody(el: HTMLDivElement) { elPreviewBody = el; }
