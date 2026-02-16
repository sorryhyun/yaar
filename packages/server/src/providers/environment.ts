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
import { readSettings, getLanguageLabel } from '../storage/settings.js';
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
  const [apps, storage, settings] = await Promise.all([
    listApps().catch(() => []),
    storageList('').catch(() => ({ success: false as const, error: 'unavailable' })),
    readSettings(),
  ]);

  const lines = [`- Platform: ${getPlatformName()}`, `- Provider: ${getProviderName(provider)}`];
  lines.push(`- Language: ${getLanguageLabel(settings.language)} (${settings.language})`);

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
      if (a.variant && a.variant !== 'standard') {
        line += ` [${a.variant}${a.dockEdge ? `:${a.dockEdge}` : ''}]`;
      }
      return line;
    });
    lines.push(`- System apps:\n${systemLines.join('\n')}`);
  }

  let result = `\n\n## Environment\n${lines.join('\n')}`;

  if (!settings.onboardingCompleted) {
    result += `\n\n## Onboarding

The user has a "Start" 🚀 icon on their desktop. When they click it, you will receive a \`<user_interaction:click>app: onboarding</user_interaction:click>\` message. Do NOT proactively welcome the user or start onboarding on connect — wait for that click. When you receive it, respond by:
1. Welcoming them to YAAR
2. Briefly explaining what YAAR is — an AI-driven desktop where you (the AI) create windows, notifications, and UI dynamically
3. Asking their preferred language and calling \`set_config\` with section "settings" to set it if not English
4. Showing them the app marketplace using the \`market_list\` tool, and helping them install interesting apps
5. Calling \`set_config\` with section "settings" and \`onboardingCompleted: true\` when they seem comfortable

Keep the tone friendly and concise. Don't overwhelm them with too much information at once.`;
  }

  return result;
}
