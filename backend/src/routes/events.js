const crypto = require('crypto');
const db = require('../db');
const config = require('../config');

function requireAdmin(req) {
  const key = req.headers['x-admin-key'];
  return key === config.adminApiKey;
}

function slugId(name) {
  return (
    name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) +
    '_' +
    crypto.randomUUID().slice(0, 4).toUpperCase()
  );
}

function register(router) {
  // Create event
  router.post('/api/v1/events', async (req, res, params, body) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    const { name, id, tokenValidity } = body || {};
    if (!name) return res.json(400, { error: 'name is required' });
    const eventId = id || slugId(name);
    const event = {
      id: eventId,
      name,
      token_validity: tokenValidity || config.tokenValiditySeconds,
      active: true,
      created_at: new Date().toISOString(),
    };
    await db.createEvent(event);
    res.json(201, event);
  });

  router.get('/api/v1/events', async (req, res) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    res.json(200, await db.listEvents());
  });

  router.get('/api/v1/events/:id', async (req, res, params) => {
    const event = await db.getEvent(params.id);
    if (!event) return res.json(404, { error: 'EVENT_NOT_FOUND' });
    res.json(200, event);
  });

  // Create screen for event -> returns screen_key ONCE (secret, given to the display client)
  router.post('/api/v1/events/:id/screens', async (req, res, params, body) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    const event = await db.getEvent(params.id);
    if (!event) return res.json(404, { error: 'EVENT_NOT_FOUND' });
    const screenId = body?.id || `SCREEN_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const screenKey = crypto.randomBytes(24).toString('hex');
    const screen = {
      id: screenId,
      event_id: event.id,
      name: body?.name || screenId,
      screen_key: screenKey,
      status: 'active',
      created_at: new Date().toISOString(),
      last_seen: null,
    };
    await db.createScreen(screen);
    res.json(201, { id: screenId, event_id: event.id, screen_key: screenKey, name: screen.name });
  });

  router.get('/api/v1/events/:id/screens', async (req, res, params) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    const rows = (await db.listScreensForEvent(params.id)).map(({ screen_key, ...rest }) => rest);
    res.json(200, rows);
  });

  router.post('/api/v1/events/:id/screens/:screenId/revoke', async (req, res, params) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    const screen = await db.getScreen(params.screenId);
    if (!screen || screen.event_id !== params.id) return res.json(404, { error: 'SCREEN_NOT_FOUND' });
    await db.updateScreen(screen.id, { status: 'revoked' });
    res.json(200, { ok: true });
  });

  router.get('/api/v1/events/:id/attendance', async (req, res, params) => {
    if (!requireAdmin(req)) return res.json(401, { error: 'UNAUTHORIZED' });
    const rows = await db.listVerificationsForEvent(params.id);
    const verified = rows.filter((r) => r.status === 'VERIFIED').length;
    const failed = rows.filter((r) => r.status !== 'VERIFIED').length;
    res.json(200, { verified, failed, attempts: rows });
  });
}

module.exports = { register };
