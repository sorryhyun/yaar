/**
 * Inline JS capture helper script for iframe self-capture.
 *
 * Injected into iframes so the parent can request a screenshot via postMessage.
 * Capture always aims to return a full "window screenshot" — the document as
 * rendered, with live canvas pixels composited in place:
 *   0. App-defined provider (`window.__yaarCaptureProvider`, wired from
 *      `defineApp({ onCapture })`) — the app decides what to return
 *   1. Composite screenshot: DOM via foreignObject SVG, with each <canvas>
 *      swapped for an <img> carrying its current pixels
 *   2. Fallback: largest <canvas> alone (only if the composite render fails)
 *
 * Supports hot-upgrade: if an older version was compiled into the HTML,
 * the frontend-injected newer version removes the old handler and takes over.
 *
 * Failure reasons. A response carrying `imageData: null` also carries a `reason`,
 * so "the canvas was tainted" stops being indistinguishable from "nothing is
 * listening" (the old bare null, which the parent could only wait out):
 *   'taint'           — toDataURL/drawImage threw; an external resource poisoned
 *                       the canvas. Deterministic; retrying cannot help.
 *   'img-load-error'  — the serialized SVG data URL failed to load as an image.
 *   'zero-size'       — the document had no layout box and no canvas to fall back to.
 *   'serialize-error' — XMLSerializer or the clone/inline pipeline threw.
 *   'no-provider'     — nothing in the window produced an image and no more
 *                       specific cause could be attributed (e.g. an app-defined
 *                       onCapture returned a non-image and the default path also
 *                       came back empty).
 * The reason field is what makes a null terminal for the parent — a bare null
 * from an older compiled-in handler stays ignorable. See iframe-bridge/capture.ts.
 */
