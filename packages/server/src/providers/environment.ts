/**
 * Build a concise environment section for the system prompt.
 *
 * Gives the AI immediate awareness of platform, provider, installed apps,
 * and storage contents — saving tool round-trips.
 */

import { platform } from 'os';
import type { ProviderType } from './types.js';
import { listApps, loadAllAppHints } from '../features/apps/discovery.js';
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
  const [apps, storage, settings, appHints] = await Promise.all([
    listApps().catch(() => []),
    storageList('').catch(() => ({ success: false as const, error: 'unavailable' })),
    readSettings(),
    loadAllAppHints().catch(() => []),
  ]);

  const lines = [`- Platform: ${getPlatformName()}`, `- Provider: ${getProviderName(provider)}`];
  if (settings.userName) lines.push(`- User: ${settings.userName}`);
  lines.push(`- Language: ${getLanguageLabel(settings.language)} (${settings.language})`);

  if (IS_BUNDLED_EXE) {
    lines.push('- Mode: Standalone executable');
  }

  if (apps.length > 0) {
    const appLines = [...apps]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => {
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

  if (appHints.length > 0) {
    const hintLines = [...appHints]
      .sort((a, b) => (a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0))
      .map((h) => `### ${h.appId}\n${h.hint.trim()}`)
      .join('\n\n');
    lines.push(`- App hints:\n${hintLines}`);
  }

  if (storage.success && storage.entries && storage.entries.length > 0) {
    const names = storage.entries
      .map((e) => e.path)
      .sort()
      .join(', ');
    lines.push(`- Storage: ${names}`);
  } else {
    lines.push('- Storage: empty');
  }

  const mounts = await loadMounts();
  if (mounts.length > 0) {
    const mountLines = [...mounts]
      .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0))
      .map((m) => `  - mounts/${m.alias}/ \u2192 ${m.hostPath}${m.readOnly ? ' (read-only)' : ''}`);
    lines.push(`- Mounts:\n${mountLines.join('\n')}`);
  }

  let result = `\n\n## Environment\n${lines.join('\n')}`;

  if (provider === 'codex') {
    // Codex tends to "check on" a sub-agent after handing off by polling
    // yaar://session/agents. That namespace is session-principal only (refused
    // for the monitor) and is not how results come back — the hook is. Steer it
    // to the hook: "response" path instead. Claude already reliably uses hooks,
    // so this reinforcement is Codex-only.
    result += `\n\n## Getting results back from sub-agents (use hooks, not yaar://session/agents)

When you hand work to an app or window agent, pass \`hook: "response"\` in the invoke:
\`invoke('yaar://windows/{id}', { action: "message", message: "...", hook: "response" })\`.
The system then delivers that agent's result to you as a single \`<agent-hook>\` message when it finishes. Wait for it and act on it — that message **is** the handoff.

Do **not** poll or relay through \`yaar://session/agents\` to find out what a sub-agent did. That namespace is refused for you (session-principal only) and is not how results are returned.`;
  }

  if (!settings.onboardingCompleted) {
    result += `\n\n## Onboarding

The user has a "Start" 🚀 icon on their desktop. When they click it, you will receive a \`<ui:click>app: onboarding</ui:click>\` message. Do NOT proactively welcome the user or start onboarding on connect — wait for that click. When you receive it, respond by:
1. Welcoming them to YAAR and briefly explaining what YAAR is — an AI-driven desktop where you (the AI) create windows, notifications, and UI dynamically
2. Using \`invoke('yaar://user/prompts', ...)\` to ask structured questions. Use the "ask" action for choices and "request" action for text input. Ask these one at a time (wait for each answer before the next):
   - **Name**: Use "request" action to ask for their name/nickname (title: "What should I call you?"). Save it via \`config:set\` with section "settings" and \`userName\`.
   - **Language**: Use "ask" action with language options relevant to their locale (likely Korean or English). Set the language via \`config:set\` with section "settings" if not English.
3. Making the essential apps launchable. YAAR's core apps are **already bundled** and cannot be installed (an install call on one fails). Give the user desktop icons for them with \`invoke('yaar://config/shortcuts', { label, icon, target: 'yaar://apps/{appId}' })\` — recommended: market-apps (🛒), configurations (⚙️), mcp-manager (🔌). Some bundled apps (browser, storage, search) open contextually and set \`createShortcut: false\` — skip those unless asked. To go beyond the bundled set, read the marketplace skill via \`read('yaar://skills/marketplace')\`, browse with \`invoke('yaar://http', { url: '...' })\`, and install *additional* apps with \`invoke('yaar://apps/{appId}', { action: 'install' })\`.
4. Calling \`config:set\` with section "settings" and \`onboardingCompleted: true\` when they seem comfortable

The user prompt dialogs provide a polished UI for collecting answers — use them instead of asking questions in plain chat text. Keep the tone friendly and concise. Don't overwhelm them with too much information at once.`;
  }

  return result;
}
