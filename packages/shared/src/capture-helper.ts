/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Captures the largest <canvas> element, or falls back to SVG serialization.
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  if (window.__yaarCaptureInstalled) return;
  window.__yaarCaptureInstalled = true;

  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;
    var imageData = null;

    try {
      // Try capturing the largest canvas element
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

      // Fall back to SVG capture
      if (!imageData) {
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
            var w = rect.width || 300;
            var h = rect.height || 150;
            var img = new Image();
            var blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            img.onload = function() {
              var c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              var ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0, w, h);
              URL.revokeObjectURL(url);
              window.parent.postMessage({
                type: 'yaar:capture-response',
                requestId: requestId,
                imageData: c.toDataURL('image/png')
              }, '*');
            };
            img.onerror = function() {
              URL.revokeObjectURL(url);
              window.parent.postMessage({
                type: 'yaar:capture-response',
                requestId: requestId,
                imageData: null
              }, '*');
            };
            img.src = url;
            return; // async path — response sent from onload/onerror
          }
        }
      }
    } catch (ex) {
      // Capture failed, imageData stays null
    }

    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData
    }, '*');
  });
})();
`;
