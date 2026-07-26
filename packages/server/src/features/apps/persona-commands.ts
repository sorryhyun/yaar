/**
 * `persona:` commands — the half of a `protocol`-grade sub-agent's tool that the app
 * writes.
 *
 * A sub-agent's tool `memorize` is dispatched to its own app's iframe as the protocol
 * command `persona:memorize`, so an app that wants to give its characters a memory
 * registers a `persona:memorize` handler the way it registers any other command. The
 * prefix does two jobs:
 *
 * 1. **It marks the audience.** Two audiences need two descriptions of the same
 *    handler — the app agent reads a protocol manifest in operator voice ("write a
 *    character memory row"), the sub-agent is *told* it can "save a lasting fact you
 *    learned about someone". One description string cannot serve both without being
 *    wrong for one of them, which is why the sub-agent's wording arrives at spawn and
 *    the handler's stays in the protocol. {@link withoutPersonaCommands} then keeps
 *    the app agent from reading the wrong script: its `describe` and its manifest
 *    never show these entries.
 * 2. **It keeps the two namespaces from colliding.** An app's ordinary commands are
 *    the agent-facing API of the window; these are the character-facing one. A tool
 *    called `skip` and a command called `skip` are not obliged to be the same thing.
 *
 * Nothing about the prefix is a permission — the app agent can still call
 * `persona:memorize` directly through `command`, and should be able to: it is the
 * app's own iframe, and the app agent is the strictly more privileged node above it.
 */

import type { AppManifest } from '@yaar/shared';

export const PERSONA_COMMAND_PREFIX = 'persona:';

/** The protocol command a sub-agent's tool `name` is dispatched as. */
export function personaCommandFor(toolName: string): string {
  return `${PERSONA_COMMAND_PREFIX}${toolName}`;
}

export function isPersonaCommand(command: string): boolean {
  return command.startsWith(PERSONA_COMMAND_PREFIX);
}

/**
 * The same protocol with its persona-audience commands hidden.
 *
 * Applied everywhere an app's manifest is served to an *agent* — `describe`, the
 * skill doc, the runtime manifest query. Returns the input unchanged when there is
 * nothing to hide, which is every app but the ones that grew characters.
 */
export function withoutPersonaCommands<T extends Pick<AppManifest, 'commands'>>(protocol: T): T {
  const commands = protocol?.commands;
  if (!commands) return protocol;
  const names = Object.keys(commands);
  if (!names.some(isPersonaCommand)) return protocol;
  return {
    ...protocol,
    commands: Object.fromEntries(
      names.filter((n) => !isPersonaCommand(n)).map((n) => [n, commands[n]]),
    ),
  };
}
