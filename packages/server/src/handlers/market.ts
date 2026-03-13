/**
 * Marketplace domain handlers for the verb layer.
 *
 * Maps marketplace operations to the verb layer:
 *
 *   list('yaar://market')                             → browse marketplace apps
 *   invoke('yaar://market', { action: 'install', appId })  → install app by ID
 *   read('yaar://market/{appId}')                     → get details for a marketplace app
 *   invoke('yaar://market/{appId}', { action: 'install' }) → install app (appId from URI)
 */

import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri } from './uri-resolve.js';
import { ok, error, extractIdFromUri } from './utils.js';
import { installApp } from './apps.js';
import { MARKET_URL } from '../config.js';

interface MarketApp {
  id: string;
  name: string;
  icon: string;
  description: string;
  version: string;
  author: string;
}

async function fetchMarketList(): Promise<VerbResult> {
  const res = await fetch(`${MARKET_URL}/api/apps`);
  if (!res.ok) return error(`Failed to fetch marketplace (${res.status})`);
  const data = (await res.json()) as { apps: MarketApp[] };
  if (!data.apps?.length) return ok('No apps available in the marketplace.');
  const lines = data.apps.map(
    (app) =>
      `- ${app.icon} **${app.name}** (${app.id}) v${app.version}\n  ${app.description} — by ${app.author}`,
  );
  return ok(`Marketplace apps:\n${lines.join('\n')}`);
}

async function fetchMarketApp(appId: string): Promise<VerbResult> {
  const res = await fetch(`${MARKET_URL}/api/apps/${appId}`);
  if (!res.ok) {
    if (res.status === 404) return error(`App "${appId}" not found in the marketplace.`);
    return error(`Failed to fetch app details (${res.status})`);
  }
  const app = (await res.json()) as MarketApp;
  return ok(
    `${app.icon} **${app.name}** (${app.id}) v${app.version}\n${app.description}\nAuthor: ${app.author}`,
  );
}

export function registerMarketHandlers(registry: ResourceRegistry): void {
  // ── yaar://market — browse and install from marketplace (exact match) ──
  const marketHandler: ResourceHandler = {
    description: 'App marketplace. List to browse available apps, invoke to install by appId.',
    verbs: ['describe', 'list', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action', 'appId'],
      properties: {
        action: { type: 'string', enum: ['install'] },
        appId: { type: 'string', description: 'App ID to install' },
      },
    },

    async list(): Promise<VerbResult> {
      return fetchMarketList();
    },

    async invoke(_resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (payload?.action !== 'install') return error('Only "install" action is supported.');
      if (!payload.appId) return error('"appId" is required.');
      return installApp(payload.appId as string);
    },
  };
  registry.register('yaar://market', marketHandler);

  // ── yaar://market/{appId} — per-app marketplace details ──
  registry.register('yaar://market/*', {
    description: 'A specific marketplace app. Read for details, invoke to install.',
    verbs: ['describe', 'read', 'invoke'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['install'] },
      },
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      const appId = extractIdFromUri(resolved.sourceUri, 'market');
      if (!appId) return error('App ID required.');
      return fetchMarketApp(appId);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      if (payload?.action !== 'install') return error('Only "install" action is supported.');
      const appId = extractIdFromUri(resolved.sourceUri, 'market');
      if (!appId) return error('App ID required.');
      return installApp(appId);
    },
  });
}
