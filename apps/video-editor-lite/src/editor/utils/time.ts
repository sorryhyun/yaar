export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '00:00.00';
  }

  const wholeMinutes = Math.floor(seconds / 60);
  const remainder = seconds - wholeMinutes * 60;
  const wholeSeconds = Math.floor(remainder);
  const hundredths = Math.floor((remainder - wholeSeconds) * 100);

  const mm = String(wholeMinutes).padStart(2, '0');
  const ss = String(wholeSeconds).padStart(2, '0');
  const hs = String(hundredths).padStart(2, '0');

  return `${mm}:${ss}.${hs}`;
}

export function parseNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}
