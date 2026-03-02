import { signal } from '@bundled/yaar';

// ── Reactive signals
export const statsText = signal('0 words • 0 chars • 0 min read');
export const saveStateText = signal('Not saved');
export const focusMode = signal(false);

// ── DOM refs (assigned during mount via ref=)
export let editorEl!: HTMLElement;
export let docTitleEl!: HTMLInputElement;
export let fileInputEl!: HTMLInputElement;
export let formatBlockEl!: HTMLSelectElement;

// Setters for DOM refs (called from main.ts ref= callbacks)
export function setEditorEl(el: HTMLElement) { editorEl = el; }
export function setDocTitleEl(el: HTMLInputElement) { docTitleEl = el; }
export function setFileInputEl(el: HTMLInputElement) { fileInputEl = el; }
export function setFormatBlockEl(el: HTMLSelectElement) { formatBlockEl = el; }
