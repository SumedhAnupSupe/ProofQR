// Minimal HS256 JWT implementation using only Node's built-in `crypto` module.
// No custom cryptography: this is a standard JWT (RFC 7519) / JWS HMAC-SHA256
// construction, just without pulling in the `jsonwebtoken` npm package.
//
// Production upgrade path (see README): swap this for the `jsonwebtoken`
// library and/or EdDSA/Ed25519 signing - the call sites (signPresenceToken /
// verifyPresenceToken) are the only integration points that would change.

const crypto = require('crypto');
const config = require('../config');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${signingInput}.${signature}`;
}

function verify(token, secret) {
  if (typeof token !== 'string') return { ok: false, reason: 'INVALID_JWT' };
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false, reason: 'INVALID_JWT' };
  const [encodedHeader, encodedPayload, signature] = segments;

  let header, payload;
  try {
    header = JSON.parse(base64urlDecode(encodedHeader));
    payload = JSON.parse(base64urlDecode(encodedPayload));
  } catch {
    return { ok: false, reason: 'INVALID_JWT' };
  }

  if (header.alg !== 'HS256') return { ok: false, reason: 'INVALID_SIGNATURE' };

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const a = Buffer.from(signature);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) {
    return { ok: false, reason: 'TOKEN_EXPIRED' };
  }
  if (typeof payload.nbf === 'number' && now < payload.nbf) {
    return { ok: false, reason: 'TOKEN_NOT_YET_VALID' };
  }
  if (payload.iss !== 'presence-platform' || payload.aud !== 'presence-verification') {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  return { ok: true, payload };
}

function signPresenceToken({ eventId, screenId, sessionId, cycle }) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.tokenValiditySeconds;
  const payload = {
    iss: 'presence-platform',
    aud: 'presence-verification',
    event_id: eventId,
    screen_id: screenId,
    session_id: sessionId,
    sequence: cycle,
    iat: now,
    exp,
    jti: crypto.randomUUID(),
  };
  const token = sign(payload, config.jwtSecret);
  return { token, jti: payload.jti, iat: now, exp };
}

function verifyPresenceToken(token) {
  return verify(token, config.jwtSecret);
}

module.exports = { signPresenceToken, verifyPresenceToken };
