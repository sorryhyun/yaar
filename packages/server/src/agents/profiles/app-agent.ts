/**
 * App agent profile builder — creates dynamic profiles for app-scoped agents.
 *
 * App agents have a focused system prompt built from:
 * 1. AGENT.md (if present) — full custom prompt, replaces the generic base
 * 2. SKILL.md (fallback) — app documentation appended to generic base prompt
 * Protocol manifest from app.json is always appended.
 */

import type { AgentProfile } from './types.js';
import { APP_AGENT_TOOL_NAMES } from './types.js';
import { loadAppSkill, loadAppAgentDoc, listApps } from '../../features/apps/discovery.js';

/**
 * Build a dynamic agent profile for a specific app.
 * If AGENT.md exists, uses it as the full system prompt base.
 * Otherwise falls back to the generic prompt + SKILL.md.
 * Protocol manifest from app.json is appended in both cases.
 */
export async function buildAppAgentProfile(appId: string): Promise<AgentProfile> {
  const [agentDoc, skill, apps] = await Promise.all([
    loadAppAgentDoc(appId),
    loadAppSkill(appId),
    listApps(),
  ]);
  const appInfo = apps.find((a) => a.id === appId);
  const appName = appInfo?.name ?? appId;
  const protocol = appInfo?.protocol;

  let systemPrompt: string;

  if (agentDoc) {
    // AGENT.md provides the full base prompt
    systemPrompt = agentDoc;
  } else {
    // Generic fallback prompt
    systemPrompt = `You are an AI assistant for the "${appName}" app in YAAR, a reactive AI-driven operating system interface.

You handle user interactions within this app's windows. You have three tools available:
- **query** — read the app's state (pass a stateKey, or omit for the manifest)
- **command** — execute an action in the app (pass command name and params)
- **relay** — hand off a message to the monitor agent when the request is outside your domain
`;

    if (skill) {
      systemPrompt += `\n## App Documentation\n\n${skill}\n`;
    }

    systemPrompt += `
## Behavior
- Handle user interactions efficiently within your app domain
- Use query to read state before making changes
- Use command to execute actions
- If the user's request is outside your app's domain, use relay to hand off to the monitor agent
- Keep responses concise — the user interacts through the app UI, not text
`;
  }

  // Protocol manifest from app.json is always appended
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

  return {
    id: `app-agent-${appId}`,
    description: `App agent for ${appName}`,
    systemPrompt,
    allowedTools: [...APP_AGENT_TOOL_NAMES],
  };
}
