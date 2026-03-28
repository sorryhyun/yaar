/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Capture priority:
 *   1. Largest <canvas> element (direct toDataURL)
 *   2. Largest <svg> element (serialize → Image → canvas)
 *   3. DOM capture via foreignObject SVG (browser-native CSS rendering)
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

  function handler(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;
    var imageData = null;

    try {
      // Tier 1: capture the largest canvas element
      var canvases = document.querySelectorAll('canvas');
      if (canvases.length > 0) {
        var largest = null;
        var largestArea = 0;
        for (var i = 0; i < canvases.length; i++) {
          var area = canvases[i].width * canvases[i].height;
          if (area > largestArea) {
            largestArea = area;
            largest = canvases[i];
          }
        }
        if (largest) {
          try { imageData = largest.toDataURL('image/png'); } catch(ex) {}
        }
      }

      if (imageData) {
        respond(requestId, imageData);
        return;
      }

      // Tier 2: capture the largest SVG element
      var svgs = document.querySelectorAll('svg');
      if (svgs.length > 0) {
        var largest = null;
        var largestArea = 0;
        for (var i = 0; i < svgs.length; i++) {
          var rect = svgs[i].getBoundingClientRect();
          var area = rect.width * rect.height;
          if (area > largestArea) {
            largestArea = area;
            largest = svgs[i];
          }
        }
        if (largest) {
          var serializer = new XMLSerializer();
          var svgStr = serializer.serializeToString(largest);
          var rect = largest.getBoundingClientRect();
          svgToCanvas(svgStr, rect.width || 300, rect.height || 150, function(data) {
            respond(requestId, data);
          });
          return; // async
        }
      }

      // Tier 3: DOM capture via foreignObject SVG
      // Clone the document, inline all computed styles and external resources
      // (images, CSS background-images as data URIs), then render through the
      // browser's native CSS engine.
      var docEl = document.documentElement;
      var w = docEl.clientWidth || docEl.scrollWidth;
      var h = docEl.clientHeight || docEl.scrollHeight;
      if (w > 0 && h > 0) {
        var clone = docEl.cloneNode(true);
        // Remove scripts from clone
        var scripts = clone.querySelectorAll('script');
        for (var i = scripts.length - 1; i >= 0; i--) scripts[i].remove();
        inlineStyles(clone, docEl);
        inlineResources(clone, docEl).then(function() {
          var serializer = new XMLSerializer();
          var xhtml = serializer.serializeToString(clone);
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
            '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
          svgToCanvas(svg, w, h, function(data) {
            respond(requestId, data);
          });
        }).catch(function() {
          respond(requestId, null);
        });
        return; // async
      }
    } catch (ex) {
      // Capture failed
    }

    respond(requestId, null);
  }

  window.__yaarCaptureHandler = handler;
  window.__yaarCaptureInstalled = true;
  window.addEventListener('message', handler);
})();
`;
