const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Yield to the macrotask queue so postMessage handlers and other events
 * can run during long-running PoW. Uses MessageChannel which is NOT
 * throttled in background tabs (unlike setTimeout).
 */
function yieldToMacroTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(undefined);
  });
}

export type PowResult = {
  nonce: string;
  hash: string;
  attempts: number;
  elapsedMs: number;
};

export async function solvePow(
  seed: string,
  targetPrefix: string,
  deadlineMs = 1900,
): Promise<PowResult> {
  const started = performance.now();
  let attempts = 0;

  const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  while (performance.now() - started < deadlineMs) {
    const nonce = `${prefix}-${attempts.toString(36)}`;
    const hash = await sha256Hex(`${seed}${nonce}`);
    attempts += 1;

    if (hash.startsWith(targetPrefix)) {
      return {
        nonce,
        hash,
        attempts,
        elapsedMs: Math.round(performance.now() - started),
      };
    }

    // Yield to macrotask queue every 100 iterations so the browser can
    // process postMessage events (app protocol queries/commands).
    // MessageChannel is used instead of setTimeout because setTimeout
    // gets clamped to ≥1s in background tabs.
    if (attempts % 100 === 0) {
      await yieldToMacroTask();
    }
  }

  throw new Error(`PoW timeout after ${Math.round(performance.now() - started)}ms`);
}
