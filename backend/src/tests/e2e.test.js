// End-to-end HTTP test against a real running server (in-process), exercising
// the full product flow: event -> screen -> display token -> scanner
// reconstruction -> verification session -> verify -> replay -> tamper -> wrong
// event -> wrong screen -> expired session -> attendance.
//
// Store is chosen by env: DATABASE_URL -> PostgreSQL, otherwise a temp JSON file.
// Run: npm run test:e2e

process.env.JWT_SECRET = 'e2e-secret-please-ignore';
process.env.ADMIN_API_KEY = 'e2e-admin-key';
process.env.TOKEN_VALIDITY_SECONDS = '20';
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_FILE = require('path').join(__dirname, 'tmp-e2e-db.json');
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createServer } = require('../server');
const db = require('../db');
const protocol = require('../lib/protocol');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok - ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL - ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

const ADMIN = { 'x-admin-key': 'e2e-admin-key' };

function api(base, method, p, body, headers) {
  return fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
}

// Simulates the scanner: given the 6 raw frames, collect START/DATA/END,
// verify chunk indices, and reconstruct the JWT from the 4 data chunks.
function scannerReconstruct(frames) {
  const chunks = {};
  let total = null;
  let start = false;
  let end = false;
  for (const raw of frames) {
    const f = protocol.parseFrame(raw);
    if (!f) throw new Error('Unparseable frame');
    if (f.type === 'START') start = true;
    if (f.type === 'END') end = true;
    if (f.type === 'DATA') {
      total = total === null ? f.total : total;
      if (f.total !== total) throw new Error('conflicting total');
      if (chunks[f.chunk] && chunks[f.chunk] !== f.data) throw new Error('conflicting chunk');
      chunks[f.chunk] = f.data;
    }
  }
  if (!start || !end) throw new Error('missing START/END');
  return protocol.reconstructToken(chunks, total);
}

async function main() {
  await db.init();
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`e2e server on ${base} (store=${configStore()})`);

  let eventId, screenId, screenKey;

  await test('health endpoint', async () => {
    const r = await fetch(`${base}/health`);
    assert.strictEqual(r.status, 200);
  });

  await test('create event (admin)', async () => {
    const r = await api(base, 'POST', '/api/v1/events', { name: 'E2E Cleaning Drive' }, ADMIN);
    assert.strictEqual(r.status, 201);
    assert.ok(r.body.id);
    eventId = r.body.id;
  });

  await test('create screen (admin) -> screen_key returned', async () => {
    const r = await api(base, 'POST', `/api/v1/events/${eventId}/screens`, { name: 'Front Desk' }, ADMIN);
    assert.strictEqual(r.status, 201);
    screenId = r.body.id;
    screenKey = r.body.screen_key;
    assert.ok(screenKey);
  });

  let token;
  await test('display fetches a 6-frame cycle and scanner reconstructs the JWT', async () => {
    const r = await api(base, 'POST', `/api/v1/screens/${screenId}/token`, { screen_key: screenKey });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.frames.length, 6);
    token = scannerReconstruct(r.body.frames);
    assert.ok(token.split('.').length === 3);
  });

  await test('screen with wrong key is rejected', async () => {
    const r = await api(base, 'POST', `/api/v1/screens/${screenId}/token`, { screen_key: 'wrong' });
    assert.strictEqual(r.status, 401);
  });

  let sessionId;
  await test('create verification session', async () => {
    const r = await api(base, 'POST', '/api/v1/verification/session', { event_id: eventId });
    assert.strictEqual(r.status, 201);
    sessionId = r.body.session_id;
    assert.ok(sessionId);
  });

  await test('verify valid token -> VERIFIED', async () => {
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: sessionId, token, user_id: 'USER_1' });
    assert.strictEqual(r.body.verified, true);
    assert.strictEqual(r.body.event_id, eventId);
  });

  await test('replay same token -> TOKEN_ALREADY_USED', async () => {
    const s = await api(base, 'POST', '/api/v1/verification/session', { event_id: eventId });
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: s.body.session_id, token });
    assert.strictEqual(r.body.verified, false);
    assert.strictEqual(r.body.reason, 'TOKEN_ALREADY_USED');
  });

  await test('tampered token -> INVALID_SIGNATURE', async () => {
    const s = await api(base, 'POST', '/api/v1/verification/session', { event_id: eventId });
    const tampered = token.slice(0, -2) + 'xx';
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: s.body.session_id, token: tampered });
    assert.strictEqual(r.body.verified, false);
    assert.strictEqual(r.body.reason, 'INVALID_SIGNATURE');
  });

  let otherEventId;
  await test('token from another event -> WRONG_EVENT', async () => {
    const e = await api(base, 'POST', '/api/v1/events', { name: 'Other Event' }, ADMIN);
    otherEventId = e.body.id;
    const s = await api(base, 'POST', '/api/v1/verification/session', { event_id: otherEventId });
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: s.body.session_id, token });
    assert.strictEqual(r.body.verified, false);
    assert.strictEqual(r.body.reason, 'WRONG_EVENT');
  });

  await test('revoked screen -> WRONG_SCREEN', async () => {
    const t = await api(base, 'POST', `/api/v1/screens/${screenId}/token`, { screen_key: screenKey });
    const revoked = await api(base, 'POST', `/api/v1/events/${eventId}/screens/${screenId}/revoke`, {}, ADMIN);
    assert.strictEqual(revoked.status, 200);
    const s = await api(base, 'POST', '/api/v1/verification/session', { event_id: eventId });
    const token2 = scannerReconstruct(t.body.frames);
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: s.body.session_id, token: token2 });
    assert.strictEqual(r.body.verified, false);
    assert.strictEqual(r.body.reason, 'WRONG_SCREEN');
  });

  await test('expired verification session -> INVALID_SESSION', async () => {
    const s = await api(base, 'POST', '/api/v1/verification/session', { event_id: eventId });
    await db.updateSession(s.body.session_id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const r = await api(base, 'POST', '/api/v1/verification/verify', { session_id: s.body.session_id, token });
    assert.strictEqual(r.body.verified, false);
    assert.strictEqual(r.body.reason, 'INVALID_SESSION');
  });

  await test('attendance dashboard reflects attempts', async () => {
    const r = await api(base, 'GET', `/api/v1/events/${eventId}/attendance`, null, ADMIN);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.verified >= 1, 'expected at least 1 verified');
    assert.ok(r.body.failed >= 1, 'expected at least 1 failed');
  });

  await test('unauthorized admin request rejected', async () => {
    const r = await api(base, 'GET', '/api/v1/events');
    assert.strictEqual(r.status, 401);
  });

  server.close();
  await db._reset();
  if (!process.env.DATABASE_URL) {
    const f = process.env.DATABASE_FILE;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function configStore() {
  return process.env.DATABASE_URL ? 'postgres' : 'file';
}

main().catch((err) => {
  console.error('e2e crashed:', err);
  process.exit(1);
});
