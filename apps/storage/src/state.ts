export {};
import { createStore } from '@bundled/solid-js/store';
import type { StorageEntry } from './types';

export const [state, setState] = createStore({
  currentPath: '',
  entries: [] as StorageEntry[],
  mountAliases: [] as string[],
  selectedFile: null as string | null,
  previewContent: null as string | null,
  showPreview: false,
  showModal: false,
  statusText: 'Ready',
  previewTitleText: 'Preview',
  previewMetaText: '',
});

// ── DOM refs ──────────────────────────────────────────────────────────
export let elMountAlias!: HTMLInputElement;
export let elMountHostPath!: HTMLInputElement;
export let elMountReadonly!: HTMLInputElement;
export let elPreviewBody!: HTMLDivElement;

export function setElMountAlias(el: HTMLInputElement) { elMountAlias = el; }
export function setElMountHostPath(el: HTMLInputElement) { elMountHostPath = el; }
export function setElMountReadonly(el: HTMLInputElement) { elMountReadonly = el; }
export function setElPreviewBody(el: HTMLDivElement) { elPreviewBody = el; }
