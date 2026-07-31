/**
 * What one app looks like to another agent — the `describe` and `read` verbs on
 * `yaar://apps/{appId}`.
 */

import { listApps } from './discovery.js';

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

  return result;
}

/**
 * The reference doc another agent gets from `read('yaar://apps/{appId}')` — a header
 * from `app.json` plus the protocol manifest and permissions.
 *
 * Entirely generated. There used to be a hand-written `SKILL.md` this fell back from,
 * but everything it carried is either `app.json`'s `description` or a restatement of
 * `protocol.json` — and a restatement is one deploy away from being wrong. An app that
 * needs to say more to its *own* agent writes `agent/prompt.md`; page-length API
 * references are the job of the per-app `SKILLS/` directory proposed in
 * `docs/architecture/shell_to_userland.md`, read on demand rather than injected.
 *
 * Returns null only when the app is not installed.
 */
export async function buildAppReference(appId: string): Promise<string | null> {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return null;

  let result = `# ${app.name}${app.description ? `\n\n${app.description}` : ''}`.trimEnd();
  if (app.protocol) {
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
    const keybindings = app.protocol.keybindings;
    if (keybindings && Object.keys(keybindings).length) {
      sections.push(
        '### Keybindings\n' +
          Object.entries(keybindings)
            .map(([combo, command]) => `- \`${combo}\` → \`${command}\``)
            .join('\n'),
      );
    }
    if (sections.length) {
      result += '\n\n## Protocol\n\n' + sections.join('\n\n');
    }
  }

  // Append permissions section if the app declares URI permissions
  if (app.permissions?.length) {
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
