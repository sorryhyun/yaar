/**
 * Inline JS device SDK for iframe apps.
 *
 * Provides `window.yaar.device` — the desktop's form factor (`mobile` is the phone shell,
 * where the app's window is a full-screen card), how the device is held, and whether this
 * app's card has been blown up over the whole screen — so an app can switch to a landscape
 * or immersive layout without guessing from its own size, which a soft keyboard shrinks
 * and a split screen reshapes. `setFullscreen` asks for that last one; the desktop decides
 * (see `requestAppFullscreen` in the frontend's ui slice) and the answer comes back as an
 * update like any other.
 *
 * The desktop is the one source: the frame asks once on install (`yaar:device-request`)
 * and the desktop pushes `yaar:device-update` on every change after that. Until the
 * answer lands the state is a local guess — `desktop`, and whatever `screen.orientation`
 * says — which is what a frame opened outside YAAR keeps.
 *
 * `host` is what YAAR's own desktop window offers, or null in a browser: the shell reports
 * it (the frame cannot see `window.yaarHost`, which lives in the main frame only) so an app
 * knows whether its downloads are saved by the shell (`downloadBlob`) and which platform's
 * settings to point a user at.
 *
 * `visible` is whether anyone can see this frame: the desktop says whether the window is on
 * screen (not minimized, on the active monitor — a frame cannot tell, because a hidden window
 * stays mounted under `visibility: hidden`), and the frame's own `visibilitychange` says
 * whether the whole page is (a backgrounded tab or phone). Either one hiding it is hidden.
 *
 * Mirrored onto `<html data-form-factor data-orientation>` and a present-or-absent
 * `data-fullscreen`, so app CSS can branch on it without script.
 */
import { APP_MSG } from '../app-protocol.js';
import { installGuard, YAAR_NAMESPACE } from './prelude.js';
export const IFRAME_DEVICE_SDK_SCRIPT = `
(function() {
  ${installGuard('__yaarDeviceInstalled')}
  ${YAAR_NAMESPACE}

  function localOrientation() {
    try {
      var type = screen.orientation && screen.orientation.type;
      if (type) return type.indexOf('landscape') === 0 ? 'landscape' : 'portrait';
    } catch(e) {}
    return window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  }

  function pageVisible() {
    return document.visibilityState !== 'hidden';
  }

  // The desktop's half of "visible"; true until it says otherwise, and forever outside YAAR.
  var shown = true;
  var state = {
    formFactor: 'desktop',
    orientation: localOrientation(),
    fullscreen: false,
    visible: pageVisible(),
    host: null
  };
  var callbacks = [];

  function mirror() {
    var root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-form-factor', state.formFactor);
    root.setAttribute('data-orientation', state.orientation);
    if (state.fullscreen) root.setAttribute('data-fullscreen', '');
    else root.removeAttribute('data-fullscreen');
  }

  function snapshot() {
    return {
      formFactor: state.formFactor,
      orientation: state.orientation,
      fullscreen: state.fullscreen,
      visible: state.visible,
      host: state.host
    };
  }

  function commit(next) {
    if (
      next.formFactor === state.formFactor &&
      next.orientation === state.orientation &&
      next.fullscreen === state.fullscreen &&
      next.visible === state.visible &&
      JSON.stringify(next.host) === JSON.stringify(state.host)
    ) return;
    state = next;
    mirror();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snapshot()); } catch(err) {}
    }
  }

  mirror();

  document.addEventListener('visibilitychange', function() {
    var next = snapshot();
    next.visible = shown && pageVisible();
    commit(next);
  });

  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || d.type !== '${APP_MSG.deviceUpdate}') return;
    var formFactor = d.formFactor === 'mobile' ? 'mobile' : 'desktop';
    var orientation = d.orientation === 'landscape' ? 'landscape' : 'portrait';
    var fullscreen = d.fullscreen === true;
    // Absent means shown: a desktop older than the field never hid anything it could report.
    shown = d.visible !== false;
    var host = d.host && typeof d.host.platform === 'string' && Array.isArray(d.host.caps)
      ? { platform: d.host.platform, caps: d.host.caps.filter(function(c) { return typeof c === 'string'; }) }
      : null;
    commit({
      formFactor: formFactor,
      orientation: orientation,
      fullscreen: fullscreen,
      visible: shown && pageVisible(),
      host: host
    });
  });

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: '${APP_MSG.deviceRequest}' }, '*');
  }

  window.yaar.device = {
    get: snapshot,
    setFullscreen: function(on) {
      if (!window.parent || window.parent === window) return;
      window.parent.postMessage({ type: '${APP_MSG.deviceSetFullscreen}', on: on === true }, '*');
    },
    onChange: function(cb) {
      callbacks.push(cb);
      try { cb(snapshot()); } catch(e) {}
      return function() {
        callbacks = callbacks.filter(function(fn) { return fn !== cb; });
      };
    }
  };
})();
`;
