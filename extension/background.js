/**
 * YAAR Bridge — background service worker (Slices 0–2).
 *
 * Dials OUT to a running YAAR server at ws://localhost:{PORT}/bridge, sends a versioned `hello`
 * plus the current tab list, and re-sends the tab list whenever tabs change. If no YAAR server is
 * up, it idles and keeps retrying with exponential backoff at zero real cost.
 *
 * T2 (Manage): it also *receives* frames — `command` (focus/close/group/move a tab, replied to with
 * `command-result`) and `activity` (paint a transient cursor/tracking overlay on a tab so the user
 * sees YAAR touching their browser). All policy/consent stays server-side; this is just glue.
 *
 * MV3 note: an active WebSocket keeps the service worker alive (Chrome >= 116). A chrome.alarms
 * heartbeat covers the sleep/wake edges — on wake, if the socket is gone, we reconnect.
 *
 * See ../0607plan.md and ../docs/extension_bridge_proposal.md.
 */

const PORT = 8000; // TODO(Slice: productization): make configurable via the extension popup.
const BRIDGE_URL = `ws://localhost:${PORT}/bridge`;
const PROTOCOL_VERSION = 4;
const CONTENT_MAX_CHARS = 100000; // fallback cap when the server doesn't send maxChars

let socket = null;
let reconnectDelayMs = 1000; // grows to a cap on repeated failures
const MAX_RECONNECT_MS = 30000;
const TABS_DEBOUNCE_MS = 150;
let tabsDebounceTimer = null;

function log(...args) {
  console.log('[yaar-bridge]', ...args);
}

function isOpen() {
  return socket && socket.readyState === WebSocket.OPEN;
}

/** Base64-encode bytes in chunks (btoa can't take a huge apply() spread at once). */
function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Transcode a data-URL image to WebP via an OffscreenCanvas (MV3 service-worker safe).
 * WebP is ~3–5× smaller than the PNG `captureVisibleTab` produces, which matters because the
 * screenshot is delivered to the agent as image bytes. Falls back to the original data URL if the
 * encoder isn't available or anything throws — a slightly larger screenshot beats no screenshot.
 */
async function toWebp(dataUrl, quality = 0.8) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const webp = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (webp.type !== 'image/webp') return dataUrl; // encoder declined → keep the PNG
    const buf = await webp.arrayBuffer();
    return 'data:image/webp;base64,' + bytesToBase64(new Uint8Array(buf));
  } catch (err) {
    log('webp transcode failed, sending PNG:', err && err.message ? err.message : String(err));
    return dataUrl;
  }
}

async function collectTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((t) => ({
    id: t.id,
    url: t.url ?? t.pendingUrl ?? '',
    title: t.title ?? '',
    active: !!t.active,
    audible: !!t.audible,
    windowId: t.windowId,
  }));
}

function send(msg) {
  if (!isOpen()) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch (err) {
    log('send failed', err);
  }
}

async function sendHello() {
  const tabs = await collectTabs();
  // navigator.userAgent inside an SW gives us a coarse browser string; good enough for Slice 0.
  const uaMatch = /(Chrome|Edg|Brave|Chromium)\/([\d.]+)/.exec(navigator.userAgent || '');
  send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    browser: { name: uaMatch ? uaMatch[1] : 'Chromium', version: uaMatch ? uaMatch[2] : '?' },
    tabCount: tabs.length,
  });
  send({ type: 'tabs', tabs });
}

async function sendTabs() {
  if (!isOpen()) return;
  send({ type: 'tabs', tabs: await collectTabs() });
}

function scheduleTabsUpdate() {
  if (tabsDebounceTimer) clearTimeout(tabsDebounceTimer);
  tabsDebounceTimer = setTimeout(() => {
    tabsDebounceTimer = null;
    sendTabs();
  }, TABS_DEBOUNCE_MS);
}

