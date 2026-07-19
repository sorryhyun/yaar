/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Capture always aims to return a full "window screenshot" — the document as
 * rendered, with live canvas pixels composited in place:
 *   0. App-defined provider (`window.__yaarCaptureProvider`, wired from
 *      `app.register({ onCapture })`) — the app decides what to return
 *   1. Composite screenshot: DOM via foreignObject SVG, with each <canvas>
 *      swapped for an <img> carrying its current pixels
 *   2. Fallback: largest <canvas> alone (only if the composite render fails)
 *
 * Supports hot-upgrade: if an older version was compiled into the HTML,
 * the frontend-injected newer version removes the old handler and takes over.
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  // Hot-upgrade: remove previous handler so only the latest version responds
  if (window.__yaarCaptureHandler) {
    window.removeEventListener('message', window.__yaarCaptureHandler);
  }

  function respond(requestId, imageData) {
    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData
    }, '*');
  }

  /**
   * Render an SVG/foreignObject to a canvas data URL, then call cb(dataUrl).
   */
  function svgToCanvas(svgStr, w, h, cb) {
    // Use data URL instead of blob URL — Chromium is less strict about
    // tainting canvas from data-URL SVGs than blob-URL SVGs.
    var dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr);
    var img = new Image();
    img.onload = function() {
      try {
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        cb(c.toDataURL('image/webp', 0.9));
      } catch (ex) {
        cb(null);
      }
    };
    img.onerror = function() {
      cb(null);
    };
    img.src = dataUrl;
  }

  /**
   * Inline computed styles on a cloned DOM tree so foreignObject renders
   * correctly (resolves CSS custom properties, color-mix, etc.).
   * The clone must still mirror the original 1:1 — both trees are walked
   * in parallel by index.
   */
  function inlineStyles(clone, original) {
    var originals = original.querySelectorAll('*');
    var clones = clone.querySelectorAll('*');
    try { clone.style.cssText = window.getComputedStyle(original).cssText; } catch(e) {}
    for (var i = 0; i < originals.length && i < clones.length; i++) {
      try {
        if (clones[i].style) {
          clones[i].style.cssText = window.getComputedStyle(originals[i]).cssText;
        }
      } catch(e) {}
    }
  }

  /**
   * Inline external resources in a cloned DOM tree so foreignObject renders
   * them correctly (external URLs are blocked inside SVG foreignObject).
   * Fetches each <img> src as a blob and replaces with a data URI.
   * After inlining, sanitizes ALL remaining external URLs to prevent canvas tainting.
   * Like inlineStyles, pairs original and clone elements by index — call it
   * before anything mutates the clone's element list.
   */
  function inlineResources(clone, original) {
    return new Promise(function(resolve) {
      var tasks = [];

      // Inline <img> elements by fetching through the iframe fetch proxy
      var origImgs = original.querySelectorAll('img[src]');
      var cloneImgs = clone.querySelectorAll('img[src]');
      for (var i = 0; i < origImgs.length && i < cloneImgs.length; i++) {
        (function(cloneImg, src) {
          if (!src || src.startsWith('data:')) return;
          tasks.push(
            fetch(src)
              .then(function(r) { return r.blob(); })
              .then(function(blob) {
                return new Promise(function(res) {
                  var reader = new FileReader();
                  reader.onloadend = function() { res(reader.result); };
                  reader.onerror = function() { res(null); };
                  reader.readAsDataURL(blob);
                });
              })
              .then(function(dataUri) {
                if (dataUri) cloneImg.setAttribute('src', dataUri);
              })
              .catch(function() { /* skip failed resources */ })
          );
        })(cloneImgs[i], origImgs[i].src);
      }

      var after = function() {
        // Sanitize: strip ALL remaining external URLs to prevent canvas tainting.
        // Any <img> we couldn't inline gets a transparent pixel placeholder.
        var PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        var imgs = clone.querySelectorAll('img[src]');
        for (var i = 0; i < imgs.length; i++) {
          var s = imgs[i].getAttribute('src') || '';
          if (s && !s.startsWith('data:')) imgs[i].setAttribute('src', PIXEL);
        }
        // Remove <link> stylesheets (computed styles already inlined)
        var links = clone.querySelectorAll('link[rel="stylesheet"]');
        for (var i = links.length - 1; i >= 0; i--) links[i].remove();
        // Strip ALL url() except data: URIs from inline styles — any non-data
        // URL in foreignObject-as-image taints the canvas, even same-origin ones.
        var urlNotData = /url\\s*\\(\\s*["']?(?!data:)[^)]*\\)/g;
        var all = clone.querySelectorAll('*');
        for (var i = 0; i < all.length; i++) {
          try {
            var st = all[i].getAttribute('style');
            if (st && urlNotData.test(st)) {
              urlNotData.lastIndex = 0;
              all[i].setAttribute('style', st.replace(urlNotData, 'none'));
            }
            urlNotData.lastIndex = 0;
          } catch(e) {}
        }
        // Strip from <style> blocks too
        var styles = clone.querySelectorAll('style');
        for (var i = 0; i < styles.length; i++) {
          var css = styles[i].textContent || '';
          if (urlNotData.test(css)) {
            urlNotData.lastIndex = 0;
            styles[i].textContent = css.replace(urlNotData, 'none');
          }
          urlNotData.lastIndex = 0;
        }
        // Also strip src/href attributes that aren't data: URIs
        // (covers <source>, <video>, <audio>, <input type=image>, etc.)
        var srcEls = clone.querySelectorAll('[src]:not(script)');
        for (var i = 0; i < srcEls.length; i++) {
          var v = srcEls[i].getAttribute('src') || '';
          if (v && !v.startsWith('data:')) srcEls[i].removeAttribute('src');
        }
        resolve();
      };

      if (tasks.length === 0) { after(); return; }
      Promise.all(tasks).then(after).catch(after);
    });
  }

  /**
   * Snapshot a live canvas to a data URL. Returns null on tainted/empty canvases.
   * WebGL canvases without preserveDrawingBuffer may snapshot blank — that is a
   * platform limitation shared with the old largest-canvas capture.
   */
  function snapshotCanvas(c) {
    try {
      if (!c.width || !c.height) return null;
      return c.toDataURL('image/png');
    } catch (ex) {
      return null;
    }
  }

  /** Old tier-1 behavior, kept only as a last-resort fallback. */
  function largestCanvasCapture() {
    var canvases = document.querySelectorAll('canvas');
    var largest = null;
    var largestArea = 0;
    for (var i = 0; i < canvases.length; i++) {
      var area = canvases[i].width * canvases[i].height;
      if (area > largestArea) {
        largestArea = area;
        largest = canvases[i];
      }
    }
    return largest ? snapshotCanvas(largest) : null;
  }

  /**
   * Default capture: full window screenshot. Clones the document, inlines
   * computed styles and external resources, composites live canvas pixels in
   * place, then renders through the browser's native CSS engine via
   * foreignObject SVG.
   */
  function defaultCapture(requestId) {
    try {
      var docEl = document.documentElement;
      var w = docEl.clientWidth || docEl.scrollWidth;
      var h = docEl.clientHeight || docEl.scrollHeight;
      if (!(w > 0 && h > 0)) {
        respond(requestId, largestCanvasCapture());
        return;
      }

      var clone = docEl.cloneNode(true);
      // Order matters: inlineStyles/inlineResources pair original and clone
      // elements by index, so they must run while the clone is still an exact
      // mirror. Canvas swapping and script removal mutate the clone afterwards.
      inlineStyles(clone, docEl);
      inlineResources(clone, docEl).then(function() {
        // Composite canvases: swap each cloned <canvas> for an <img> carrying
        // the live pixels — canvas content never survives cloneNode.
        var origCanvases = docEl.querySelectorAll('canvas');
        var cloneCanvases = clone.querySelectorAll('canvas');
        for (var i = 0; i < origCanvases.length && i < cloneCanvases.length; i++) {
          var data = snapshotCanvas(origCanvases[i]);
          if (!data) continue;
          var img = document.createElement('img');
          img.src = data;
          var cc = cloneCanvases[i];
          // The inlined cssText already carries the canvas's layout box
          if (cc.style && cc.style.cssText) img.style.cssText = cc.style.cssText;
          if (cc.parentNode) cc.parentNode.replaceChild(img, cc);
        }
        // Remove scripts from clone (after index-paired passes)
        var scripts = clone.querySelectorAll('script');
        for (var i = scripts.length - 1; i >= 0; i--) scripts[i].remove();

        var serializer = new XMLSerializer();
        var xhtml = serializer.serializeToString(clone);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
        svgToCanvas(svg, w, h, function(data) {
          respond(requestId, data || largestCanvasCapture());
        });
      }).catch(function() {
        respond(requestId, largestCanvasCapture());
      });
    } catch (ex) {
      var fallback = null;
      try { fallback = largestCanvasCapture(); } catch (ex2) {}
      respond(requestId, fallback);
    }
  }

  function handler(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;

    // Tier 0: app-defined capture provider (app.register({ onCapture }) or a
    // directly assigned window.__yaarCaptureProvider). Must return a data-URL
    // image (string), sync or async; anything else falls back to the default.
    var provider = window.__yaarCaptureProvider;
    if (typeof provider === 'function') {
      try {
        Promise.resolve(provider()).then(function(data) {
          if (typeof data === 'string' && data.indexOf('data:image/') === 0) {
            respond(requestId, data);
          } else {
            defaultCapture(requestId);
          }
        }).catch(function() {
          defaultCapture(requestId);
        });
        return;
      } catch (ex) {
        // fall through to default capture
      }
    }

    defaultCapture(requestId);
  }

  window.__yaarCaptureHandler = handler;
  window.__yaarCaptureInstalled = true;
  window.addEventListener('message', handler);
})();
`;
