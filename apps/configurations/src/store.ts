import { createSignal } from '@bundled/solid-js';
import type { Tab, Shortcut, Hook } from './types';

export const [activeTab, setActiveTab] = createSignal<Tab>('settings');
export const [settings, setSettings] = createSignal<Record<string, unknown>>({});
export const [shortcuts, setShortcuts] = createSignal<Shortcut[]>([]);
export const [hooks, setHooks] = createSignal<Hook[]>([]);
export const [loading, setLoading] = createSignal(false);
export const [toast, setToast] = createSignal<{ msg: string; type: 'success' | 'error' } | null>(null);

export function showToast(msg: string, type: 'success' | 'error' = 'success') {
  setToast({ msg, type });
  setTimeout(() => setToast(null), 3000);
}