// ── T2 Manage: execute inbound tab commands, reply with a correlated result ──
async function handleCommand(cmd) {
  const { requestId, action, tabId } = cmd;
  try {
    let data;
    switch (action) {
      case 'focus': {
        const tab = await chrome.tabs.get(tabId);
        await chrome.tabs.update(tabId, { active: true });
        if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        break;
      }
      case 'close':
        await chrome.tabs.remove(tabId);
        break;
      case 'group': {
        const ids = Array.isArray(cmd.tabIds) && cmd.tabIds.length ? cmd.tabIds : [tabId];
        const groupId = await chrome.tabs.group({ tabIds: ids });
        if (cmd.groupTitle) await chrome.tabGroups.update(groupId, { title: cmd.groupTitle });
        data = { groupId };
        break;
      }
      case 'move': {
        const moveProps = { index: typeof cmd.index === 'number' ? cmd.index : -1 };
        if (typeof cmd.windowId === 'number') moveProps.windowId = cmd.windowId;
        await chrome.tabs.move(tabId, moveProps);
        break;
      }
      case 'extract': {
        // T3-lite: inject a self-contained extractor and read back the page text. Server-side
        // consent has already been granted by the time this frame arrives.
        const max = typeof cmd.maxChars === 'number' ? cmd.maxChars : CONTENT_MAX_CHARS;
        const [injection] = await chrome.scripting.executeScript({
          target: { tabId },
          func: yaarExtractContent,
          args: [max],
        });
        data = injection && injection.result ? injection.result : { text: '', truncated: false };
        break;
      }
      case 'navigate': {
        // T3 drive: point the tab at a new URL. Tab-control consent has already been granted.
        if (!cmd.url) throw new Error('navigate requires a url');
        await chrome.tabs.update(tabId, { url: cmd.url });
        data = { url: cmd.url };
        break;
      }
      case 'click':
      case 'type':
      case 'scroll': {
        // T3 drive: inject a self-contained interactor that synthesizes DOM events on the page.
        // Server-side tab-control consent has already been granted by the time this frame arrives.
        const func = action === 'click' ? yaarClick : action === 'type' ? yaarType : yaarScroll;
        const rawArgs =
          action === 'click'
            ? [cmd.selector]
            : action === 'type'
              ? [cmd.selector, cmd.text, !!cmd.submit]
              : [cmd.selector, cmd.deltaY, cmd.top];
        // executeScript args must be JSON-serializable; `undefined` throws "Value is
        // unserializable" (e.g. a scroll-by-deltaY call leaves selector/top undefined). The injected
        // funcs treat null the same as undefined, so coerce it away.
        const args = rawArgs.map((a) => (a === undefined ? null : a));
        const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
        const result = injection && injection.result;
        if (result && result.ok === false) throw new Error(result.error || `${action} failed`);
        data = result || { ok: true };
        break;
      }
      case 'screenshot': {
        // T3 view: capture the tab. `captureVisibleTab` can only grab the window's active tab, so
        // require the target to be focused (the agent has `focus` to bring it forward).
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) {
          throw new Error(
            'Focus the tab first — screenshot can only capture the visible (active) tab.',
          );
        }
        // captureVisibleTab only emits png/jpeg. Grab a lossless PNG, then transcode to WebP so the
        // payload that reaches the agent (and every hop on the way) is a fraction of the PNG size.
        const pngUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        const dataUrl = await toWebp(pngUrl);
        data = { dataUrl };
        break;
      }
      default:
        throw new Error(`unknown action "${action}"`);
    }
    send({ type: 'command-result', requestId, ok: true, ...(data ? { data } : {}) });
    log(`command ${action} → tab ${tabId} ✓`);
  } catch (err) {
    const error = err && err.message ? err.message : String(err);
    send({ type: 'command-result', requestId, ok: false, error });
    log(`command ${action} → tab ${tabId} failed:`, error);
  }
}

// ── T2 cue: paint a transient "YAAR is here" cursor/tracking overlay on a tab ──
let lastBadgeTimer = null;
async function handleActivity(msg) {
  flashBadge(msg.kind);
  let tabId = msg.tabId;
  if (tabId == null) {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = active && active.id;
  }
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: yaarCursorOverlay,
      args: [String(msg.label || 'YAAR'), String(msg.kind || 'act')],
    });
  } catch {
    // Restricted page (chrome://, Web Store, PDF viewer, …) — the overlay can't inject there.
    // The toolbar badge still fired above, so the user isn't left with zero feedback.
  }
}

function flashBadge(kind) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: kind === 'observe' ? '#2563eb' : '#16a34a' });
    chrome.action.setBadgeText({ text: '●' });
    if (lastBadgeTimer) clearTimeout(lastBadgeTimer);
    lastBadgeTimer = setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2200);
  } catch {
    /* action API unavailable — ignore */
  }
}

/**
 * Runs IN the target page (injected via chrome.scripting). Must be fully self-contained — no
 * closure references. Draws a pulsing pill in the top-right that says what YAAR is doing, then
 * fades itself out. 'observe' pulses blue and lingers; 'act' pulses green and is briefer.
 */
