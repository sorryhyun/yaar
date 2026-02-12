/**
 * Build a concise environment section for the system prompt.
 *
 * Gives the AI immediate awareness of platform, provider, installed apps,
 * and storage contents — saving tool round-trips.
 */

import { platform } from 'os';
import type { ProviderType } from './types.js';
import { listApps } from '../mcp/apps/discovery.js';
import { storageList } from '../storage/storage-manager.js';
import { IS_BUNDLED_EXE, IS_DEV_EXE } from '../config.js';

function getPlatformName(): string {
  switch (platform()) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    default: return 'Linux';
  }
}

function getProviderName(provider: ProviderType): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

export async function buildEnvironmentSection(provider: ProviderType): Promise<string> {
  const [apps, storage] = await Promise.all([
    listApps().catch(() => []),
    storageList('').catch(() => ({ success: false as const, error: 'unavailable' })),
  ]);

  const lines = [
    `- Platform: ${getPlatformName()}`,
    `- Provider: ${getProviderName(provider)}`,
  ];

  if (IS_BUNDLED_EXE) {
    lines.push(`- Mode: Standalone executable${IS_DEV_EXE ? ' (dev)' : ''}`);
  }

  if (apps.length > 0) {
    lines.push(`- Installed apps: ${apps.map(a => a.id).join(', ')}`);
  }

  if (storage.success && storage.entries && storage.entries.length > 0) {
    const names = storage.entries.map(e => e.path).join(', ');
    lines.push(`- Storage: ${names}`);
  } else {
    lines.push('- Storage: empty');
  }

  return `\n\n## Environment\n${lines.join('\n')}`;
}
