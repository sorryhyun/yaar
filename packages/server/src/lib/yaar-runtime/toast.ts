/// <reference lib="dom" />

// ── Toast ───────────────────────────────────────────────────────────────────

export const Toast = {
  _el: null as HTMLElement | null,
  _timer: 0,

  show(message: string, type: 'info' | 'success' | 'error' = 'info', duration = 3000): void {
    if (!this._el) {
      this._el = document.createElement('div');
      this._el.className = 'y-toast';
      document.body.appendChild(this._el);
    }
    clearTimeout(this._timer);
    this._el.textContent = message;
    this._el.className = `y-toast y-toast-${type} y-toast-visible`;
    this._timer = window.setTimeout(() => {
      if (this._el) this._el.classList.remove('y-toast-visible');
    }, duration);
  },
};