function yaarCursorOverlay(label, kind) {
  const ID = '__yaar_bridge_cursor__';
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:8px 13px',
      'border-radius:9999px',
      'font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      'color:#fff',
      'background:rgba(18,18,26,0.92)',
      'box-shadow:0 6px 24px rgba(0,0,0,0.35)',
      'pointer-events:none',
      'opacity:0',
      'transform:translateY(-6px)',
      'transition:opacity .25s ease,transform .25s ease',
    ].join(';');
    const dot = document.createElement('span');
    dot.className = '__yaar_dot__';
    dot.style.cssText = 'width:9px;height:9px;border-radius:50%;flex:0 0 auto';
    const txt = document.createElement('span');
    txt.className = '__yaar_txt__';
    el.appendChild(dot);
    el.appendChild(txt);
    document.documentElement.appendChild(el);
  }
  if (!document.getElementById('__yaar_bridge_kf__')) {
    const st = document.createElement('style');
    st.id = '__yaar_bridge_kf__';
    st.textContent =
      '@keyframes __yaar_pulse__{0%{box-shadow:0 0 0 0 var(--yaar-glow)}' +
      '70%{box-shadow:0 0 0 9px transparent}100%{box-shadow:0 0 0 0 transparent}}';
    document.documentElement.appendChild(st);
  }
  const dot = el.querySelector('.__yaar_dot__');
  const txt = el.querySelector('.__yaar_txt__');
  const color = kind === 'observe' ? '#60a5fa' : '#4ade80';
  txt.textContent = label;
  dot.style.background = color;
  dot.style.setProperty(
    '--yaar-glow',
    kind === 'observe' ? 'rgba(96,165,250,.7)' : 'rgba(74,222,128,.7)',
  );
  dot.style.animation = '__yaar_pulse__ 1.4s ease-out infinite';
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateY(0)';
  });
  clearTimeout(window.__yaar_cursor_timer__);
  window.__yaar_cursor_timer__ = setTimeout(
    () => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(-6px)';
    },
    kind === 'observe' ? 2600 : 1800,
  );
}

/**
 * Runs IN the target page (injected via chrome.scripting). Must be fully self-contained — no
 * closure references. Returns the page's visible text (capped), plus url/title, for the server's
 * `read` command. Read-only: touches nothing on the page.
 */
function yaarExtractContent(maxChars) {
  const cap = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 100000;
  const raw = (document.body && document.body.innerText) || '';
  const text = raw.length > cap ? raw.slice(0, cap) : raw;
  return {
    url: location.href,
    title: document.title || '',
    text,
    truncated: raw.length > cap,
  };
}

/**
 * Runs IN the target page (injected via chrome.scripting). Must be fully self-contained.
 * Synthesizes a click on the first element matching `selector`: scrolls it into view, fires a
 * mousedown/mouseup pair at its centre, then a native `.click()` (single click, no double-fire).
 * Returns `{ ok:false, error }` if nothing matches — the extension turns that into a command error.
 */
function yaarClick(selector) {
  const el = selector && document.querySelector(selector);
  if (!el) return { ok: false, error: 'No element matches selector: ' + selector };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  const o = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
  };
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  if (typeof el.click === 'function') el.click();
  else el.dispatchEvent(new MouseEvent('click', o));
  const label = ((el.innerText || el.value || el.getAttribute('aria-label') || '') + '')
    .trim()
    .slice(0, 80);
  return { ok: true, tag: (el.tagName || '').toLowerCase(), text: label };
}

/**
 * Runs IN the target page (injected via chrome.scripting). Must be fully self-contained.
 * Types `text` into the field matching `selector`: focuses it, sets the value through the native
 * input/textarea setter (so frameworks like React see the change), fires input+change, and — when
 * `submit` — presses Enter and requests the field's form submit.
 */
function yaarType(selector, text, submit) {
  const el = selector && document.querySelector(selector);
  if (!el) return { ok: false, error: 'No element matches selector: ' + selector };
  el.scrollIntoView({ block: 'center' });
  if (typeof el.focus === 'function') el.focus();
  const val = text == null ? '' : String(text);
  const proto =
    typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : null;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, val);
  else if ('value' in el) el.value = val;
  else el.textContent = val; // contenteditable and friends
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    const k = {
      bubbles: true,
      cancelable: true,
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', k));
    el.dispatchEvent(new KeyboardEvent('keyup', k));
    const form = el.form;
    if (form) {
      try {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } catch (e) {
        /* submission blocked by the page — the Enter keydown above may still have handled it */
      }
    }
  }
  return { ok: true };
}

