/**
 * Inline JS device SDK for iframe apps.
 *
 * Provides `window.yaar.device` — the desktop's form factor (`mobile` is the phone shell,
 * where the app's window is a full-screen card) and how the device is held — so an app
 * can switch to a landscape layout without guessing from its own size, which a soft
 * keyboard shrinks and a split screen reshapes.
 *
 * The desktop is the one source: the frame asks once on install (`yaar:device-request`)
 * and the desktop pushes `yaar:device-update` on every change after that. Until the
 * answer lands the state is a local guess — `desktop`, and whatever `screen.orientation`
 * says — which is what a frame opened outside YAAR keeps.
 *
 * Mirrored onto `<html data-form-factor data-orientation>`, so app CSS can branch on it
 * without script.
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

  var state = { formFactor: 'desktop', orientation: localOrientation() };
  var callbacks = [];

  function mirror() {
    var root = document.documentElement;
    if (!root) return;
    root.setAttribute('data-form-factor', state.formFactor);
    root.setAttribute('data-orientation', state.orientation);
  }

  function snapshot() {
    return { formFactor: state.formFactor, orientation: state.orientation };
  }

  mirror();

  window.addEventListener('message', function(e) {
    var d = e.data;
    if (!d || d.type !== '${APP_MSG.deviceUpdate}') return;
    var formFactor = d.formFactor === 'mobile' ? 'mobile' : 'desktop';
    var orientation = d.orientation === 'landscape' ? 'landscape' : 'portrait';
    if (formFactor === state.formFactor && orientation === state.orientation) return;
    state = { formFactor: formFactor, orientation: orientation };
    mirror();
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](snapshot()); } catch(err) {}
    }
  });

  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: '${APP_MSG.deviceRequest}' }, '*');
  }

  window.yaar.device = {
    get: snapshot,
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
