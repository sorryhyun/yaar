import { createSignal } from '@bundled/solid-js';
import { createSharedSignal } from '@bundled/yaar';
import type { Tab, Shortcut, Hook } from './types';

// Which tab is showing is view state a command (openTab/nextTab/prevTab) drives —
// every copy of the window must follow the agent to the same tab.
export const [activeTab, setActiveTab] = createSharedSignal<Tab>('activeTab', 'settings');
export const [settings, setSettings] = createSignal<Record<string, unknown>>({});
export const [shortcuts, setShortcuts] = createSignal<Shortcut[]>([]);
export const [hooks, setHooks] = createSignal<Hook[]>([]);
export const [loading, setLoading] = createSignal(false);
export { showToast } from '@bundled/yaar';
