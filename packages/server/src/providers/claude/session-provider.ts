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
import { getToolNames, getMcpToken, MCP_SERVERS } from '../../mcp/index.js';
import { getStorageDir } from '../../config.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import { type ImageMediaType, parseDataUrl } from '../../lib/image.js';
import { buildAgentDefinitions } from '../../agents/profiles.js';

// Port for the MCP HTTP server (same as main server)
const MCP_PORT = parseInt(process.env.PORT ?? '8000', 10);

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
  readonly systemPrompt = SYSTEM_PROMPT;

  private sessionId: string | null = null;
  private currentQuery: ReturnType<typeof sdkQuery> | null = null;

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable('claude');
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

    return {
      abortController: this.createAbortController(),
      systemPrompt: systemPrompt ?? this.systemPrompt,
      model: 'claude-sonnet-4-6',
      resume: resumeSession,
      cwd: getStorageDir(),
      tools: ['WebSearch', 'Task'],
      agents: buildAgentDefinitions(),
      allowedTools: allowedTools ?? getToolNames(),
      maxThinkingTokens: 4096,
      mcpServers: Object.fromEntries(
        MCP_SERVERS.map((name: string) => [
          name,
          {
            type: 'http' as const,
            url: `http://127.0.0.1:${MCP_PORT}/mcp/${name}`,
            headers: mcpHeaders,
          },
        ]),
      ),
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        MAX_MCP_OUTPUT_TOKENS: '15000',
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
        (async function* (): AsyncGenerator<any> {
          yield {
            type: 'user',
            message: { role: 'user', content },
          };
        })(),
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

    // Build user message content: multimodal (with images) or text-only
    // Always use async generator for streaming input mode (enables mid-turn steering via streamInput)
    let messageContent: string | ContentBlock[] = prompt;

    console.log(`[ClaudeSessionProvider] options.images: ${options.images?.length ?? 0} images`);
    if (options.images && options.images.length > 0) {
      console.log(
        `[ClaudeSessionProvider] First image prefix: ${options.images[0].slice(0, 50)}...`,
      );

      // Build multimodal content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add image blocks (already WebP from frontend capture)
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

      // Add text block with the prompt
      contentBlocks.push({
        type: 'text',
        text: prompt,
      });

      console.log(
        `[ClaudeSessionProvider] Using multimodal prompt with ${contentBlocks.length} content blocks`,
      );
      messageContent = contentBlocks;
    }

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

    // Override model if specified
    if (options.model) {
      sdkOptions.model = options.model;
    }

    // Handle fork session
    if (options.forkSession && resumeSession) {
      sdkOptions.forkSession = true;
    }

    try {
      const stream = sdkQuery({ prompt: promptInput, options: sdkOptions });
      this.currentQuery = stream;
      let messageCount = 0;

      for await (const msg of stream) {
        messageCount++;
        if (this.isAborted()) break;

        // Update session ID if we get a new one
        if ('session_id' in msg && msg.session_id) {
          // Only update our internal sessionId if we're not using an external one
          if (!options.sessionId) {
            this.sessionId = msg.session_id;
          }
        }

        const mapped = mapClaudeMessage(msg);
        if (mapped) {
          yield mapped;
        }
      }

      if (messageCount === 0) {
        console.warn(`[ClaudeSessionProvider] Empty response for: "${prompt.slice(0, 50)}..."`);
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
    }
  }

  async dispose(): Promise<void> {
    this.currentQuery = null;
    this.sessionId = null;
    await super.dispose();
  }
}
