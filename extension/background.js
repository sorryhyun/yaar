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
const PROTOCOL_VERSION = 2;

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
  dot.style.setProperty('--yaar-glow', kind === 'observe' ? 'rgba(96,165,250,.7)' : 'rgba(74,222,128,.7)');
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

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
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
