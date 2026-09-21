'use strict';

/**
 * Builds the URL that Electron's `session.cookies.remove(url, name)` needs to actually
 * delete a cookie, from the cookie object `session.cookies.get()` returns. Pulled out of
 * main.js (LNCH1, refs #46) so the token-cache clear it powers — clearing the Microsoft
 * login cookies on sign-out, so the next "Sign in with Microsoft" offers an account picker
 * instead of silently reusing the same account — is testable with plain node. main.js
 * itself requires 'electron', which only resolves inside an Electron process.
 */
function cookieRemovalUrl(cookie) {
  const domain = String((cookie && cookie.domain) || '').replace(/^\./, '');
  const path = (cookie && cookie.path) || '/';
  return 'http' + (cookie && cookie.secure ? 's' : '') + '://' + domain + path;
}

module.exports = { cookieRemovalUrl };
