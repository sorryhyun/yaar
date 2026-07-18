// ── Constants ────────────────────────────────────────────────────────────────

import type { Account } from './types.js';

export const STORAGE_DOMAIN_KEY = 'market_apps/domain.txt';
export const DEFAULT_MARKET_DOMAIN = 'https://yaarmarket.vercel.app';

export const SIGNED_OUT_ACCOUNT: Account = {
  configured: false,
  signedIn: false,
  email: null,
  pending: false,
  ownedApps: [],
};