export const IFRAME_CAPTURE_HELPER_SCRIPT = `
(function() {
  // Hot-upgrade: remove previous handler so only the latest version responds
  if (window.__yaarCaptureHandler) {
    window.removeEventListener('message', window.__yaarCaptureHandler);
  }

  function respond(requestId, imageData, reason) {
    window.parent.postMessage({
      type: 'yaar:capture-response',
      requestId: requestId,
      imageData: imageData,
      // Only attach a reason to failures — a successful response is unchanged.
      reason: imageData ? undefined : (reason || 'no-provider')
    }, '*');
  }

  /**
   * Render an SVG/foreignObject to a canvas data URL, then call cb(dataUrl, reason).
   * On success the reason is undefined; on failure dataUrl is null and reason
   * names the cause.
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
        // drawImage/toDataURL only throw here for a tainted (cross-origin) canvas.
        cb(null, 'taint');
      }
    };
    img.onerror = function() {
      cb(null, 'img-load-error');
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
   * Copy live form state onto the clone as attributes.
   *
   * cloneNode(true) copies attributes, not IDL properties. A value assigned in
   * JS (\`input.value = x\`, or a Solid/React \`value=\` binding, which is a
   * property assignment) never touches the \`value\` attribute, so the clone
   * serializes with its *default* — an app that fills its fields at mount
   * screenshots as a form of empty boxes while the live DOM is populated.
   * Same for textarea text, option selection, and checkbox/radio state.
   *
   * Index-paired against the original like inlineStyles, so it must run while
   * the clone is still an exact mirror.
   */
  function inlineFormState(clone, original) {
    // Only the tags handled below, so both trees pair on the same element set.
    var SEL = 'input, textarea, option';
    var originals = original.querySelectorAll(SEL);
    var clones = clone.querySelectorAll(SEL);
    for (var i = 0; i < originals.length && i < clones.length; i++) {
      try {
        var o = originals[i];
        var c = clones[i];
        var tag = (o.tagName || '').toLowerCase();
        if (tag === 'input') {
          var type = (o.getAttribute('type') || o.type || 'text').toLowerCase();
          if (type === 'checkbox' || type === 'radio') {
            // The attribute is defaultChecked; the property is the live state.
            if (o.checked) c.setAttribute('checked', '');
            else c.removeAttribute('checked');
          } else if (type === 'file') {
            // No settable serialization — the browser paints its own chrome.
            continue;
          } else if (type === 'password') {
            // Same pixels the browser draws (dots) without carrying the secret
            // into the serialized clone.
            var len = (o.value || '').length;
            c.setAttribute('value', new Array(len + 1).join('\\u2022'));
          } else {
            c.setAttribute('value', o.value == null ? '' : String(o.value));
          }
        } else if (tag === 'textarea') {
          // A textarea renders its child text, not a value attribute.
          c.textContent = o.value == null ? '' : String(o.value);
        } else if (tag === 'option') {
          // Carries which option the closed <select> displays.
          if (o.selected) c.setAttribute('selected', '');
          else c.removeAttribute('selected');
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
        // The lookahead must swallow the quote/whitespace itself ([\\s"']*), not sit
        // after it: getComputedStyle() emits url("data:...") WITH double quotes, and a
        // quote-first pattern (["']?(?!data:)) — or one with a separate \\s* the engine
        // can backtrack to zero — lets the lookahead pass at the quote and strips the
        // very data-URI backgrounds we mean to keep.
        var urlNotData = /url\\s*\\(\\s*(?![\\s"']*data:)[^)]*\\)/g;
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
   * Make the clone XML-serializable. XMLSerializer does not guarantee
   * well-formed XML for an HTML-parsed tree, and the SVG-as-image load is an
   * XML parse — so markup the live DOM renders fine can still kill the whole
   * snapshot with 'img-load-error'. Scraped/pasted content is the usual source:
   *   - comments containing "--" (invalid in an XML comment)
   *   - fake-namespace elements like <o:p> from Word paste — serialized with an
   *     unbound prefix, an instant parse error
   *   - attribute names that are not XML Names (broken markup the HTML parser
   *     shrugs at), including unbound-prefix attributes like v:shapes
   *   - control characters outside the XML 1.0 range in text or attributes
   * Mutates only the clone; must run after the index-paired passes.
   */
  function scrubForXml(root) {
    // XML 1.0 forbids C0 controls other than tab/LF/CR, plus U+FFFE/U+FFFF.
    // Lone surrogates are handled separately (a paired one is a valid astral char).
    var badChars = /[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]/g;
    var loneHigh = /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])/g;
    // After lone highs are gone, every remaining high starts a valid pair —
    // so a low is legitimate iff a high precedes it: keep pairs, drop bare lows.
    var lowOrPair = /[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[\\uDC00-\\uDFFF]/g;
    function cleanText(s) {
      return s
        .replace(badChars, '')
        .replace(loneHigh, '')
        .replace(lowOrPair, function (m) {
          return m.length === 2 ? m : '';
        });
    }
    // Conservative ASCII XML Name. No colon: a colon in a null-namespace
    // node's qualified name is a fake prefix the serializer will emit unbound.
    // Genuinely namespaced nodes (inline SVG, xlink:href) carry a real
    // namespaceURI and are left alone — the serializer declares those bindings.
    var validName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
    var XHTML_NS = 'http://www.w3.org/1999/xhtml';

    // Comments render nothing and PIs don't exist in sane HTML — drop both.
    var walker = document.createTreeWalker(root, 192 /* COMMENT | PI */, null);
    var junk = [];
    while (walker.nextNode()) junk.push(walker.currentNode);
    for (var i = 0; i < junk.length; i++) {
      if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    }

    // Reverse order so an invalid element nested in another is unwrapped first.
    var els = root.querySelectorAll('*');
    for (var i = els.length - 1; i >= 0; i--) {
      var el = els[i];
      var ns = el.namespaceURI;
      if ((ns == null || ns === XHTML_NS) && !validName.test(el.nodeName || '')) {
        // Unwrap: keep the content, lose the unserializable tag.
        var parent = el.parentNode;
        if (!parent) continue;
        while (el.firstChild) parent.insertBefore(el.firstChild, el);
        parent.removeChild(el);
        continue;
      }
      var attrs = el.attributes;
      for (var j = attrs.length - 1; j >= 0; j--) {
        var a = attrs[j];
        try {
          if (a.namespaceURI == null && a.name !== 'xmlns' && !validName.test(a.name)) {
            el.removeAttributeNode(a);
          } else if (a.value) {
            var cleaned = cleanText(a.value);
            if (cleaned !== a.value) a.value = cleaned;
          }
        } catch (e) {}
      }
    }

    var textWalker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, null);
    while (textWalker.nextNode()) {
      var t = textWalker.currentNode;
      var cleanedT = cleanText(t.nodeValue || '');
      if (cleanedT !== t.nodeValue) t.nodeValue = cleanedT;
    }
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
        // No layout box. The canvas fallback may still have pixels; if it doesn't,
        // the window simply has not been laid out yet.
        respond(requestId, largestCanvasCapture(), 'zero-size');
        return;
      }

      var clone = docEl.cloneNode(true);
      // Order matters: inlineStyles/inlineFormState/inlineResources pair
      // original and clone elements by index, so they must run while the clone
      // is still an exact mirror. Canvas swapping and script removal mutate the
      // clone afterwards.
      inlineStyles(clone, docEl);
      inlineFormState(clone, docEl);
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
        // Last mutation before serializing: markup the HTML parser tolerated
        // but XML rejects would otherwise fail the whole snapshot load.
        try { scrubForXml(clone); } catch (e) {}

        var svg;
        try {
          var serializer = new XMLSerializer();
          var xhtml = serializer.serializeToString(clone);
          svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
            '<foreignObject width="100%" height="100%">' + xhtml + '</foreignObject></svg>';
        } catch (ex) {
          respond(requestId, largestCanvasCapture(), 'serialize-error');
          return;
        }
        svgToCanvas(svg, w, h, function(data, reason) {
          // The canvas fallback can rescue the pixels, but not the diagnosis: if it
          // also comes back empty, report why the real capture failed.
          respond(requestId, data || largestCanvasCapture(), reason);
        });
      }).catch(function() {
        respond(requestId, largestCanvasCapture(), 'serialize-error');
      });
    } catch (ex) {
      var fallback = null;
      try { fallback = largestCanvasCapture(); } catch (ex2) {}
      respond(requestId, fallback, 'serialize-error');
    }
  }

  function handler(e) {
    if (!e.data || e.data.type !== 'yaar:capture-request') return;
    var requestId = e.data.requestId;

    // Tier 0: app-defined capture provider (defineApp({ onCapture }) or a
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
