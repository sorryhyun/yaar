/**
 * Inject an inline `<script>` into an iframe document's head exactly once, marked by a
 * boolean attribute so a second load (or a second caller) is a no-op.
 *
 * `IframeRenderer` seeds a same-origin app frame with its SDK scripts through this, in
 * table order.
 */
export function injectScriptOnce(
  doc: Document | null | undefined,
  marker: string,
  source: string,
): void {
  if (!doc) return;
  if (doc.querySelector(`script[${marker}]`)) return;
  const script = doc.createElement('script');
  script.setAttribute(marker, '1');
  script.textContent = source;
  doc.head.appendChild(script);
}
