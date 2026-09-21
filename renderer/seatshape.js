'use strict';
/**
 * Pure seat-shape math for the Play page — a row of pips per instance and the headcount
 * range a tier card's header shows. No DOM here, on purpose: this is the one piece of
 * app.js's Play page worth pinning with a real test, and app.js itself loads straight into
 * an Electron BrowserWindow (`window.aether` at the top of the file) with no module boundary
 * and no test runner in package.json. Attached to `window` for the
 * renderer, exported via `module.exports` too so a plain `node` test runs against this exact
 * file, not a copy of its logic.
 */
(function (root) {
  const ROLE_LABEL = { BULWARK: 'B', MENDER: 'M', STRIKER: 'S' };

  /** Clamped [min,max] this instance actually offers — never negative, never inverted. */
  function seatRange(r) {
    const min = Math.max(1, r.minPlayers || 1);
    const max = Math.max(min, r.maxPlayers || min);
    return { min, max };
  }

  /**
   * A row of pips for one instance. C6-fix1 LOW 7: when the API reports a seat shape
   * (`r.seats`, non-empty — today only Ascension, and only what
   * DungeonManager.checkRoster actually enforces, C6-fix1 MED 1), draw one pip group per
   * role, labelled B/M/S in the order the JSON gave them, filled by however many of that
   * role are already in the roster if the JSON carries that (`r.roster`) — it does not,
   * today, so every role pip starts empty. A tier that reserves no roles (Dungeon, Raid;
   * `seats` empty or absent) falls back to a plain headcount picture: filled to
   * minPlayers, empty out to maxPlayers.
   */
  function seatDots(r) {
    const seats = r && r.seats && typeof r.seats === 'object' ? r.seats : {};
    const roles = Object.keys(seats).filter((role) => seats[role] > 0);
    if (roles.length) {
      const roster = r.roster && typeof r.roster === 'object' ? r.roster : null;
      const groups = roles.map((role) => {
        const need = seats[role];
        const have = roster ? Math.max(0, Math.min(need, roster[role] || 0)) : 0;
        let dots = '';
        for (let i = 1; i <= need; i++) {
          dots += `<span class="dot ${i <= have ? 'on' : 'off'}"></span>`;
        }
        const label = ROLE_LABEL[role] || role.charAt(0);
        return `<span class="seat-role" title="${role}: ${have}/${need}">`
            + `<span class="seat-role-tag">${label}</span>${dots}</span>`;
      });
      return `<span class="seat-dots">${groups.join('')}</span>`;
    }
    const { min, max } = seatRange(r);
    let dots = '';
    for (let i = 1; i <= max; i++) dots += `<span class="dot ${i <= min ? 'on' : 'off'}"></span>`;
    return `<span class="seat-dots" title="${min}-${max} players">${dots}</span>`;
  }

  /** The tier card's own header range, off its actual instances rather than a fixed number. */
  function headcountRange(rows) {
    const minAll = Math.min(...rows.map((r) => seatRange(r).min));
    const maxAll = Math.max(...rows.map((r) => seatRange(r).max));
    return minAll === maxAll ? String(minAll) : `${minAll}-${maxAll}`;
  }

  const api = { seatDots, headcountRange, seatRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SeatShape = api;
})(typeof window !== 'undefined' ? window : undefined);
