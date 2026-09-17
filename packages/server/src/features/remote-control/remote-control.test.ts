/**
 * yaar://system/remote-control — reachable by the monitor agent — and the monitor-agent
 * config a hosted session is given.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ResourceRegistry, setAccessPrincipalResolver } from '../../handlers/uri-registry.js';
import { registerRemoteControlHandlers } from '../../handlers/remote-control.js';
import { registerSystemHandlers } from '../../handlers/system.js';
import { ORCHESTRATOR_PROMPT } from '../../agents/profiles/orchestrator/index.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveAgentToken, revokeAgentToken } from '../../mcp/agent-tokens.js';
import { initMcpServer } from '../../mcp/server.js';
import { REMOTE_AGENT_ID, writeRemoteAgentConfig } from './agent-config.js';

function text(result: { content: unknown[] }): string {
  return result.content
    .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : JSON.stringify(c)))
    .join('');
}

function registry(): ResourceRegistry {
  setAccessPrincipalResolver(() => ({ role: 'monitor', systemApp: false }));
  const reg = new ResourceRegistry();
  registerSystemHandlers(reg);
  registerRemoteControlHandlers(reg);
  return reg;
}

describe('yaar://system/remote-control', () => {
  afterAll(() => setAccessPrincipalResolver(() => ({})));

  test('the monitor agent is told the URI exists', () => {
    expect(ORCHESTRATOR_PROMPT).toContain('yaar://system/remote-control');
  });

  test('is listed under yaar://system', async () => {
    const result = await registry().execute('list', 'yaar://system');
    expect(text(result)).toContain('yaar://system/remote-control');
  });

  test('a monitor principal can read it, and nothing is running', async () => {
    const result = await registry().execute('read', 'yaar://system/remote-control');
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(text(result))).toMatchObject({ running: false, state: null });
  });

  test('write with nothing running is a caller error', async () => {
    const result = await registry().execute('invoke', 'yaar://system/remote-control', {
      action: 'write',
      data: '\r',
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('not running');
  });

  test('delete with nothing running says so', async () => {
    const result = await registry().execute('delete', 'yaar://system/remote-control');
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('was not running');
  });
});

describe('writeRemoteAgentConfig', () => {
  beforeAll(() => initMcpServer());
  afterAll(() => revokeAgentToken(REMOTE_AGENT_ID));

  test('writes the monitor agent’s SDK options where a plain CLI reads them', async () => {
    const { cwd, env } = await writeRemoteAgentConfig('0');
    const mcp = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
    const style = readFileSync(join(cwd, '.claude', 'output-styles', 'yaar.md'), 'utf8');

    // Every tool the monitor agent is allowed, via the servers it needs and no others.
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['messaging', 'system', 'verbs']);
    expect(settings.permissions.allow).toContain('mcp__verbs__invoke');
    expect(settings.permissions.deny).toContain('Bash');
    expect(settings.outputStyle).toBe('yaar');
    expect(style).toContain('keep-coding-instructions: false');
    expect(style).toContain('yaar://system/remote-control');

    // Secrets stay in env: the file holds `${VAR}` refs, and the agent-token ref resolves
    // to a token minted for the remote principal.
    const headers = mcp.mcpServers.verbs.headers as Record<string, string>;
    const tokenRef = headers['X-Agent-Token'].match(/^\$\{(\w+)\}$/)?.[1];
    expect(tokenRef).toBeDefined();
    expect(resolveAgentToken(env[tokenRef!])).toBe(REMOTE_AGENT_ID);
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).not.toContain(env[tokenRef!]);
    expect(env.MCP_SDK_GENERATION).toBe('v2');
  });
});
