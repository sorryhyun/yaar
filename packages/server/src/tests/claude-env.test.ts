/**
 * `buildClaudeEnv` — what the spawned `claude` CLI inherits (issue #187, item 2).
 *
 * Inside a parent Claude Code harness, the whole `CLAUDE*`/`CCR_*` namespace belongs to the
 * parent except the vars a person sets to authenticate or route the API. A var that got
 * through used to change the inner CLI's behavior (`CLAUDE_AUTO_BACKGROUND_TASKS` cut a
 * user prompt off at 120s) or open a channel to the outer session.
 */
import { describe, it, expect } from 'bun:test';
import { buildClaudeEnv, MCP_TOOL_CALL_TIMEOUT_MS } from '../config.js';

/** A trimmed copy of what a cloud session hands its children. */
const HARNESS_ENV = {
  PATH: '/usr/bin',
  HOME: '/root',
  HTTPS_PROXY: 'http://proxy:8080',
  NODE_EXTRA_CA_CERTS: '/root/ca.crt',
  ANTHROPIC_BASE_URL: 'https://api.example',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'ses-outer',
  CLAUDE_AUTO_BACKGROUND_TASKS: 'true',
  CLAUDE_CODE_BG_TASKS_REPORT_RUNNING: '1',
  CLAUDE_EFFORT: 'high',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/outer.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  CLAUDE_SESSION_INGRESS_TOKEN_FILE: '/tmp/ingress',
  CCR_SESSION_PROFILE: 'x',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
  CLAUDE_CODE_PATH: '/opt/claude',
  CLAUDE_CONFIG_DIR: '/root/.claude',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
};

describe('buildClaudeEnv', () => {
  it('drops every harness var inside a parent harness', () => {
    const env = buildClaudeEnv(HARNESS_ENV);
    for (const key of [
      'CLAUDECODE',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_AUTO_BACKGROUND_TASKS',
      'CLAUDE_CODE_BG_TASKS_REPORT_RUNNING',
      'CLAUDE_EFFORT',
      'CLAUDE_CODE_MESSAGING_SOCKET',
      'CLAUDE_CODE_MESSAGING_TOKEN',
      'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
      'CCR_SESSION_PROFILE',
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it('keeps auth, API routing and the platform around it', () => {
    expect(buildClaudeEnv(HARNESS_ENV)).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/root',
      HTTPS_PROXY: 'http://proxy:8080',
      NODE_EXTRA_CA_CERTS: '/root/ca.crt',
      ANTHROPIC_BASE_URL: 'https://api.example',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x',
      CLAUDE_CODE_PATH: '/opt/claude',
      CLAUDE_CONFIG_DIR: '/root/.claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    });
  });

  it("passes a person's own CLAUDE_* settings through outside a harness", () => {
    const env = buildClaudeEnv({ PATH: '/usr/bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' });
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('8000');
  });

  it('never lets the CLI move a tool call to the background, harness or not', () => {
    // The CLI tests the raw string, so this has to be absent — "0" would turn it on.
    expect(buildClaudeEnv({ CLAUDE_AUTO_BACKGROUND_TASKS: 'true' })).not.toHaveProperty(
      'CLAUDE_AUTO_BACKGROUND_TASKS',
    );
  });

  it("applies YAAR's overrides over whatever survived", () => {
    expect(buildClaudeEnv(HARNESS_ENV).MCP_TOOL_TIMEOUT).toBe(String(MCP_TOOL_CALL_TIMEOUT_MS));
  });
});
