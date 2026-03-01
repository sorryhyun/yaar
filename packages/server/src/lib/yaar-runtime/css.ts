/// <reference lib="dom" />

// ── CSS ─────────────────────────────────────────────────────────────────────

export function css(strings: TemplateStringsArray, ...values: unknown[]): void {
  const style = document.createElement('style');
  style.textContent = String.raw(strings, ...values);
  document.head.appendChild(style);
}
