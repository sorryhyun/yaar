/**
 * Performance benchmarks for CPU-bound server utilities.
 *
 * Run with: bun run --filter @yaar/tests bench
 */

import { bench, group, run } from 'mitata';
import { parseSessionMessages } from '@yaar/server/logging/session-reader';
import { resolveMountPath } from '@yaar/server/storage/mounts';

// ── Generate test data ─────────────────────────────────────────────────────

function generateSampleJsonl(lineCount: number): string {
  const types = ['user', 'assistant', 'tool_use', 'tool_result', 'action'] as const;
  const lines: string[] = [];

  for (let i = 0; i < lineCount; i++) {
    const type = types[i % types.length];
    const ts = new Date(Date.now() - (lineCount - i) * 1000).toISOString();

    switch (type) {
      case 'user':
        lines.push(
          JSON.stringify({
            type,
            agentId: 'agent-0',
            timestamp: ts,
            content: `User message ${i}`,
          }),
        );
        break;
      case 'assistant':
        lines.push(
          JSON.stringify({
            type,
            agentId: 'agent-0',
            timestamp: ts,
            content: `Assistant response ${i} with some longer content to simulate real output`,
          }),
        );
        break;
      case 'tool_use':
        lines.push(
          JSON.stringify({
            type,
            agentId: 'agent-0',
            timestamp: ts,
            toolName: 'window_create',
            toolInput: { title: `Window ${i}`, content: { type: 'markdown', content: '# Hi' } },
          }),
        );
        break;
      case 'tool_result':
        lines.push(
          JSON.stringify({
            type,
            agentId: 'agent-0',
            timestamp: ts,
            toolName: 'window_create',
            content: `{"windowId":"win-${i}"}`,
          }),
        );
        break;
      case 'action':
        lines.push(
          JSON.stringify({
            type,
            agentId: 'agent-0',
            timestamp: ts,
            action: { type: 'window.create', windowId: `win-${i}`, title: `Win ${i}` },
          }),
        );
        break;
    }
  }

  return lines.join('\n');
}

const SAMPLE_1K = generateSampleJsonl(1_000);
const SAMPLE_10K = generateSampleJsonl(10_000);

// ── Benchmarks ─────────────────────────────────────────────────────────────

group('parseSessionMessages', () => {
  bench('parse 1k-line session log', () => {
    parseSessionMessages(SAMPLE_1K);
  });

  bench('parse 10k-line session log', () => {
    parseSessionMessages(SAMPLE_10K);
  });
});

group('resolveMountPath', () => {
  bench('reject non-mount path ×1000', () => {
    for (let i = 0; i < 1_000; i++) {
      resolveMountPath(`../../etc/passwd${i}`);
    }
  });

  bench('reject traversal in mount path ×1000 (no mounts loaded)', () => {
    for (let i = 0; i < 1_000; i++) {
      resolveMountPath(`mounts/data/../../etc/passwd${i}`);
    }
  });
});

await run();
