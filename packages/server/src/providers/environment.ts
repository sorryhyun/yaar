/**
 * Build a concise environment section for the system prompt.
 *
 * Gives the AI immediate awareness of platform, provider, installed apps,
 * and storage contents — saving tool round-trips.
 */

import { platform } from 'os';
import type { ProviderType } from './types.js';
import { listApps } from '../mcp/apps/discovery.js';
import { storageList, configRead } from '../storage/storage-manager.js';
import { IS_BUNDLED_EXE, IS_DEV_EXE } from '../config.js';

function getPlatformName(): string {
  switch (platform()) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    default:
      return 'Linux';
  }
}

function getProviderName(provider: ProviderType): string {
  return provider === 'claude' ? 'Claude' : 'Codex';
}

export async function buildEnvironmentSection(provider: ProviderType): Promise<string> {
  const [apps, storage, onboardingResult] = await Promise.all([
    listApps().catch(() => []),
    storageList('').catch(() => ({ success: false as const, error: 'unavailable' })),
    configRead('onboarding.json').catch(() => ({ success: false as const, error: 'unavailable' })),
  ]);

  const lines = [`- Platform: ${getPlatformName()}`, `- Provider: ${getProviderName(provider)}`];

  if (IS_BUNDLED_EXE) {
    lines.push(`- Mode: Standalone executable${IS_DEV_EXE ? ' (dev)' : ''}`);
  }

  const visibleApps = apps.filter((a) => !a.hidden);
  const hiddenApps = apps.filter((a) => a.hidden);

  if (visibleApps.length > 0) {
    lines.push(`- Installed apps: ${visibleApps.map((a) => a.id).join(', ')}`);
  }

  if (storage.success && storage.entries && storage.entries.length > 0) {
    const names = storage.entries.map((e) => e.path).join(', ');
    lines.push(`- Storage: ${names}`);
  } else {
    lines.push('- Storage: empty');
  }

  if (hiddenApps.length > 0) {
    const systemLines = hiddenApps.map((a) => {
      let line = `  - **${a.name}**: ${a.description || a.id}`;
      if (a.isCompiled) line += ` (iframe: /api/apps/${a.id}/static/index.html)`;
      return line;
    });
    lines.push(`- System apps:\n${systemLines.join('\n')}`);
  }

  let onboardingCompleted = false;
  try {
    if (onboardingResult.success && onboardingResult.content) {
      const parsed = JSON.parse(onboardingResult.content);
      onboardingCompleted = parsed.completed === true;
    }
  } catch {
    // Default to false if parsing fails
  }

  let result = `\n\n## Environment\n${lines.join('\n')}`;

  if (!onboardingCompleted) {
    result += `\n\n## Onboarding

This is a new user who hasn't been onboarded yet. When the user first connects:
1. Welcome them warmly to YAAR
2. Briefly explain what YAAR is — an AI-driven desktop where you (the AI) create windows, notifications, and UI dynamically
3. Show them how to browse the app marketplace using the \`market_list\` tool, and help them install interesting apps
4. Once they seem comfortable, call \`complete_onboarding\` to finish the onboarding process

Keep the tone friendly and concise. Don't overwhelm them with too much information at once.`;
  }

  return result;
}
