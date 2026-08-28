/**
 * `agentKindFromRole` is the client's only way to know what a streaming agent *is* —
 * the wire hands it a role string and nothing else. The two cases that matter are the
 * ordering (`app-persona-` extends `app-`, so a sub-agent must not read as its app) and
 * the fallback, which has to agree with the server's own default rather than drop an
 * unrecognized agent off the status bar.
 */
import { describe, it, expect } from 'bun:test';
import { agentKindFromRole } from '../agent-kind.js';

describe('agentKindFromRole', () => {
  it('names each tier from a role the server actually mints', () => {
    expect(agentKindFromRole('monitor-0-msg1')).toBe('monitor');
    expect(agentKindFromRole('app-notes-m0-msg2')).toBe('app');
    expect(agentKindFromRole('session-audit-1730000000000')).toBe('session');
    expect(agentKindFromRole('ephemeral-1-msg3')).toBe('ephemeral');
  });

  it('reads a sub-agent as persona, not as the app tier it extends', () => {
    expect(agentKindFromRole('app-persona-chitchats-ada')).toBe('persona');
  });

  it('does not mistake an app whose id starts with "persona" for a sub-agent', () => {
    // `app-persona-` ends in the separator, so `personal-log` cannot collide with it.
    expect(agentKindFromRole('app-personal-log-m0-msg1')).toBe('app');
  });

  it('falls back to monitor, matching principalRole()', () => {
    expect(agentKindFromRole('something-nobody-mints')).toBe('monitor');
  });
});
