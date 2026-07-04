/**
 * YAAR Bridge — background service worker (Slice 0: bare transport).
 *
 * Dials OUT to a running YAAR server at ws://localhost:{PORT}/bridge, sends a versioned `hello`
 * plus the current tab list, and re-sends the tab list whenever tabs change. If no YAAR server is
 * up, it idles and keeps retrying with exponential backoff at zero real cost.
 *
 * MV3 note: an active WebSocket keeps the service worker alive (Chrome >= 116). A chrome.alarms
 * heartbeat covers the sleep/wake edges — on wake, if the socket is gone, we reconnect.
 *
 * This file is intentionally DUMB: a transport plus chrome.tabs glue, no policy. All policy lives
 * server-side. See ../0607plan.md and ../docs/extension_bridge_proposal.md.
 */

const PORT = 8000; // TODO(Slice: productization): make configurable via the extension popup.
const BRIDGE_URL = `ws://localhost:${PORT}/bridge`;
const PROTOCOL_VERSION = 1;

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

// ── Tab event listeners → debounced snapshot push ──
chrome.tabs.onCreated.addListener(scheduleTabsUpdate);
chrome.tabs.onRemoved.addListener(scheduleTabsUpdate);
chrome.tabs.onUpdated.addListener(scheduleTabsUpdate);
chrome.tabs.onActivated.addListener(scheduleTabsUpdate);
chrome.tabs.onMoved.addListener(scheduleTabsUpdate);

// ── Heartbeat: on SW wake, ensure the socket is alive ──
chrome.alarms.create('yaar-bridge-heartbeat', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'yaar-bridge-heartbeat' && !isOpen()) connect();
});

// ── Kick things off on install and on browser startup ──
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
