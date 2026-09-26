/**
 * MockTransport — a provider that spends no tokens, for load and performance runs.
 *
 * `YAAR_MOCK_AGENT=1` swaps every provider `instantiateProvider` builds for this one,
 * while the rest of the stack stays real: the turn still runs through `AgentSession`
 * inside its agent context, its stream still goes through `StreamToEventMapper`, and the
 * windows it opens go through the same `yaar://windows` invoke the MCP `invoke` tool
 * reaches. What is replaced is only the part a benchmark cannot hold still — a model's
 * latency and its choices. `make mobile-bench` is what drives it.
 *
 * A turn reads its instructions out of the prompt, so the driver steers it by typing
 * into the palette like a user would:
 *
 *     perf windows=6 text=600 apps=memo,storage
 *
 * - `windows` — how many windows the turn opens (default 4, capped at 24)
 * - `text`    — characters of reply streamed before the first window (default 400)
 * - `apps`    — app ids opened as iframe windows in the rotation; `none` for none
 * - `delay`   — ms between streamed chunks (default 15)
 *
 * The rotation is markdown → table → component → iframe app, so every renderer the phone
 * shell has gets a card. A prompt with no `perf` directive gets a one-line reply and no
 * windows, which is what the warm-up and any stray message see.
 */

import type { AITransport, InterruptReceipt, ProviderType, StreamMessage } from '../types.js';
import type { TransportOptions } from '../types.js';

const TOOL_NAME = 'mcp__verbs__invoke';
const MAX_WINDOWS = 24;

interface PerfDirective {
  windows: number;
  text: number;
  apps: string[];
  delayMs: number;
}

/** The `perf key=value …` directive in a prompt, or null when there is none. */
export function parsePerfDirective(prompt: string): PerfDirective | null {
  // The last one: a prompt carries context ahead of the user's own line.
  const match = [...prompt.matchAll(/\bperf\b((?:[ \t]+\w+=\S+)*)/g)].at(-1);
  if (!match) return null;
  const kv = new Map<string, string>();
  for (const m of match[1].matchAll(/(\w+)=(\S+)/g)) kv.set(m[1], m[2]);
  const num = (key: string, fallback: number) => {
    const n = Number(kv.get(key));
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const apps = kv.get('apps');
  return {
    windows: Math.min(num('windows', 4), MAX_WINDOWS),
    text: num('text', 400),
    apps: !apps || apps === 'none' ? [] : apps.split(',').filter(Boolean),
    delayMs: num('delay', 15),
  };
}

const LOREM =
  'The quick brown fox jumps over the lazy dog while the monitor agent streams a reply. ';

function markdownBody(n: number): string {
  const rows = Array.from({ length: 12 }, (_, i) => `| ${i} | item-${i} | ${(i * 37) % 101} |`);
  return [
    `# Perf window ${n}`,
    LOREM.repeat(6),
    '## List',
    ...Array.from({ length: 20 }, (_, i) => `- entry **${i}** — ${LOREM.slice(0, 40)}`),
    '## Code',
    '```ts',
    ...Array.from({ length: 15 }, (_, i) => `const value${i} = compute(${i}, "${n}");`),
    '```',
    '## Table',
    '| # | name | score |',
    '|---|---|---|',
    ...rows,
  ].join('\n\n');
}

function componentBody(n: number) {
  return {
    cols: 2,
    components: [
      { type: 'text', content: `Perf component window ${n}`, variant: 'heading' },
      { type: 'badge', label: `#${n}` },
      ...Array.from({ length: 6 }, (_, i) => ({
        type: 'progress',
        label: `task ${i}`,
        value: (i * 17 + n * 5) % 100,
      })),
      { type: 'input', label: 'Name', name: `name-${n}` },
      { type: 'button', label: 'Submit', action: `submit ${n}` },
    ],
  };
}

/** The `invoke` payload for window `n` of a turn — the renderer is picked by rotation. */
function windowPayload(n: number, tag: string, apps: string[]): Record<string, unknown> {
  const title = `Perf ${tag} #${n}`;
  const kinds = apps.length > 0 ? 4 : 3;
  switch (n % kinds) {
    case 0:
      return { action: 'create', title, renderer: 'markdown', content: markdownBody(n) };
    case 1:
      return {
        action: 'create',
        title,
        renderer: 'table',
        content: {
          headers: ['id', 'name', 'value', 'status'],
          rows: Array.from({ length: 60 }, (_, i) => [
            String(i),
            `row-${n}-${i}`,
            String((i * 31) % 997),
            i % 3 ? 'ok' : 'pending',
          ]),
        },
      };
    case 2:
      return { action: 'create', title, renderer: 'component', content: componentBody(n) };
    default: {
      const appId = apps[Math.floor(n / kinds) % apps.length];
      return { action: 'create', title, renderer: 'iframe', content: `yaar://apps/${appId}` };
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MockTransport implements AITransport {
  readonly name = 'mock';
  private interrupted = false;
  private turns = 0;
  private readonly sessionId = `mock-${crypto.randomUUID()}`;

  /** Reports whichever provider it stands in for, so provider-keyed branches stay on their real path. */
  constructor(readonly providerType: ProviderType) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  async *query(prompt: string, options: TransportOptions): AsyncIterable<StreamMessage> {
    this.interrupted = false;
    const turn = ++this.turns;
    yield { type: 'session', sessionId: this.sessionId };

    const directive = parsePerfDirective(prompt);
    if (!directive) {
      yield { type: 'text', content: 'Mock agent: no `perf` directive, nothing to do.' };
      yield this.complete(prompt, 12);
      return;
    }

    yield { type: 'thinking', content: `Opening ${directive.windows} windows.` };
    let streamed = 0;
    while (streamed < directive.text && !this.interrupted) {
      const chunk = LOREM.slice(0, Math.min(12, directive.text - streamed));
      streamed += chunk.length;
      yield { type: 'text', content: chunk };
      if (directive.delayMs) await sleep(directive.delayMs);
    }

    // Lazy, like the real providers' SDKs: nothing in the provider layer should pull
    // the handler graph in until a turn actually needs it.
    const { initRegistry } = await import('../../handlers/index.js');
    const registry = initRegistry();
    const tag = `${options.monitorId ?? 'm'}-${turn}`;
    for (let n = 0; n < directive.windows && !this.interrupted; n++) {
      const toolUseId = `mock-${turn}-${n}`;
      const payload = windowPayload(n, tag, directive.apps);
      yield {
        type: 'tool_use',
        toolName: TOOL_NAME,
        toolUseId,
        toolInput: { uri: 'yaar://windows/', payload },
      };
      const result = await registry.execute('invoke', 'yaar://windows/', payload);
      const text = result.content.map((c) => ('text' in c ? c.text : '')).join('\n');
      yield {
        type: 'tool_result',
        toolName: TOOL_NAME,
        toolUseId,
        content: text,
        isError: result.isError,
      };
      if (directive.delayMs) await sleep(directive.delayMs);
    }

    yield { type: 'text', content: `\n\nOpened ${directive.windows} windows.` };
    yield this.complete(prompt, streamed);
  }

  private complete(prompt: string, outputChars: number): StreamMessage {
    return {
      type: 'complete',
      usage: {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(outputChars / 4),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      usageScope: 'turn',
    };
  }

  async interrupt(): Promise<InterruptReceipt> {
    this.interrupted = true;
    return { outcome: 'acknowledged' };
  }

  async dispose(): Promise<void> {
    this.interrupted = true;
  }
}
