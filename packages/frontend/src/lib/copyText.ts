/**
 * Put text on the clipboard from a user gesture. Resolves to whether it got there.
 *
 * `navigator.clipboard` exists only in a secure context. localhost is one, but remote mode
 * reached over a LAN address is plain http, and there the old `execCommand('copy')` on a
 * scratch textarea is the only copy a page has. `readonly` keeps a phone from raising its
 * keyboard for the textarea during the moment it is focused.
 */
export async function copyText(text: string): Promise<boolean> {
  if (globalThis.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or document not focused — the fallback may still work.
    }
  }
  const scratch = document.createElement('textarea');
  scratch.value = text;
  scratch.readOnly = true;
  scratch.style.position = 'fixed';
  scratch.style.top = '0';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  try {
    scratch.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    scratch.remove();
  }
}
