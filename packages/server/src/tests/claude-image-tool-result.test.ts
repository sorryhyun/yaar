/**
 * A tool result that carries only an image still has to *complete*.
 *
 * `previewScreenshot` (devtools) and every window/browser capture return image
 * content blocks and nothing else. The Claude mapper used to render blocks to a
 * string and then drop the whole `tool_result` when that string came out empty,
 * which is exactly the image-only case. Downstream, the missing result meant no
 * `TOOL_PROGRESS: complete` — so the desktop status line sat on `Running: …`
 * until the model's first text token flipped it to `Responding…`, and the
 * "reading the screenshot" pause was never shown as `Thinking…` at all.
 */
import { describe, it, expect } from 'bun:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapClaudeMessage } from '../providers/claude/message-mapper.js';

const sdk = (m: Record<string, unknown>) => m as unknown as SDKMessage;

const userWith = (content: unknown[]) =>
  sdk({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }] },
    session_id: 's1',
  });

describe('Claude tool_result → StreamMessage', () => {
  it('emits a tool_result for an image-only result', () => {
    const mapped = mapClaudeMessage(
      userWith([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' }]),
    );
    expect(mapped?.type).toBe('tool_result');
    expect(mapped?.toolUseId).toBe('tu_1');
    // A marker, not the base64 — this channel is the transcript/UI one.
    expect(mapped?.content).toBe('[image omitted]');
    expect(mapped?.content).not.toContain('aGVsbG8=');
  });

  it('keeps the text alongside the image marker', () => {
    const mapped = mapClaudeMessage(
      userWith([
        { type: 'text', text: 'STALE: ' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/webp' },
      ]),
    );
    expect(mapped?.content).toBe('STALE: [image omitted]');
  });

  it('emits a tool_result even when no block yields text', () => {
    const mapped = mapClaudeMessage(userWith([]));
    expect(mapped?.type).toBe('tool_result');
    expect(mapped?.content).toBe('');
  });

  it('still maps a plain text result unchanged', () => {
    const mapped = mapClaudeMessage(userWith([{ type: 'text', text: 'Done.' }]));
    expect(mapped?.type).toBe('tool_result');
    expect(mapped?.content).toBe('Done.');
  });

  it('ignores a user message with no tool_result block', () => {
    expect(
      mapClaudeMessage(
        sdk({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }),
      ),
    ).toBeNull();
  });
});
