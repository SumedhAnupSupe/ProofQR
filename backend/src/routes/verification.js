const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { verifyPresenceToken } = require('../lib/jwt');
const { checkRateLimit } = require('../lib/rateLimit');

function record({ eventId, sessionId, screenId, jti, userId, status, reason }) {
  return db.insertVerification({
    id: crypto.randomUUID(),
    event_id: eventId || null,
    session_id: sessionId || null,
    screen_id: screenId || null,
    jti: jti || null,
    user_id: userId || null,
    status,
    failure_reason: reason || null,
    verified_at: new Date().toISOString(),
  });
}

function register(router) {
  // POST /api/v1/verification/session
  router.post('/api/v1/verification/session', async (req, res, params, body) => {
    if (!checkRateLimit(`session:${req.socket.remoteAddress}`, { windowMs: 60_000, max: 30 })) {
      return res.json(429, { error: 'RATE_LIMITED' });
    }
    const { event_id } = body || {};
    const event = await db.getEvent(event_id);
    if (!event || !event.active) return res.json(404, { error: 'EVENT_NOT_FOUND' });

    const id = `SESSION_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const expiresAt = new Date(Date.now() + config.verificationSessionTtlSeconds * 1000).toISOString();
    await db.createSession({ id, event_id: event.id, status: 'active', created_at: new Date().toISOString(), expires_at: expiresAt });

    res.json(201, { session_id: id, expires_at: expiresAt });
  });

  // POST /api/v1/verification/verify
  router.post('/api/v1/verification/verify', async (req, res, params, body) => {
    if (!checkRateLimit(`verify:${req.socket.remoteAddress}`, { windowMs: 60_000, max: 30 })) {
      return res.json(429, { error: 'RATE_LIMITED' });
    }
    const { session_id, token, user_id } = body || {};

    const fail = async (reason, extra = {}) => {
      await record({ eventId: extra.eventId, sessionId: session_id, screenId: extra.screenId, jti: extra.jti, userId: user_id, status: 'REJECTED', reason });
      res.json(200, { verified: false, reason });
    };

    if (!session_id || !token) return fail('INVALID_SESSION');

    const session = await db.getSession(session_id);
    if (!session) return fail('INVALID_SESSION');
    if (session.status !== 'active' || new Date(session.expires_at).getTime() < Date.now()) {
      return fail('INVALID_SESSION');
    }

    const result = verifyPresenceToken(token);
    if (!result.ok) return fail(result.reason);
    const payload = result.payload;

    // Server independently validates event/screen binding - never trusts client claims.
    if (payload.event_id !== session.event_id) {
      return fail('WRONG_EVENT', { eventId: payload.event_id, jti: payload.jti, screenId: payload.screen_id });
    }

    const screen = await db.getScreen(payload.screen_id);
    if (!screen || screen.status !== 'active' || screen.event_id !== session.event_id) {
      return fail('WRONG_SCREEN', { eventId: payload.event_id, jti: payload.jti, screenId: payload.screen_id });
    }

    const { conflict, verification } = await record({
      eventId: payload.event_id,
      sessionId: session_id,
      screenId: payload.screen_id,
      jti: payload.jti,
      userId: user_id,
      status: 'VERIFIED',
    });

    if (conflict) {
      return fail('TOKEN_ALREADY_USED', { eventId: payload.event_id, jti: payload.jti, screenId: payload.screen_id });
    }

    await db.updateSession(session_id, { status: 'used' });

    res.json(200, {
      verified: true,
      verification_id: verification.id,
      event_id: payload.event_id,
      timestamp: verification.verified_at,
    });
  });
}

module.exports = { register };
