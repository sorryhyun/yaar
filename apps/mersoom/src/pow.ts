const encoder = new TextEncoder();

async function sha256Hex(input: string): Promise<string> {
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = Array.from(new Uint8Array(hash));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
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

  while (performance.now() - started < deadlineMs) {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${attempts}`;
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
  }

  throw new Error(`PoW timeout after ${Math.round(performance.now() - started)}ms`);
}
