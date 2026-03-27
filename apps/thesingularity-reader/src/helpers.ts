export {};

/** HTML 콘텐츠에서 img를 제거하고 [이미지] 플레이스홀더로 교체 */
export function stripImages(htmlStr: string): string {
  const div = document.createElement('div');
  div.innerHTML = htmlStr;
  div.querySelectorAll('img').forEach(img => {
    const placeholder = document.createElement('span');
    placeholder.textContent = '[이미지]';
    placeholder.style.cssText =
      'display:inline-block;padding:2px 6px;background:var(--yaar-surface-2,#2a2a2a);' +
      'border-radius:4px;font-size:0.8em;color:var(--yaar-text-2,#888);margin:2px';
    img.replaceWith(placeholder);
  });
  return div.innerHTML;
}

/** 초(seconds)를 m:ss 또는 Xs 형식으로 포맷 */
export function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m > 0) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${s}s`;
}

/** Date를 한국어 HH:MM:SS 형식으로 포맷 */
export function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}
