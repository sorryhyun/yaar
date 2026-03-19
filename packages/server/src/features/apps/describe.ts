/**
 * App describe/skill business logic extracted from handlers/apps.ts.
 */

import { listApps, loadAppSkill } from './discovery.js';

/**
 * Build a rich app info object for the describe verb.
 * Returns null if the app is not found.
 */
export async function describeApp(appId: string): Promise<Record<string, unknown> | null> {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return null;

  const invokeActions: Record<string, string> = {
    set_badge: 'Set badge count on app icon ({ count })',
  };

  const result: Record<string, unknown> = {
    name: app.name,
    description: app.description,
    icon: app.icon,
    verbs: ['describe', 'read', 'list', 'invoke', 'delete'],
    invokeActions,
  };

  if (app.protocol) result.protocol = app.protocol;
  if (app.permissions?.length) result.permissions = app.permissions;

  const skill = await loadAppSkill(appId);
  if (skill) result.skill = skill;

  return result;
}

/**
 * Load an app's SKILL.md and append protocol manifest + permissions sections.
 * Returns null if no SKILL.md exists for the app.
 */
export async function loadAppSkillWithManifest(appId: string): Promise<string | null> {
  const skill = await loadAppSkill(appId);
  if (skill === null) return null;

  let result = skill;

  // Append static protocol manifest if available
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (app?.protocol) {
    const sections: string[] = [];
    const { state, commands } = app.protocol;
    if (state && Object.keys(state).length) {
      sections.push(
        '### State\n' +
          Object.entries(state)
            .map(([k, v]) => `- \`${k}\` — ${v.description}`)
            .join('\n'),
      );
    }
    if (commands && Object.keys(commands).length) {
      sections.push(
        '### Commands\n' +
          Object.entries(commands)
            .map(([k, v]) => `- \`${k}\` — ${v.description}`)
            .join('\n'),
      );
    }
    if (sections.length) {
      result += '\n\n## Protocol\n\n' + sections.join('\n\n');
    }
  }

  // Append permissions section if the app declares URI permissions
  if (app?.permissions?.length) {
    const permissionsList = app.permissions
      .map((p) => {
        if (typeof p === 'string') return `- \`${p}\``;
        const verbs = p.verbs?.length ? ` (${p.verbs.join(', ')})` : '';
        return `- \`${p.uri}\`${verbs}`;
      })
      .join('\n');
    result += '\n\n## Permissions\n\n' + permissionsList;
  }

  return result;
}
