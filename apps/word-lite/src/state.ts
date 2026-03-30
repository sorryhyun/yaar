import { createSignal } from '@bundled/solid-js';

// ── Reactive signals
export const [statsText, setStatsText] = createSignal('0 words • 0 chars • 0 min read');
export const [saveStateText, setSaveStateText] = createSignal('Not saved');
export const [focusMode, setFocusMode] = createSignal(false);

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
