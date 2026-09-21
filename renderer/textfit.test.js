'use strict';
/**
 * LSET1 — plain node test against the real textfit.js the renderer loads (same rationale
 * as seatshape.test.js). Run: node launcher/renderer/textfit.test.js
 */
const assert = require('assert');
const { middleEllipsis } = require('./textfit.js');

// Short enough already: untouched.
assert.strictEqual(middleEllipsis('short', 20), 'short');
assert.strictEqual(middleEllipsis('exactlyten', 10), 'exactlyten');

// Over budget: collapses to exactly `max` chars, both ends preserved, ellipsis in the middle.
{
  const out = middleEllipsis('abcdefghijklmnopqrstuvwxyz', 11);
  assert.strictEqual(out.length, 11);
  assert.ok(out.includes('…'));
  assert.ok(out.startsWith('abcde'), 'keeps the head');
  assert.ok(out.endsWith('vwxyz'), 'keeps the tail');
}

// A real 200-character-class Java path: never exceeds the budget, keeps the drive and the
// filename (javaw.exe) — an end-ellipsis would have thrown the filename away.
{
  const longPath = 'C:\\Users\\manie\\AppData\\Local\\Programs\\Eclipse Adoptium\\'
    + 'jdk-21.0.4.7-hotspot-very-long-vendor-suffix-that-keeps-going-and-going\\bin\\javaw.exe';
  assert.ok(longPath.length > 120, 'fixture is actually long');
  const out = middleEllipsis(longPath, 56);
  assert.ok(out.length <= 56);
  assert.ok(out.startsWith('C:\\Users\\manie'));
  assert.ok(out.endsWith('javaw.exe'));
}

// Degenerate budgets never throw or go negative.
assert.strictEqual(middleEllipsis('anything', 1), '…');
assert.strictEqual(middleEllipsis('', 10), '');
assert.strictEqual(middleEllipsis(null, 10), '');
assert.strictEqual(middleEllipsis('ab', 0).length, 1);

console.log('textfit.test.js: all assertions passed');
