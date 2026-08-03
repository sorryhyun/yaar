// @ts-nocheck — This file runs in browser iframes, not the server.
// It is compiled by the Bun plugin for @bundled/yaar imports.
/**
 * Modal dialogs built from the `y-modal` CSS classes — replacements for the
 * native `confirm()` / `prompt()`, which block the whole page (and any agent
 * driving it).
 *
 * There is deliberately no `showAlert`: it shipped alongside these two for set
 * completion, reached zero consumers across the whole app fleet, and a
 * one-button modal is what `showToast` already covers without stealing focus.
 * Native `alert()` is still the thing to avoid — the replacement is a toast.
 */

export interface DialogOptions {
  /** Bold heading above the message. */
  title?: string;
  /** Label for the confirming button (default "OK"). */
  okLabel?: string;
  /** Label for the cancel button (default "Cancel"). */
  cancelLabel?: string;
  /** Style the confirming button as destructive (`y-btn-danger`). */
  danger?: boolean;
}

interface DialogConfig extends DialogOptions {
  message: string;
  /** Include a text input; the dialog resolves with its value on confirm. */
  input?: { placeholder?: string; initial?: string };
}

function openDialog(cfg: DialogConfig): Promise<{ ok: boolean; value: string }> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;

    const overlay = document.createElement('div');
    overlay.className = 'y-overlay';
    const modal = document.createElement('div');
    modal.className = 'y-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    overlay.appendChild(modal);

    if (cfg.title) {
      const title = document.createElement('div');
      title.className = 'y-modal-title';
      title.textContent = cfg.title;
      modal.appendChild(title);
    }
    const msg = document.createElement('div');
    msg.className = 'y-modal-msg';
    msg.textContent = cfg.message;
    modal.appendChild(msg);

    let field: HTMLInputElement | null = null;
    if (cfg.input) {
      field = document.createElement('input');
      field.className = 'y-input';
      field.style.marginTop = 'var(--yaar-sp-3)';
      field.placeholder = cfg.input.placeholder ?? '';
      field.value = cfg.input.initial ?? '';
      modal.appendChild(field);
    }

    const close = (ok: boolean) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      prevFocus?.focus?.();
      resolve({ ok, value: field?.value ?? '' });
    };

    const actions = document.createElement('div');
    actions.className = 'y-modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'y-btn';
    cancelBtn.textContent = cfg.cancelLabel ?? 'Cancel';
    cancelBtn.onclick = () => close(false);
    actions.appendChild(cancelBtn);
    const okBtn = document.createElement('button');
    okBtn.className = cfg.danger ? 'y-btn y-btn-danger' : 'y-btn y-btn-primary';
    okBtn.textContent = cfg.okLabel ?? 'OK';
    okBtn.onclick = () => close(true);
    actions.appendChild(okBtn);
    modal.appendChild(actions);

    // Enter on a focused button already clicks it natively; only the text
    // field needs explicit Enter-to-confirm.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      } else if (e.key === 'Enter' && field && e.target === field) {
        e.preventDefault();
        close(true);
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(false);
    });

    document.body.appendChild(overlay);
    (field ?? okBtn).focus();
    field?.select();
  });
}

/**
 * Show a modal confirm dialog. Resolves `true` on OK, `false` on
 * Cancel/Escape/backdrop click. Use instead of native `confirm()`.
 * Pass `danger: true` for destructive actions (styles OK as `y-btn-danger`).
 */
export async function showConfirm(msg: string, opts?: DialogOptions): Promise<boolean> {
  return (await openDialog({ message: msg, ...opts })).ok;
}

/**
 * Show a modal prompt with a text input. Resolves the entered string on OK,
 * or `null` on Cancel/Escape. Use instead of native `prompt()`.
 */
export async function showPrompt(
  msg: string,
  opts?: DialogOptions & { placeholder?: string; initial?: string },
): Promise<string | null> {
  const { placeholder, initial, ...rest } = opts ?? {};
  const r = await openDialog({ message: msg, ...rest, input: { placeholder, initial } });
  return r.ok ? r.value : null;
}