/**
 * Runs IN the target page (injected via chrome.scripting). Must be fully self-contained.
 * Scrolls the page: with `selector`, scrolls that element into view; with `top`, jumps to that
 * absolute position; otherwise scrolls by `deltaY` pixels (default 600).
 *
 * The window isn't always what scrolls — plenty of sites scroll an inner container while
 * `document.documentElement` stays put, which made the old `window.scrollBy` a silent no-op. So we
 * locate the element that actually scrolls, drive it directly (setting `.scrollTop`, which is
 * instant and ignores CSS `scroll-behavior: smooth`), and report before/after so the caller can
 * tell whether anything moved and whether it hit the bottom.
 */
function yaarScroll(selector, deltaY, top) {
  // The scroller: the root document if it overflows, else the tallest scrollable descendant.
  function findScroller() {
    const root = document.scrollingElement || document.documentElement;
    if (root && root.scrollHeight > root.clientHeight + 4) return root;
    let best = root,
      bestOverflow = 0;
    for (const el of document.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 4) {
        const overflow = el.scrollHeight - el.clientHeight;
        if (overflow > bestOverflow) {
          bestOverflow = overflow;
          best = el;
        }
      }
    }
    return best;
  }

  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, error: 'No element matches selector: ' + selector };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return { ok: true, scrollY: window.scrollY };
  }

  const sc = findScroller();
  const before = sc.scrollTop;
  const target =
    typeof top === 'number' ? top : before + (typeof deltaY === 'number' ? deltaY : 600);
  sc.scrollTop = target;
  const after = sc.scrollTop; // clamped by the browser to the valid range
  return {
    ok: true,
    scrolled: after - before, // 0 ⇒ nothing moved (already at the target edge, or page not tall enough)
    scrollTop: after,
    scrollHeight: sc.scrollHeight,
    clientHeight: sc.clientHeight,
    atBottom: after + sc.clientHeight >= sc.scrollHeight - 2,
  };
}

function connect() {
  if (
    socket &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  log('connecting to', BRIDGE_URL);
  try {
    socket = new WebSocket(BRIDGE_URL);
  } catch (err) {
    log('construct failed', err);
    scheduleReconnect();
    return;
  }

  socket.addEventListener('open', () => {
    log('connected');
    reconnectDelayMs = 1000; // reset backoff on success
    sendHello();
  });

  socket.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return log('dropped non-JSON server frame');
    }
    if (msg.type === 'command') handleCommand(msg);
    else if (msg.type === 'activity') handleActivity(msg);
  });

  socket.addEventListener('close', () => {
    log('disconnected');
    socket = null;
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' fires after 'error'; let that path handle reconnect.
    log('socket error');
  });
}

function scheduleReconnect() {
  const delay = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_MS);
  log(`reconnect in ${delay}ms`);
  setTimeout(connect, delay);
}

/**
 * A `setTimeout`-based reconnect can't survive the MV3 service worker being torn down (~30s idle) —
 * so a restarted YAAR server would go unnoticed until the next `chrome.alarms` tick, making the
 * extension look dead. Tab events fire constantly while the user works and *wake* the worker, so we
 * piggyback on them to eagerly reconnect. This is what makes "start server → it just reconnects"
 * feel instant instead of requiring a manual extension reload.
 */
function onTabEvent() {
  if (!isOpen()) connect();
  scheduleTabsUpdate();
}

// ── Tab event listeners → eager reconnect + debounced snapshot push ──
chrome.tabs.onCreated.addListener(onTabEvent);
chrome.tabs.onRemoved.addListener(onTabEvent);
chrome.tabs.onUpdated.addListener(onTabEvent);
chrome.tabs.onActivated.addListener(onTabEvent);
chrome.tabs.onMoved.addListener(onTabEvent);

// ── Heartbeat: on SW wake, ensure the socket is alive ──
chrome.alarms.create('yaar-bridge-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'yaar-bridge-heartbeat' && !isOpen()) connect();
});

// ── Clicking the toolbar icon forces an immediate reconnect (no extension reload needed) ──
chrome.action.onClicked.addListener(() => {
  reconnectDelayMs = 1000; // reset backoff so the manual kick is snappy
  connect();
});

// ── Kick things off on install and on browser startup ──
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
