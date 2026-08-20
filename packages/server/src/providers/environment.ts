/**
 * Build a concise environment section for the system prompt.
 *
 * Gives the AI immediate awareness of platform, provider, and installed apps —
 * saving tool round-trips.
 *
 * What earns a place here is a fact with **no other pointer in the prompt**. The
 * app roster qualifies: nothing else makes an agent prefer opening an app over
 * hand-building the UI itself, and the failure is silent when it is missing.
 * Storage and mounts do not, and used to be here anyway:
 *
 *  - The storage root listing is reachable by `list('yaar://storage/')`, and the
 *    URI namespace table in `profiles/prompts/uri-namespaces.md` already names that door.
 *  - Mounts sit one level below it at `storage/mounts`, and have two pointers:
 *    `storageList('')` injects a virtual `mounts` entry at the root whenever any
 *    mount exists, and `read('yaar://config/mounts')` returns the full record —
 *    including the `hostPath` this section used to print into every single turn.
 *
 * Both were deferred to those doors. The rule for anything added back: state the
 * pointer that already exists, or explain why there is none.
 */

import { platform } from 'os';
import type { ProviderType } from './types.js';
import { listApps, loadAllAppHints, type AppInfo } from '../features/apps/discovery.js';
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

/** Sort helper — app ids and hint ids are both ordered by id. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The facts about an app that only this section carries.
 *
 * `list('yaar://apps')` returns id/name/description/kind/version, so an agent can
 * recover those on demand and they are not what these bytes buy. It does **not**
 * carry `isCompiled` — and `kind` is criticality (`system` vs `app`), not
 * compiled-ness — so whether an app can be opened as an iframe window at all is
 * otherwise reachable only by reading every app one at a time.
 */
function appSuffix(a: AppInfo): string {
  let suffix = '';
  if (a.isCompiled) suffix += ` (iframe: yaar://apps/${a.id})`;
  if (a.variant && a.variant !== 'standard') {
    suffix += ` [${a.variant}${a.dockEdge ? `:${a.dockEdge}` : ''}]`;
  }
  if (a.createShortcut === false) suffix += ' [system]';
  return suffix;
}

/**
 * The app roster and the hints, merged so that **an app is stated once, not twice**.
 *
 * A hint supersedes a description as a selection signal — it says *when* the app
 * fits — so a hinted app appears only under App hints, and the roster carries the
 * rest. That is where the saving is: the two blocks used to restate every hinted
 * app's name and description in full.
 *
 * The blocks are therefore disjoint, which makes neither complete on its own, and
 * an agent reading a partial roster as exhaustive would conclude an installed app
 * is not installed and go build the UI by hand. So the roster says the hint block
 * holds more, and the hint block says its apps are installed. Exported and pure so
 * that this property is testable without a filesystem — see `app-environment.test.ts`.
 */
export function buildAppSections(
  apps: AppInfo[],
  appHints: { appId: string; hint: string }[],
): string[] {
  const lines: string[] = [];
  const hintById = new Map(appHints.map((h) => [h.appId, h.hint]));
  const appById = new Map(apps.map((a) => [a.id, a]));

  const unhinted = [...apps].filter((a) => !hintById.has(a.id)).sort(byId);
  if (unhinted.length > 0) {
    const appLines = unhinted.map(
      (a) => `  - **${a.name}** (${a.id}): ${a.description || 'No description'}${appSuffix(a)}`,
    );
    const more = appHints.length > 0 ? ' (the apps under "App hints" below are installed too)' : '';
    lines.push(`- Installed apps${more}:\n${appLines.join('\n')}`);
  }

  if (appHints.length > 0) {
    const hintLines = [...appHints]
      .map((h) => ({ id: h.appId, hint: h.hint }))
      .sort(byId)
      .map(({ id, hint }) => {
        // A hint is found by scanning app dirs, so it can outlive its app.json.
        // Falling back to the bare id keeps the hint rather than dropping it.
        const app = appById.get(id);
        const header = app ? `### ${app.name} (${app.id})${appSuffix(app)}` : `### ${id}`;
        return `${header}\n${hint.trim()}`;
      })
      .join('\n\n');
    lines.push(`- App hints — these apps are installed too:\n${hintLines}`);
  }

  return lines;
}

export async function buildEnvironmentSection(provider: ProviderType): Promise<string> {
  const [apps, settings, appHints] = await Promise.all([
    listApps().catch(() => []),
    readSettings(),
    loadAllAppHints().catch(() => []),
  ]);

  const lines = [`- Platform: ${getPlatformName()}`, `- Provider: ${getProviderName(provider)}`];
  if (settings.userName) lines.push(`- User: ${settings.userName}`);
  lines.push(`- Language: ${getLanguageLabel(settings.language)} (${settings.language})`);

  if (IS_BUNDLED_EXE) {
    lines.push('- Mode: Standalone executable');
  }

  lines.push(...buildAppSections(apps, appHints));

  let result = `\n\n## Environment\n${lines.join('\n')}`;

  // Provider-specific prompt text is NOT here. `provider` is still an input
  // because the Environment block states which model is driving, but a section
  // that exists to correct one model's habit lives with the other prompt
  // sections — see
  // `agents/profiles/prompts/provider-codex.md`, selected by `agents/system-prompt.ts`.

  if (!settings.onboardingCompleted) {
    result += `\n\n## Onboarding

The user has a "Start" 🚀 icon on their desktop. When they click it, you will receive a \`<ui:click>app: onboarding</ui:click>\` message. Do NOT proactively welcome the user or start onboarding on connect — wait for that click. When you receive it, respond by:
1. Welcoming them to YAAR and briefly explaining what YAAR is — an AI-driven desktop where you (the AI) create windows, notifications, and UI dynamically
2. Using \`invoke('yaar://user/prompts', ...)\` to ask structured questions. Use the "ask" action for choices and "request" action for text input. Ask these one at a time (wait for each answer before the next):
   - **Name**: Use "request" action to ask for their name/nickname (title: "What should I call you?"). Save it via \`config:set\` with section "settings" and \`userName\`.
   - **Language**: Use "ask" action with language options relevant to their locale (likely Korean or English). Set the language via \`config:set\` with section "settings" if not English.
3. Making the essential apps launchable. YAAR's core apps are **already bundled** and cannot be installed (an install call on one fails). Give the user desktop icons for them with \`invoke('yaar://config/shortcuts', { label, icon, target: 'yaar://apps/{appId}' })\` — recommended: market-apps (🛒), configurations (⚙️), mcp-manager (🔌). Some bundled apps (browser, search, devtools) open contextually and set \`createShortcut: false\` — skip those unless asked. To go beyond the bundled set, read the marketplace skill via \`read('yaar://skills/marketplace')\`, browse with \`invoke('yaar://http', { url: '...' })\`, and install *additional* apps with \`invoke('yaar://apps/{appId}', { action: 'install' })\`.
4. Calling \`config:set\` with section "settings" and \`onboardingCompleted: true\` when they seem comfortable

The user prompt dialogs provide a polished UI for collecting answers — use them instead of asking questions in plain chat text. Keep the tone friendly and concise. Don't overwhelm them with too much information at once.`;
  }

  return result;
}
