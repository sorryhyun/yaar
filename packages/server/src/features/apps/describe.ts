/**
 * What one app looks like to another agent — the facts behind
 * `describe('yaar://apps/{appId}')`.
 *
 * `describe` is the manual. It answers with the app's identity, its **protocol.json
 * verbatim**, and its hand-written `agent/SKILL.md` when it ships one. It is not the
 * app's current state — that is `read`, which returns the effective manifest
 * (`handlers/apps/app-resource.ts`).
 *
 * Returning `protocol.json` whole carries no drift risk, which is what killed the
 * *previous* SKILL.md: the file is a build artifact. `compile.ts` writes it from AST
 * extraction of the source, `fold-schemas.ts` inlines the Zod param schemas into it, and
 * `deploy.ts` re-derives and diffs it on every deploy. It cannot disagree with the code
 * the way a hand-written restatement can — and `agent/SKILL.md` is scoped to exactly
 * what a generated protocol cannot say: workflows, ordering constraints, when *not* to
 * use the app.
 */

import { listApps, loadAppSkill } from './discovery.js';

/**
 * Build the app-facts half of the describe payload. Returns null if the app is not
 * installed — the caller turns that into the error, since it owns the URI.
 *
 * Deliberately does *not* carry `verbs` or `invokeActions`: those describe what the
 * handler does, not what the app is, and the handler derives them from the table that
 * dispatches them (`appActions`). Three hand-written copies of that list is how they
 * came to disagree in the first place.
 */
export async function describeApp(appId: string): Promise<Record<string, unknown> | null> {
  const apps = await listApps();
  const app = apps.find((a) => a.id === appId);
  if (!app) return null;

  const skill = await loadAppSkill(appId);

  return {
    name: app.name,
    ...(app.description ? { description: app.description } : {}),
    ...(app.icon ? { icon: app.icon } : {}),
    // The protocol as compiled, minus persona-audience commands — those are the
    // sub-agent's half of the protocol and are described to it in its own voice at
    // spawn, so an operator reading them reads the wrong script (`persona-commands.ts`).
    ...(app.protocol ? { protocol: app.protocol } : {}),
    ...(skill ? { skill } : {}),
    ...(app.permissions?.length ? { permissions: app.permissions } : {}),
  };
}
