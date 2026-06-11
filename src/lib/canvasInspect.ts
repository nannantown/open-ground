// In-iframe inspect bridge for Canvas screen / mock tiles.
//
// `buildInspectScript()` returns a plain-JS snippet that both srcdoc builders
// (screenSrcdoc / mockSrcdoc) inline as a <script>. It implements the
// "tweak" picking protocol between the host page and the sandboxed iframe:
//
//   parent → iframe : { og: 'inspect', on: boolean }   toggle inspect mode
//   iframe → parent : { og: 'pick', payload: {...} }   user clicked an element
//
// While inspect mode is ON the script tracks mousemove and outlines the
// hovered element with a pointer-events:none overlay div (so no element
// styles are touched and nothing needs restoring), and captures clicks —
// preventDefault + stopPropagation so the design's own handlers (buttons,
// links) never fire — reporting the clicked element to the parent. OFF
// removes the listeners and the overlay.
//
// The iframe is sandboxed `allow-scripts` only (NO allow-same-origin), so the
// content is a cross-origin opaque window: both directions must post with
// targetOrigin '*'. The host side filters by `e.source === iframe.contentWindow`
// instead, which uniquely identifies the tile.

/** What the bridge reports for a picked element ({ og:'pick', payload }). */
export interface InspectPick {
  tag: string
  classes: string
  text: string
  html: string
  rect: { x: number; y: number; w: number; h: number }
}

/** Marker comment embedded in the snippet — lets tests (and humans reading a
 *  generated srcdoc) confirm the bridge made it into the document. */
export const INSPECT_MARKER = '__og_inspect_bridge__'

/** Truncation limits mirrored in the snippet below (and asserted by tests). */
export const INSPECT_HTML_LIMIT = 2000
export const INSPECT_TEXT_LIMIT = 200

export function buildInspectScript(): string {
  return `/* ${INSPECT_MARKER} */(function () {
  var on = false;
  var hl = null;
  function ensureHl() {
    if (hl && hl.parentNode) return hl;
    hl = document.createElement('div');
    hl.id = '__og_inspect_hl';
    hl.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;display:none;' +
      'border:1.5px solid #B23A2C;background:rgba(178,58,44,0.08);border-radius:2px;';
    document.body.appendChild(hl);
    return hl;
  }
  function hideHl() { if (hl) hl.style.display = 'none'; }
  function dropHl() { if (hl && hl.parentNode) hl.parentNode.removeChild(hl); hl = null; }
  // The pickable target under an event: any real element except the document
  // root/body, our own overlay, and the error overlay.
  function targetOf(e) {
    var t = e.target;
    if (!t || t === document.body || t === document.documentElement) return null;
    if (t.nodeType !== 1) return null;
    if (t.id === '__og_inspect_hl' || t.id === '__opengrnd_err') return null;
    return t;
  }
  function onMove(e) {
    var t = targetOf(e);
    if (!t) { hideHl(); return; }
    var r = t.getBoundingClientRect();
    var d = ensureHl();
    d.style.display = 'block';
    d.style.left = r.left + 'px';
    d.style.top = r.top + 'px';
    d.style.width = r.width + 'px';
    d.style.height = r.height + 'px';
  }
  // Swallow the press in capture so the design's own mousedown/up handlers
  // stay quiet too (no preventDefault here — that would cancel the click).
  function onPress(e) { e.stopPropagation(); }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    var t = targetOf(e);
    if (!t) return;
    var r = t.getBoundingClientRect();
    var cls = typeof t.className === 'string'
      ? t.className
      : (t.getAttribute && t.getAttribute('class')) || '';
    var html = t.outerHTML || '';
    if (html.length > ${INSPECT_HTML_LIMIT}) html = html.slice(0, ${INSPECT_HTML_LIMIT});
    var text = (t.textContent || '').slice(0, ${INSPECT_TEXT_LIMIT});
    parent.postMessage({
      og: 'pick',
      payload: {
        tag: (t.tagName || '').toLowerCase(),
        classes: cls,
        text: text,
        html: html,
        rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      },
    }, '*');
  }
  function setOn(v) {
    if (v === on) return;
    on = v;
    if (v) {
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mousedown', onPress, true);
      document.addEventListener('mouseup', onPress, true);
      document.addEventListener('pointerdown', onPress, true);
      document.addEventListener('pointerup', onPress, true);
      document.addEventListener('touchstart', onPress, true);
      document.addEventListener('touchend', onPress, true);
      document.addEventListener('click', onClick, true);
    } else {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mousedown', onPress, true);
      document.removeEventListener('pointerdown', onPress, true);
      document.removeEventListener('pointerup', onPress, true);
      document.removeEventListener('touchstart', onPress, true);
      document.removeEventListener('touchend', onPress, true);
      document.removeEventListener('mouseup', onPress, true);
      document.removeEventListener('click', onClick, true);
      dropHl();
    }
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.og !== 'inspect') return;
    setOn(!!d.on);
  });
})();`
}
