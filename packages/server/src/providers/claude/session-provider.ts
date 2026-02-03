/**
 * Claude Session Provider with warmup support.
 *
 * Pre-creates a session at startup by sending an init message,
 * then uses session resumption for actual user messages.
 */

import { query as sdkQuery, type Options as SDKOptions } from '@anthropic-ai/claude-agent-sdk';
import sharp from 'sharp';
import { BaseTransport } from '../base-transport.js';
import type { StreamMessage, TransportOptions, ProviderType } from '../types.js';
import { mapClaudeMessage } from './message-mapper.js';
import { getToolNames, getMcpToken } from '../../mcp/index.js';
import { getStorageDir } from '../../storage/index.js';
import { SYSTEM_PROMPT } from './system-prompt.js';

// Port for the MCP HTTP server (same as main server)
const MCP_PORT = parseInt(process.env.PORT ?? '8000', 10);

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

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

/**
 * Parse a data URL to extract media type and base64 data.
 */
function parseDataUrl(dataUrl: string): { mediaType: ImageMediaType; data: string } | null {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] as ImageMediaType,
    data: match[2],
  };
}

/**
 * Convert an image data URL to WebP format for better compression.
 * Reduces token usage when sending base64 images to Claude.
 */
async function convertToWebP(dataUrl: string): Promise<string> {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return dataUrl;

  // Skip if already WebP or GIF (might be animated)
  if (parsed.mediaType === 'image/webp' || parsed.mediaType === 'image/gif') {
    return dataUrl;
  }

  try {
    const inputBuffer = Buffer.from(parsed.data, 'base64');
    const webpBuffer = await sharp(inputBuffer).webp({ quality: 90 }).toBuffer();
    const originalSize = inputBuffer.length;
    const newSize = webpBuffer.length;
    const savings = ((originalSize - newSize) / originalSize * 100).toFixed(1);
    console.log(`[ClaudeSessionProvider] Converted ${parsed.mediaType} to WebP: ${originalSize} → ${newSize} bytes (${savings}% smaller)`);
    return `data:image/webp;base64,${webpBuffer.toString('base64')}`;
  } catch (err) {
    console.warn(`[ClaudeSessionProvider] WebP conversion failed, using original:`, err);
    return dataUrl;
  }
}

// Warmup message - simple ping/pong handshake (see system prompt)
const WARMUP_MESSAGE = 'ping';

/**
 * Claude provider with session warmup support.
 *
 * At startup, sends a warmup message to create a session. This:
 * 1. Establishes the MCP connection
 * 2. Loads the system prompt into context
 * 3. Gets a session ID for resumption
 *
 * Subsequent queries resume this pre-warmed session for faster response.
 */
export class ClaudeSessionProvider extends BaseTransport {
  readonly name = 'claude';
  readonly providerType: ProviderType = 'claude';
  readonly systemPrompt = SYSTEM_PROMPT;

  private sessionId: string | null = null;
  private warmedUp = false;
  private warmupPromise: Promise<boolean> | null = null;

  async isAvailable(): Promise<boolean> {
    return this.isCliAvailable('claude');
  }

  /**
   * Get SDK options for queries.
   */
  private getSDKOptions(resumeSession?: string): SDKOptions {
    return {
      abortController: this.createAbortController(),
      systemPrompt: this.systemPrompt,
      model: 'claude-sonnet-4-5-20250929',
      resume: resumeSession,
      cwd: getStorageDir(),
      tools: ['WebSearch'],
      allowedTools: getToolNames(),
      maxThinkingTokens: 4096,
      mcpServers: {
        yaar: {
          type: 'http',
          url: `http://127.0.0.1:${MCP_PORT}/mcp`,
          headers: {
            Authorization: `Bearer ${getMcpToken()}`,
          },
        },
      },
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      env: {
        ...process.env,
        MAX_MCP_OUTPUT_TOKENS: '7500',
      },
    };
  }

  /**
   * Warm up the session by sending an init message.
   * Returns true if warmup succeeded.
   */
  async warmup(): Promise<boolean> {
    if (this.warmedUp) {
      return true;
    }

    if (this.warmupPromise) {
      return this.warmupPromise;
    }

    this.warmupPromise = this.doWarmup();
    const result = await this.warmupPromise;
    this.warmupPromise = null;
    return result;
  }

  private async doWarmup(): Promise<boolean> {
    console.log('[ClaudeSessionProvider] Starting warmup...');

    try {
      const options = this.getSDKOptions();
      const stream = sdkQuery({ prompt: WARMUP_MESSAGE, options });

      for await (const msg of stream) {
        // Capture session ID from first message
        if ('session_id' in msg && msg.session_id && !this.sessionId) {
          this.sessionId = msg.session_id;
          console.log(`[ClaudeSessionProvider] Session created: ${this.sessionId}`);
        }

        // Wait for completion
        if (msg.type === 'result') {
          break;
        }
      }

      if (this.sessionId) {
        this.warmedUp = true;
        console.log('[ClaudeSessionProvider] Warmup complete');
        return true;
      } else {
        console.error('[ClaudeSessionProvider] Warmup failed: no session ID');
        return false;
      }
    } catch (err) {
      console.error('[ClaudeSessionProvider] Warmup error:', err);
      return false;
    }
  }

  /**
   * Get the session ID if available.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if the session is warmed up and ready.
   */
  isWarmedUp(): boolean {
    return this.warmedUp && this.sessionId !== null;
  }

  async *query(
    prompt: string,
    options: TransportOptions
  ): AsyncIterable<StreamMessage> {
    // Determine which session to resume
    // Priority: options.sessionId > this.sessionId (warmed up)
    const resumeSession = options.sessionId ?? this.sessionId ?? undefined;
    console.log(`[ClaudeSessionProvider] query() - options.sessionId: ${options.sessionId}, this.sessionId: ${this.sessionId}, resumeSession: ${resumeSession}`);

    // Build prompt: either a string or an async generator for multimodal content
    let promptInput: Parameters<typeof sdkQuery>[0]['prompt'] = prompt;

    console.log(`[ClaudeSessionProvider] options.images: ${options.images?.length ?? 0} images`);
    if (options.images && options.images.length > 0) {
      console.log(`[ClaudeSessionProvider] First image prefix: ${options.images[0].slice(0, 50)}...`);

      // Convert images to WebP for better compression
      const convertedImages = await Promise.all(
        options.images.map(convertToWebP)
      );

      // Build multimodal content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add image blocks first
      for (const dataUrl of convertedImages) {
        const parsed = parseDataUrl(dataUrl);
        if (parsed) {
          console.log(`[ClaudeSessionProvider] Adding image block: ${parsed.mediaType}, data length: ${parsed.data.length}`);
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mediaType,
              data: parsed.data,
            },
          });
        } else {
          console.warn(`[ClaudeSessionProvider] Failed to parse data URL: ${dataUrl.slice(0, 100)}...`);
        }
      }

      // Add text block with the prompt
      contentBlocks.push({
        type: 'text',
        text: prompt,
      });

      console.log(`[ClaudeSessionProvider] Using multimodal prompt with ${contentBlocks.length} content blocks`);

      // Create async generator for multimodal message
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promptInput = (async function* (): AsyncGenerator<any> {
        console.log(`[ClaudeSessionProvider] Generator yielding multimodal message`);
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: contentBlocks,
          },
        };
      })();
    }

    const sdkOptions = this.getSDKOptions(resumeSession);

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
    }
  }

  async dispose(): Promise<void> {
    this.sessionId = null;
    this.warmedUp = false;
    await super.dispose();
  }
}
