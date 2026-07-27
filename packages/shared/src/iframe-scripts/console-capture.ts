/**
 * Console capture script injected into compiled app iframes.
 *
 * Overrides console.log/warn/error/info to post messages to the parent frame.
 * DevTools can listen for these messages to display console output.
 */
import { APP_MSG } from '../app-protocol.js';
import { installGuard } from './prelude.js';
export const IFRAME_CONSOLE_CAPTURE_SCRIPT = `
(function() {
  ${installGuard('__yaarConsoleInstalled')}

  var MAX_ENTRIES = 200;
  var MAX_ARG_LEN = 1000;
  window.__YAAR_CONSOLE = [];

  var origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  };

  function serialize(arg) {
    if (arg === null) return 'null';
    if (arg === undefined) return 'undefined';
    if (typeof arg === 'string') return arg.length > MAX_ARG_LEN ? arg.slice(0, MAX_ARG_LEN) + '...' : arg;
    if (arg instanceof Error) return arg.stack || arg.message || String(arg);
    try {
      var s = JSON.stringify(arg);
      return s && s.length > MAX_ARG_LEN ? s.slice(0, MAX_ARG_LEN) + '...' : s;
    } catch (e) {
      return String(arg);
    }
  }

  function record(level, args) {
    var entry = { level: level, args: args.map(serialize), timestamp: Date.now() };
    window.__YAAR_CONSOLE.push(entry);
    if (window.__YAAR_CONSOLE.length > MAX_ENTRIES) window.__YAAR_CONSOLE.shift();
    try {
      window.parent.postMessage({ type: '${APP_MSG.console}', level: level, args: entry.args, timestamp: entry.timestamp }, '*');
    } catch (e) {}
  }

  function intercept(level) {
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      origConsole[level].apply(console, args);
      record(level, args);
    };
  }

  intercept('log');
  intercept('warn');
  intercept('error');
  intercept('info');

  // Uncaught errors never reach console.*, so hooking the four console methods above
  // leaves an app that throws during mount with a genuinely empty buffer — which reads
  // downstream as "the app logged nothing" rather than "the app died". Same for a
  // rejected promise with no handler. Push both through the same record path so they
  // land in __YAAR_CONSOLE alongside everything else.
  window.addEventListener('error', function(ev) {
    // Resource-load failures (img/script/link) fire 'error' on the element and bubble
    // here with no ev.error. They are invisible to console.* — a broken <img> logs
    // nothing at all — so name the element and its URL explicitly.
    var target = ev.target;
    if (target && target !== window && target.tagName) {
      var src = target.src || target.href || '';
      record('error', ['[resource] failed to load <' + String(target.tagName).toLowerCase() + '>: ' + src]);
      return;
    }
    record('error', [ev.error || ev.message || 'Uncaught error']);
  }, true); // capture phase — resource errors do not bubble

  window.addEventListener('unhandledrejection', function(ev) {
    record('error', ['Unhandled promise rejection:', ev.reason]);
  });
})();
`;
