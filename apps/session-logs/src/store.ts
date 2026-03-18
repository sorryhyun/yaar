import { createSignal } from '@bundled/solid-js';
import type { SessionSummary, SessionDetail } from './types';

export const [sessions, setSessions] = createSignal<SessionSummary[]>([]);
export const [currentSessionId, setCurrentSessionId] = createSignal<string>('');
export const [selectedId, setSelectedId] = createSignal<string | null>(null);
export const [detail, setDetail] = createSignal<SessionDetail | null>(null);
export const [loading, setLoading] = createSignal(false);
export const [detailLoading, setDetailLoading] = createSignal(false);
export const [search, setSearch] = createSignal('');
export const [error, setError] = createSignal<string | null>(null);
