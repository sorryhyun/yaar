import { describe, it, expect, beforeEach } from 'bun:test';
import { GlobalWindow } from 'happy-dom';
import { IFRAME_AUTOFILL_GUARD_SCRIPT } from '@yaar/shared';

/**
 * The guard stamps `autocomplete="off"` on text controls so Chrome stops treating
 * YAAR's fields as login/checkout forms. Each test builds its own window: the script
 * latches onto the window it installs into, and reads `window`/`document` as free
 * variables, which `new Function` parameters scope to this test's window.
 */
describe('IFRAME_AUTOFILL_GUARD_SCRIPT', () => {
  let win: GlobalWindow;

  beforeEach(() => {
    win = new GlobalWindow();
  });

  function install() {
    new Function('window', 'document', 'MutationObserver', IFRAME_AUTOFILL_GUARD_SCRIPT)(
      win,
      win.document,
      win.MutationObserver,
    );
  }

  const settle = () => new Promise((r) => setTimeout(r, 0));

  function add(html: string) {
    const host = win.document.createElement('div');
    host.innerHTML = html;
    win.document.body.appendChild(host);
    return host;
  }

  it('stamps fields already in the document at install', () => {
    const host = add('<input type="text"><textarea></textarea>');
    install();
    for (const el of host.querySelectorAll('input, textarea')) {
      expect(el.getAttribute('autocomplete')).toBe('off');
    }
  });

  it('stamps fields added later, including nested ones', async () => {
    install();
    const host = add('<form><label><input type="search"></label></form>');
    const direct = win.document.createElement('input');
    win.document.body.appendChild(direct);
    await settle();
    expect(host.querySelector('input')!.getAttribute('autocomplete')).toBe('off');
    expect(direct.getAttribute('autocomplete')).toBe('off');
  });

  it('keeps an autocomplete the page asked for, and leaves password fields alone', async () => {
    install();
    const host = add('<input autocomplete="email"><input type="password">');
    await settle();
    const [email, password] = host.querySelectorAll('input');
    expect(email.getAttribute('autocomplete')).toBe('email');
    expect(password.hasAttribute('autocomplete')).toBe(false);
  });

  it('installs only once per window', () => {
    install();
    install();
    expect((win as unknown as Record<string, unknown>).__yaarAutofillGuardInstalled).toBe(true);
  });
});
