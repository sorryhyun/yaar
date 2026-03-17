/**
 * Console capture script injected into compiled app iframes.
 *
 * Overrides console.log/warn/error/info to post messages to the parent frame.
 * DevTools can listen for these messages to display console output.
 */
export const IFRAME_CONSOLE_CAPTURE_SCRIPT = `
(function() {
  if (window.__yaarConsoleInstalled) return;
  window.__yaarConsoleInstalled = true;

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

  function intercept(level) {
    console[level] = function() {
      var args = Array.prototype.slice.call(arguments);
      origConsole[level].apply(console, args);
      var entry = {
        level: level,
        args: args.map(serialize),
        timestamp: Date.now()
      };
      window.__YAAR_CONSOLE.push(entry);
      if (window.__YAAR_CONSOLE.length > MAX_ENTRIES) {
        window.__YAAR_CONSOLE.shift();
      }
      try {
        window.parent.postMessage({ type: 'yaar:console', level: level, args: entry.args, timestamp: entry.timestamp }, '*');
      } catch (e) {}
    };
  }

  intercept('log');
  intercept('warn');
  intercept('error');
  intercept('info');
})();
`;
