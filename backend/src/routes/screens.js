const db = require('../db');
const config = require('../config');
const { signPresenceToken } = require('../lib/jwt');
const { chunkToken, encodeStart, encodeEnd, encodeData } = require('../lib/protocol');

const TOTAL_CHUNKS = 4;

function register(router) {
  // Display client polls this once per cycle to get the current signed token,
  // pre-chunked into the exact QR frame strings it should render.
  router.post('/api/v1/screens/:id/token', async (req, res, params, body) => {
    const { screen_key } = body || {};
    const screen = db.getScreen(params.id);
    if (!screen || screen.status !== 'active') {
      return res.json(404, { error: 'SCREEN_NOT_FOUND' });
    }
    // Never trust client-declared identity: screen must prove possession of its key.
    if (screen.screen_key !== screen_key) {
      return res.json(401, { error: 'INVALID_SCREEN_KEY' });
    }
    const event = db.getEvent(screen.event_id);
    if (!event || !event.active) {
      return res.json(404, { error: 'EVENT_NOT_FOUND_OR_INACTIVE' });
    }

    db.updateScreen(screen.id, { last_seen: new Date().toISOString() });

    const cycle = Math.floor(Date.now() / 1000 / config.tokenValiditySeconds);
    const { token, exp } = signPresenceToken({
      eventId: event.id,
      screenId: screen.id,
      sessionId: 'DISPLAY',
      cycle,
    });

    const chunks = chunkToken(token, TOTAL_CHUNKS);
    const frames = [
      encodeStart(cycle),
      ...chunks.map((c, i) => encodeData(cycle, i + 1, TOTAL_CHUNKS, c)),
      encodeEnd(cycle),
    ];

    res.json(200, {
      cycle,
      frames,
      frame_duration_ms: config.frameDurationMs,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  });
}

module.exports = { register };
