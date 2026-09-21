'use strict';
/**
 * LSET1: pure text-shaping helper for the settings screen. No DOM, so the middle-ellipsis
 * math is a plain node test rather than eyeballing a screenshot at every possible window
 * width — see seatshape.js for the same pattern and why it exists (app.js loads straight
 * into an Electron BrowserWindow with no module boundary and no test runner).
 *
 * A CSS end-ellipsis on a file path throws away the one part that actually tells two Java
 * installs apart — the filename at the tail. A middle ellipsis keeps both ends. The CSS in
 * styles.css (`.field span.mono`) still hard-clips with an end-ellipsis on top of whatever
 * this produces, so containment never depends on this function alone.
 */
(function (root) {
  /**
   * Collapses `s` to at most `max` characters, dropping the middle and replacing it with a
   * single ellipsis. Never returns more than `max` characters. An odd remainder favours the
   * head (drive + folders) over the tail by one character; both ends survive down to the
   * smallest width this is ever asked for.
   */
  function middleEllipsis(s, max) {
    s = String(s == null ? '' : s);
    max = Math.max(1, max | 0);
    if (s.length <= max) return s;
    if (max === 1) return '…';
    const keep = max - 1;
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return tail > 0 ? `${s.slice(0, head)}…${s.slice(s.length - tail)}` : `${s.slice(0, head)}…`;
  }

  const api = { middleEllipsis };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TextFit = api;
})(typeof window !== 'undefined' ? window : undefined);
