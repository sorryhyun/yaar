/**
 * Inline JS notifications SDK for iframe apps.
 *
 * Provides window.yaar.notifications with list/count/onChange methods
 * so compiled apps can reactively track the parent's notification state.
 * Parent pushes updates via `yaar:notifications-update` postMessages.
 */
export const IFRAME_NOTIFICATIONS_SDK_SCRIPT = `
(function() {
  if (window.__yaarNotificationsInstalled) return;
  window.__yaarNotificationsInstalled = true;

  window.yaar = window.yaar || {};

  var items = [];
  var callbacks = [];

  function notify() {
    for (var i = 0; i < callbacks.length; i++) {
      try { callbacks[i](items); } catch(e) {}
    }
  }

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:notifications-update') return;
    items = Array.isArray(e.data.items) ? e.data.items : [];
    notify();
  });

  window.yaar.notifications = {
    list: function() { return items; },
    count: function() { return items.length; },
    onChange: function(cb) {
      callbacks.push(cb);
      try { cb(items); } catch(e) {}
      return function() {
        callbacks = callbacks.filter(function(fn) { return fn !== cb; });
      };
    }
  };
})();
`;
