/**
 * App agent profile builder — creates dynamic profiles for app-scoped agents.
 *
 * App agents have a focused system prompt built from the app's SKILL.md and
 * protocol manifest, with access only to query, command, and relay tools.
 */

import type { AgentProfile } from './types.js';
import { APP_AGENT_TOOL_NAMES } from './types.js';
import { loadAppSkill, listApps } from '../../features/apps/discovery.js';

/**
 * Build a dynamic agent profile for a specific app.
 * Loads SKILL.md and protocol manifest to create a scoped system prompt.
 */
export async function buildAppAgentProfile(appId: string): Promise<AgentProfile> {
  const [skill, apps] = await Promise.all([loadAppSkill(appId), listApps()]);
  const appInfo = apps.find((a) => a.id === appId);
  const appName = appInfo?.name ?? appId;
  const protocol = appInfo?.protocol;

  let systemPrompt = `You are an AI assistant for the "${appName}" app in YAAR, a reactive AI-driven operating system interface.

You handle user interactions within this app's windows. You have three tools available:
- **query** — read the app's state (pass a stateKey, or omit for the manifest)
- **command** — execute an action in the app (pass command name and params)
- **relay** — hand off a message to the monitor agent when the request is outside your domain
`;

  if (skill) {
    systemPrompt += `\n## App Documentation\n\n${skill}\n`;
  }

  if (protocol) {
    if (protocol.state && Object.keys(protocol.state).length > 0) {
      systemPrompt += '\n## Available State\n\n';
      for (const [key, desc] of Object.entries(protocol.state)) {
        const description =
          typeof desc === 'string' ? desc : ((desc as { description?: string })?.description ?? '');
        systemPrompt += `- \`${key}\`: ${description}\n`;
      }
    }

    if (protocol.commands && Object.keys(protocol.commands).length > 0) {
      systemPrompt += '\n## Available Commands\n\n';
      for (const [key, desc] of Object.entries(protocol.commands)) {
        const description =
          typeof desc === 'string' ? desc : ((desc as { description?: string })?.description ?? '');
        systemPrompt += `- \`${key}\`: ${description}\n`;
      }
    }
  }

  systemPrompt += `
## Behavior
- Handle user interactions efficiently within your app domain
- Use query to read state before making changes
- Use command to execute actions
- If the user's request is outside your app's domain, use relay to hand off to the monitor agent
- Keep responses concise — the user interacts through the app UI, not text
`;

  return {
    id: `app-agent-${appId}`,
    description: `App agent for ${appName}`,
    systemPrompt,
    allowedTools: [...APP_AGENT_TOOL_NAMES],
  };
}
