/**
 * Claude Session Provider.
 *
 * Uses the Claude Agent SDK to query Claude with MCP tools.
 * Sessions are created on first real query and resumed for subsequent ones.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { mapClaudeMessage } from './message-mapper.js';
import { getToolNames, getMcpToken, getActiveServers } from '../../mcp/index.js';
import { actionEmitter } from '../../session/action-emitter.js';
import { getStorageDir, getClaudeSpawnArgs, resolveClaudeBinPath, getPort } from '../../config.js';
import { getOrchestratorPrompt as getSystemPrompt } from '../../agents/profiles/orchestrator.js';
import { type ImageMediaType, parseDataUrl } from '../../lib/image.js';
import { buildAgentDefinitions } from '../../agents/profiles/index.js';

interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageMediaType;
    data: string;
  };
}

interface TextContentBlock {
  type: 'text';
  text: string;
}

type ContentBlock = TextContentBlock | ImageContentBlock;

export class ClaudeSessionProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt: string;

  private sessionId: string | null = null;
  private currentQuery: ReturnType<typeof sdkQuery> | null = null;

  constructor() {
    super();
    this.systemPrompt = getSystemPrompt();
  }

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable(...getClaudeSpawnArgs());
  }

  /**
   * Get SDK options for queries.
   */
  private getSDKOptions(
    resumeSession?: string,
    systemPrompt?: string,
    agentId?: string,
    allowedTools?: string[],
  ): SDKOptions {
    const mcpHeaders: Record<string, string> = {
      Authorization: `Bearer ${getMcpToken()}`,
    };
    if (agentId) {
      mcpHeaders['X-Agent-Id'] = agentId;
    }

    // Only enable Task built-in tool if allowedTools includes it (or is unfiltered)
    const effectiveAllowed = allowedTools ?? getToolNames();
    const builtinTools: SDKOptions['tools'] = ['WebSearch'];

    // Build MCP server configs — only include servers needed by allowedTools.
    // This prevents the 'app' MCP server from being connected for monitor agents.
    const neededServers = new Set<string>();
    for (const tool of effectiveAllowed) {
      const m = tool.match(/^mcp__(\w+)__/);
      if (m) neededServers.add(m[1]);
    }
    const mcpServerConfigs = Object.fromEntries(
      getActiveServers()
        .filter((name) => neededServers.has(name))
        .map((name: string) => [
          name,
          {
            type: 'http' as const,
            url: `http://127.0.0.1:${getPort()}/mcp/${name}`,
            headers: mcpHeaders,
          },
        ]),
    );
    if (!allowedTools || allowedTools.includes('Task')) {
      builtinTools.push('Task');
    }

    const claudeBin = resolveClaudeBinPath();

    return {
      abortController: this.createAbortController(),
      executable: 'bun',
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      systemPrompt: systemPrompt ?? this.systemPrompt,
      model: 'claude-opus-4-6',
      resume: resumeSession,
      cwd: getStorageDir(),
      tools: builtinTools,
      agents: buildAgentDefinitions(mcpServerConfigs),
      allowedTools: effectiveAllowed,
      mcpServers: mcpServerConfigs,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        MAX_MCP_OUTPUT_TOKENS: '75000',
        CLAUDE_CODE_DISABLE_BUILTIN_AGENTS: 'true',
      },
    };
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  async steer(content: string): Promise<boolean> {
    if (!this.currentQuery) return false;
    try {
      await this.currentQuery.streamInput(
        (async function* () {
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK expects SDKUserMessage but accepts partial
        })() as AsyncIterable<any>,
      );
      return true;
    } catch (err) {
      console.warn('[claude] streamInput failed:', err);
      return false;
    }
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    // Determine which session to resume
    // Priority: options.sessionId > this.sessionId (warmed up)
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    console.log(
      `[ClaudeSessionProvider] query() - options.sessionId: ${options.sessionId}, this.sessionId: ${this.sessionId}, resumeSession: ${resumeSession}`,
    );

    const messageContent = this.buildMessageContent(prompt, options);

    yield* this.executeQuery(messageContent, resumeSession, options);
  }

  private buildMessageContent(prompt: string, options: TransportOptions): string | ContentBlock[] {
    let messageContent: string | ContentBlock[] = prompt;

    console.log(`[ClaudeSessionProvider] options.images: ${options.images?.length ?? 0} images`);
    if (options.images && options.images.length > 0) {
      console.log(
        `[ClaudeSessionProvider] First image prefix: ${options.images[0].slice(0, 50)}...`,
      );

      const contentBlocks: ContentBlock[] = [];

      for (const dataUrl of options.images) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          console.log(
            `[ClaudeSessionProvider] Adding image block: ${parsed.mediaType}, data length: ${parsed.data.length}`,
          );
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType,
              data: parsed.data,
            },
          });
        } else {
          console.warn(
            `[ClaudeSessionProvider] Failed to parse data URL: ${dataUrl.slice(0, 100)}...`,
          );
        }
      }

      contentBlocks.push({
        type: 'text',
        text: prompt,
      });

      console.log(
        `[ClaudeSessionProvider] Using multimodal prompt with ${contentBlocks.length} content blocks`,
      );
      messageContent = contentBlocks;
    }

    return messageContent;
  }

  private async *executeQuery(
    messageContent: string | ContentBlock[],
    resumeSession: string | undefined,
    options: TransportOptions,
  ): AsyncIterable<StreamMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptInput = (async function* (): AsyncGenerator<any> {
      yield {
        type: 'user',
        message: { role: 'user', content: messageContent },
      };
    })();

    const sdkOptions = this.getSDKOptions(
      resumeSession,
      options.systemPrompt,
      options.agentId,
      options.allowedTools,
    );

    if (options.model) {
      sdkOptions.model = options.model;
    }

    if (options.forkSession && resumeSession) {
      sdkOptions.forkSession = true;
    }

    // Stamp monitorId and agentId so actions emitted during this turn carry the
    // correct origin (mirrors Codex provider behavior).
    if (options.monitorId) {
      actionEmitter.setCurrentMonitor(options.monitorId);
    }

    try {
      const stream = sdkQuery({ prompt: promptInput, options: sdkOptions });
      this.currentQuery = stream;
      let messageCount = 0;

      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;

        if ('session_id' in msg && msg.session_id) {
          if (!options.sessionId) {
            this.sessionId = msg.session_id;
          }
        }

        const mapped = mapClaudeMessage(msg);
        if (mapped) {
          // Detect stale session error and retry without resume
          if (
            mapped.type === 'error' &&
            resumeSession &&
            mapped.error?.includes('No conversation found')
          ) {
            console.warn(
              `[ClaudeSessionProvider] Stale session ${resumeSession}, retrying without resume`,
            );
            this.sessionId = null;
            this.currentQuery = null;
            yield* this.executeQuery(messageContent, undefined, options);
            return;
          }
          yield mapped;
        }
      }

      if (messageCount === 0) {
        console.warn(
          `[ClaudeSessionProvider] Empty response for: "${String(messageContent).slice(0, 50)}..."`,
        );
      } else {
        console.log(`[ClaudeSessionProvider] Received ${messageCount} messages`);
      }
    } catch (err) {
      if (this.isAbortError(err)) {
        return;
      }
      yield this.createErrorMessage(err);
    } finally {
      this.currentQuery = null;
      actionEmitter.clearCurrentMonitor();
    }
  }

  async dispose(): Promise<void> {
    this.currentQuery = null;
    this.sessionId = null;
    await super.dispose();
  }
}
