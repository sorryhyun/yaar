type PowResult = {
  nonce: string;
  hash: string;
  iterations: number;
  elapsedMs: number;
};

function solvePow(
  seed: string,
  targetPrefix: string,
  options?: { maxIterations?: number; deadlineMs?: number }
): PowResult {
  const maxIterations = options?.maxIterations ?? 10_000_000;
  const deadlineMs = options?.deadlineMs ?? 1_900;
  const started = Date.now();

  for (let i = 0; i < maxIterations; i++) {
    if (Date.now() - started > deadlineMs) {
      break;
    }

    const nonce = i.toString(36);
    const hash = crypto
      .createHash('sha256')
      .update(seed + nonce)
      .digest('hex');

    if (hash.startsWith(targetPrefix)) {
      return {
        nonce,
        hash,
        iterations: i + 1,
        elapsedMs: Date.now() - started,
      };
    }
  }

  throw new Error(
    `Failed to solve PoW (target=${targetPrefix}, maxIterations=${maxIterations}, deadlineMs=${deadlineMs})`
  );
}
