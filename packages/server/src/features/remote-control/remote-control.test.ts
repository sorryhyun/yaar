/**
 * yaar://system/remote-control — reachable by the monitor agent — and the monitor-agent
 * config a hosted session is given.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ResourceRegistry, setAccessPrincipalResolver } from '../../handlers/uri-registry.js';
import { registerRemoteControlHandlers } from '../../handlers/remote-control.js';
import { registerSystemHandlers } from '../../handlers/system.js';
import {
  ORCHESTRATOR_PROMPT,
  REMOTE_ORCHESTRATOR_PROMPT,
} from '../../agents/profiles/orchestrator/index.js';
import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { resolveAgentToken, revokeAgentToken } from '../../mcp/agent-tokens.js';
import { initMcpServer } from '../../mcp/server.js';
import { REMOTE_AGENT_ID, writeRemoteAgentConfig } from './agent-config.js';
import { prepareStart } from './host.js';

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

describe('prepareStart', () => {
  test('pins same-dir so the CLI never asks, and keeps Claude in Chrome off', () => {
    expect(prepareStart({}).args).toEqual(['remote-control', '--spawn', 'same-dir', '--no-chrome']);
  });

  test('refuses worktree — its checkout would not carry the generated config', () => {
    expect(() => prepareStart({ spawn: 'worktree' as never })).toThrow('Unknown spawn mode');
  });

  test('continue carries no spawn flag, which the CLI refuses beside it', () => {
    expect(prepareStart({ continue: true }).args).toEqual([
      'remote-control',
      '--continue',
      '--no-chrome',
    ]);
    expect(() => prepareStart({ continue: true, spawn: 'same-dir' })).toThrow('continue');
  });
});

describe('the remote prompt', () => {
  test('frames a chat user on the user’s own machine', () => {
    expect(REMOTE_ORCHESTRATOR_PROMPT).toContain('not in a cloud container');
    expect(REMOTE_ORCHESTRATOR_PROMPT).toContain('answer in chat');
  });

  test('leaves out context a remote session never receives, and its own start door', () => {
    for (const heading of [
      '## Interaction Timeline',
      '## Action Reload Cache',
      '## User Drawings',
      '## Remote Control',
      '## User Prompts',
    ]) {
      expect(ORCHESTRATOR_PROMPT).toContain(heading);
      expect(REMOTE_ORCHESTRATOR_PROMPT).not.toContain(heading);
    }
    expect(REMOTE_ORCHESTRATOR_PROMPT).not.toContain('Plain text responses are invisible');
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
    // The reload tools serve `<reload_options>`, which a remote session never gets.
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['messaging', 'verbs']);
    expect(settings.permissions.allow).toContain('mcp__verbs__invoke');
    expect(settings.permissions.allow).not.toContain('mcp__system__reload_cached');
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(['Bash', 'CronCreate', 'EnterWorktree', 'SendMessage', 'Monitor']),
    );
    expect(settings.outputStyle).toBe('yaar');
    expect(style).toContain('keep-coding-instructions: false');
    expect(style).toContain('not in a cloud container');
    // The orchestrator's own section; an app hint's `### Remote Control (remote-control)` is fine.
    expect(style).not.toMatch(/^## Remote Control$/m);
    expect(style).not.toContain('## Onboarding');

    // Secrets stay in env: the file holds `${VAR}` refs, and the agent-token ref resolves
    // to a token minted for the remote principal.
    const headers = mcp.mcpServers.verbs.headers as Record<string, string>;
    const tokenRef = headers['X-Agent-Token'].match(/^\$\{(\w+)\}$/)?.[1];
    expect(tokenRef).toBeDefined();
    expect(resolveAgentToken(env[tokenRef!])).toBe(REMOTE_AGENT_ID);
    expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).not.toContain(env[tokenRef!]);
    expect(env.MCP_SDK_GENERATION).toBe('v2');
    // YAAR's verbs load up front, as on the SDK path, instead of behind ToolSearch.
    expect(env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  test('the generated directory inherits no config from the checkout around it', async () => {
    const { cwd, env } = await writeRemoteAgentConfig('0');
    const settings = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));

    // Subagents, skills and settings.local.json are searched from the cwd up to the
    // repository root. This directory is one, so the search never reaches YAAR's own
    // `.claude/agents/*` — a monitor agent is not offered `app-dev` or `reviewer`.
    expect(readFileSync(join(cwd, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(readFileSync(join(cwd, '.git', 'config'), 'utf8')).toContain('repositoryformatversion');
    // CLAUDE.md's walk has no such floor, so it is turned off outright.
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(settings.disableBundledSkills).toBe(true);
  });

  test('and is recorded as a trusted workspace, since it no longer inherits one', async () => {
    const { cwd } = await writeRemoteAgentConfig('0');
    const file = join(process.env.CLAUDE_CONFIG_DIR!, '.claude.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));

    // Trust is keyed by the git root, so severing the checkout severed the accepted dialog
    // this directory was riding on — and the CLI exits on the spot without one, which the
    // desktop can only show as a host that dies the moment it is switched on.
    expect(config.projects[cwd].hasTrustDialogAccepted).toBe(true);
    // One path, and no other entry disturbed.
    expect(Object.keys(config.projects)).toEqual([cwd]);
    // Replaced by a rename, so the mode is ours to set — this file holds account state.
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
