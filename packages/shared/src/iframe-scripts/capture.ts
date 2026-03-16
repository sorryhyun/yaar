/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Capture priority:
 *   1. Largest <canvas> element (direct toDataURL)
 *   2. Largest <svg> element (serialize → Image → canvas)
 *   3. Returns null — parent falls back to html2canvas on contentDocument
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  if (window.__yaarCaptureInstalled) return;
  window.__yaarCaptureInstalled = true;

  function respond(requestId, imageData) {
    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData
    }, '*');
  }

  /**
   * Render an SVG string to a canvas PNG data URL, then call cb(dataUrl).
   */
  function svgToCanvas(svgStr, w, h, cb) {
    var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function() {
      var c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      cb(c.toDataURL('image/png'));
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      cb(null);
    };
    img.src = url;
  }

  window.addEventListener('message', function(e) {
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
          imageData = largest.toDataURL('image/png');
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

      // No canvas or SVG found — return null so the parent can try
      // html2canvas on the iframe's contentDocument (more reliable than
      // foreignObject SVG which often produces blank/white images).
    } catch (ex) {
      // Capture failed, imageData stays null
    }

    respond(requestId, null);
  });
})();
`;
