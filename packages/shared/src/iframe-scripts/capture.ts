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
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function() {
      try {
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        cb(c.toDataURL('image/webp', 0.9));
      } catch (ex) {
        URL.revokeObjectURL(url);
        cb(null);
      }
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
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
      // Clone the document, inline all computed styles (resolves CSS vars,
      // color-mix, etc.), then render through the browser's native CSS engine.
      var docEl = document.documentElement;
      var w = docEl.clientWidth || docEl.scrollWidth;
      var h = docEl.clientHeight || docEl.scrollHeight;
      if (w > 0 && h > 0) {
        var clone = docEl.cloneNode(true);
        // Remove scripts from clone
        var scripts = clone.querySelectorAll('script');
        for (var i = scripts.length - 1; i >= 0; i--) scripts[i].remove();
        inlineStyles(clone, docEl);
        var serializer = new XMLSerializer();
        var xhtml = serializer.serializeToString(clone);
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
          '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
        svgToCanvas(svg, w, h, function(data) {
          respond(requestId, data);
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
