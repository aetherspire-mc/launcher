'use strict';

/**
 * Microsoft sign-in for Minecraft using the legacy public launcher client id
 * (00000000402b5328) via the OAuth **authorization-code** flow on login.live.com — so no
 * Azure app registration is needed. The interactive part (opening a login window and catching
 * the redirect) lives in the Electron main process; this module does the URL building and the
 * token exchanges (MSA code -> MSA token -> Xbox -> XSTS -> Minecraft token -> profile).
 *
 * Produces { mcToken, uuid, name }, which the launcher hands to the Aetherspire API.
 * Uses global fetch (Node 18+/Electron).
 */

const AUTHORIZE = 'https://login.live.com/oauth20_authorize.srf';
const TOKEN = 'https://login.live.com/oauth20_token.srf';
const XBL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

function buildAuthUrl(clientId, redirectUri, scope) {
  const p = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope,
  });
  return `${AUTHORIZE}?${p.toString()}`;
}

/** The two XSTS denials real users hit, mapped to something a human can act on. */
const XSTS_ERRORS = {
  2148916233: 'This Microsoft account has no Xbox profile. Sign in at xbox.com once, then try again.',
  2148916238: 'This is a child account. It must be added to a family by an adult before it can play.',
};

async function json(url, bodyObj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(bodyObj),
  });
  if (!res.ok) {
    // XSTS explains its refusals in the body; surface the two well-known ones.
    let known = null;
    try { known = XSTS_ERRORS[(await res.json()).XErr] || null; } catch (_) {}
    throw new Error(known || `${url} -> ${res.status}`);
  }
  return res.json();
}

/**
 * Exchanges the authorization code for a Microsoft (MBI_SSL) access token.
 * Returns the refresh token too: it is what lets the launcher sign the player back in
 * silently on the next start instead of showing the Microsoft window again.
 */
async function exchangeCode(code, clientId, redirectUri, scope) {
  return tokenRequest(clientId, scope, {
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
}

/** Trades a stored refresh token for a fresh access token (silent sign-in). */
async function refreshAccess(refreshToken, clientId, redirectUri, scope) {
  return tokenRequest(clientId, scope, {
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    redirect_uri: redirectUri,
  });
}

async function tokenRequest(clientId, scope, fields) {
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope, ...fields }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error('token exchange failed: ' + JSON.stringify(data));
  // Microsoft rotates refresh tokens: the response may carry a new one that replaces the
  // old. Callers persist whatever comes back.
  return { accessToken: data.access_token, refreshToken: data.refresh_token || null };
}

/** MSA token -> Xbox -> XSTS -> Minecraft token -> profile. */
async function xboxToMinecraft(msAccessToken) {
  // Xbox Live. For MBI_SSL tokens the RpsTicket is the raw token (no "d=" prefix).
  const xbl = await json(XBL, {
    Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: msAccessToken },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  });
  const xblToken = xbl.Token;

  const xsts = await json(XSTS, {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  });
  const xstsToken = xsts.Token;
  const uhs = xsts.DisplayClaims.xui[0].uhs;

  const mc = await json(MC_LOGIN, { identityToken: `XBL3.0 x=${uhs};${xstsToken}` });
  const mcToken = mc.access_token;

  const profRes = await fetch(MC_PROFILE, { headers: { Authorization: 'Bearer ' + mcToken } });
  if (!profRes.ok) {
    // 404 here means the Microsoft/Xbox account has no Minecraft: Java Edition profile —
    // by far the most common way a player lands here. Say so in plain words; other statuses
    // keep a generic message since they are not this specific, well-known case.
    const err = new Error(profRes.status === 404
      ? 'This Microsoft account does not own Minecraft: Java Edition. Sign out and use the account you play with.'
      : 'profile fetch failed (' + profRes.status + '). Does this account own Minecraft: Java Edition?');
    err.code = 'no-minecraft';
    throw err;
  }
  const profile = await profRes.json();
  return { mcToken, uuid: profile.id, name: profile.name };
}

/** Full completion given the captured authorization code. */
async function completeLogin(code, clientId, redirectUri, scope) {
  const { accessToken, refreshToken } = await exchangeCode(code, clientId, redirectUri, scope);
  const auth = await xboxToMinecraft(accessToken);
  return { ...auth, msRefreshToken: refreshToken };
}

/** Silent sign-in from a stored refresh token. Throws if the token is stale/revoked. */
async function loginWithRefreshToken(refreshToken, clientId, redirectUri, scope) {
  const fresh = await refreshAccess(refreshToken, clientId, redirectUri, scope);
  const auth = await xboxToMinecraft(fresh.accessToken);
  return { ...auth, msRefreshToken: fresh.refreshToken || refreshToken };
}

// exchangeCode/refreshAccess/xboxToMinecraft stay internal — main.js only ever
// needs the composed flows.
module.exports = { buildAuthUrl, completeLogin, loginWithRefreshToken };
