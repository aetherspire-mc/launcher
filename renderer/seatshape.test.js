'use strict';
/**
 * C6 — no test runner in launcher/package.json (only a `check` script that syntax-checks
 * files), so this is a plain node script asserting against the real seatshape.js the
 * renderer loads, per COMMON.md's "a pure JS module test via node is acceptable". Run:
 *   node launcher/renderer/seatshape.test.js
 * Exits non-zero on the first failed assertion.
 */
const assert = require('assert');
const { seatDots, headcountRange } = require('./seatshape.js');

// --- seatDots -----------------------------------------------------------------------

{
  const html = seatDots({ minPlayers: 2, maxPlayers: 5 });
  const on = (html.match(/dot on/g) || []).length;
  const off = (html.match(/dot off/g) || []).length;
  assert.strictEqual(on, 2, 'filled pips == minPlayers');
  assert.strictEqual(off, 3, 'empty pips == maxPlayers - minPlayers');
}

{
  // A fixed-size run (min == max): every pip filled, none empty.
  const html = seatDots({ minPlayers: 9, maxPlayers: 9 });
  assert.strictEqual((html.match(/dot on/g) || []).length, 9);
  assert.strictEqual((html.match(/dot off/g) || []).length, 0);
}

{
  // Missing/zero fields never produce zero or negative pips.
  const html = seatDots({});
  assert.strictEqual((html.match(/dot on/g) || []).length, 1);
  assert.strictEqual((html.match(/dot off/g) || []).length, 0);
}

{
  // maxPlayers smaller than minPlayers (bad data) clamps rather than drawing negative pips.
  const html = seatDots({ minPlayers: 5, maxPlayers: 2 });
  assert.strictEqual((html.match(/dot on/g) || []).length, 5);
  assert.strictEqual((html.match(/dot off/g) || []).length, 0);
}

{
  // C6-fix1 LOW 7: a non-empty seats map draws role pips (B/M/S), not headcount pips —
  // and with no live roster on the row, every pip starts empty.
  const html = seatDots({ seats: { BULWARK: 2, MENDER: 3, STRIKER: 4 } });
  assert.ok(/seat-role-tag">B</.test(html), 'Bulwark labelled B');
  assert.ok(/seat-role-tag">M</.test(html), 'Mender labelled M');
  assert.ok(/seat-role-tag">S</.test(html), 'Striker labelled S');
  assert.strictEqual((html.match(/dot on/g) || []).length, 0, 'no roster on the row: nothing filled');
  assert.strictEqual((html.match(/dot off/g) || []).length, 9, '2 + 3 + 4 seats, all open');
}

{
  // Role pips fill by the live roster count when the JSON carries one.
  const html = seatDots({ seats: { BULWARK: 1, MENDER: 2 }, roster: { BULWARK: 1, MENDER: 1 } });
  assert.strictEqual((html.match(/dot on/g) || []).length, 2, 'BULWARK 1/1 + MENDER 1/2 filled');
  assert.strictEqual((html.match(/dot off/g) || []).length, 1, 'MENDER still short one seat');
}

{
  // Roster over-reports (bad data): a role never shows more filled pips than it has seats.
  const html = seatDots({ seats: { BULWARK: 1 }, roster: { BULWARK: 5 } });
  assert.strictEqual((html.match(/dot on/g) || []).length, 1);
  assert.strictEqual((html.match(/dot off/g) || []).length, 0);
}

{
  // An empty seats object is not "has a seat shape" — falls back to headcount pips.
  const html = seatDots({ seats: {}, minPlayers: 2, maxPlayers: 5 });
  assert.ok(!html.includes('seat-role'));
  assert.strictEqual((html.match(/dot on/g) || []).length, 2);
  assert.strictEqual((html.match(/dot off/g) || []).length, 3);
}

// --- headcountRange -------------------------------------------------------------------

{
  assert.strictEqual(headcountRange([{ minPlayers: 2, maxPlayers: 5 }]), '2-5');
}

{
  // Every instance in the tier shares the same fixed size: one number, not "9-9".
  assert.strictEqual(
      headcountRange([{ minPlayers: 9, maxPlayers: 9 }, { minPlayers: 9, maxPlayers: 9 }]), '9');
}

{
  // Mixed content in one tier (e.g. two Raids with different overrides) spans the widest range.
  assert.strictEqual(
      headcountRange([{ minPlayers: 2, maxPlayers: 5 }, { minPlayers: 3, maxPlayers: 4 }]), '2-5');
}

console.log('seatshape.test.js: all assertions passed');
