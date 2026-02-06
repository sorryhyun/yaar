function solvePow(seed: string, targetPrefix: string): string {
  for (let i = 0; i < 10_000_000; i++) {
    const nonce = i.toString(36);
    const hash = crypto
      .createHash('sha256')
      .update(seed + nonce)
      .digest('hex');
    if (hash.startsWith(targetPrefix)) {
      return nonce;
    }
  }
  throw new Error('Failed to solve PoW within 10M iterations');
}
