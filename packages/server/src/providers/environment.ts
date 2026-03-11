/**
 * Build a concise environment section for the system prompt.
 *
 * Gives the AI immediate awareness of platform, provider, installed apps,
 * and storage contents — saving tool round-trips.
 */

import { platform } from 'os';
import type { ProviderType } from './types.js';
import { listApps } from '../features/apps/discovery.js';
import { storageList } from '../storage/storage-manager.js';
import { loadMounts } from '../storage/mounts.js';
import { readSettings, getLanguageLabel } from '../storage/settings.js';
import { IS_BUNDLED_EXE } from '../config.js';

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
  if (settings.userName) lines.push(`- User: ${settings.userName}`);
  lines.push(`- Language: ${getLanguageLabel(settings.language)} (${settings.language})`);

  if (IS_BUNDLED_EXE) {
    lines.push('- Mode: Standalone executable');
  }

  if (apps.length > 0) {
    const appLines = apps.map((a) => {
      let line = `  - **${a.name}** (${a.id}): ${a.description || 'No description'}`;
      if (a.isCompiled) line += ` (iframe: yaar://apps/${a.id})`;
      if (a.variant && a.variant !== 'standard') {
        line += ` [${a.variant}${a.dockEdge ? `:${a.dockEdge}` : ''}]`;
      }
      if (a.createShortcut === false) line += ' [system]';
      return line;
    });
    lines.push(`- Installed apps:\n${appLines.join('\n')}`);
  }

  if (storage.success && storage.entries && storage.entries.length > 0) {
    const names = storage.entries.map((e) => e.path).join(', ');
    lines.push(`- Storage: ${names}`);
  } else {
    lines.push('- Storage: empty');
  }

  const mounts = await loadMounts();
  if (mounts.length > 0) {
    const mountLines = mounts.map(
      (m) => `  - mounts/${m.alias}/ \u2192 ${m.hostPath}${m.readOnly ? ' (read-only)' : ''}`,
    );
    lines.push(`- Mounts:\n${mountLines.join('\n')}`);
  }

  let result = `\n\n## Environment\n${lines.join('\n')}`;

  if (!settings.onboardingCompleted) {
    result += `\n\n## Onboarding

The user has a "Start" 🚀 icon on their desktop. When they click it, you will receive a \`<ui:click>app: onboarding</ui:click>\` message. Do NOT proactively welcome the user or start onboarding on connect — wait for that click. When you receive it, respond by:
1. Welcoming them to YAAR and briefly explaining what YAAR is — an AI-driven desktop where you (the AI) create windows, notifications, and UI dynamically
2. Using \`invoke('yaar://sessions/current/prompts', ...)\` to ask structured questions. Use the "ask" action for choices and "request" action for text input. Ask these one at a time (wait for each answer before the next):
   - **Name**: Use "request" action to ask for their name/nickname (title: "What should I call you?"). Save it via \`config:set\` with section "settings" and \`userName\`.
   - **Language**: Use "ask" action with language options relevant to their locale. Set the language via \`config:set\` with section "settings" if not English.
3. Showing them the app marketplace using \`list('yaar://market')\`, and helping them install interesting apps
4. Asking if they want to set up any hooks — event-driven automations that fire on specific triggers (e.g., showing a toast when the AI compiles an app). If interested, help them configure hooks via \`invoke('yaar://config/hooks/{id}', { hook })\`. Keep it simple — suggest one or two practical examples rather than explaining all options.
5. Calling \`config:set\` with section "settings" and \`onboardingCompleted: true\` when they seem comfortable

The user prompt dialogs provide a polished UI for collecting answers — use them instead of asking questions in plain chat text. Keep the tone friendly and concise. Don't overwhelm them with too much information at once.`;
  }

  return result;
}
