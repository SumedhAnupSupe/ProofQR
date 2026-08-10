// Verifies the PostgreSQL datastore (pg.js) using pg-mem, an in-memory
// Postgres emulation. Exercises schema creation, CRUD, and — most importantly —
// the hard replay-protection constraint (unique partial index on VERIFIED jti).
// Run: npm run test:pg

const assert = require('assert');
const { newDb } = require('pg-mem');
const { createPgStore } = require('../db/pg');

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

async function main() {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const store = createPgStore(new Pool());

  await test('init applies schema (tables + unique partial index)', async () => {
    const info = await store.init();
    assert.strictEqual(info.engine, 'postgres');
    // The partial unique index is proven to exist by the replay-protection
    // tests below (a duplicate VERIFIED jti raises SQLSTATE 23505).
    const { rows } = await new Pool().query('SELECT count(*)::int AS n FROM verifications');
    assert.strictEqual(rows[0].n, 0);
  });

  await test('event CRUD', async () => {
    const ev = await store.createEvent({ id: 'E1', name: 'Cleanup', token_validity: 20, active: true, created_at: new Date().toISOString() });
    assert.strictEqual(ev.id, 'E1');
    assert.strictEqual((await store.getEvent('E1')).name, 'Cleanup');
    assert.strictEqual((await store.getEvent('nope')), null);
    assert.ok((await store.listEvents()).length >= 1);
  });

  await test('screen CRUD + update (last_seen)', async () => {
    const s = await store.createScreen({ id: 'SCR1', event_id: 'E1', name: 'Front', screen_key: 'k1', status: 'active', created_at: new Date().toISOString(), last_seen: null });
    assert.strictEqual(s.screen_key, 'k1');
    const updated = await store.updateScreen('SCR1', { last_seen: new Date().toISOString() });
    assert.ok(updated.last_seen);
    assert.strictEqual((await store.listScreensForEvent('E1')).length, 1);
  });

  await test('session CRUD', async () => {
    const sess = await store.createSession({ id: 'SESS1', event_id: 'E1', status: 'active', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString() });
    assert.strictEqual(sess.id, 'SESS1');
    assert.strictEqual((await store.getSession('SESS1')).status, 'active');
    await store.updateSession('SESS1', { status: 'used' });
    assert.strictEqual((await store.getSession('SESS1')).status, 'used');
  });

  await test('replay protection: second VERIFIED for same jti conflicts', async () => {
    const now = new Date().toISOString();
    const first = await store.insertVerification({ id: 'v1', event_id: 'E1', session_id: 'SESS1', screen_id: 'SCR1', jti: 'JTI_X', status: 'VERIFIED', verified_at: now });
    assert.strictEqual(first.conflict, false);
    const second = await store.insertVerification({ id: 'v2', event_id: 'E1', session_id: 'SESS1', screen_id: 'SCR1', jti: 'JTI_X', status: 'VERIFIED', verified_at: now });
    assert.strictEqual(second.conflict, true);
  });

  await test('REJECTED rows with same jti do not conflict', async () => {
    const now = new Date().toISOString();
    const a = await store.insertVerification({ id: 'v3', event_id: 'E1', session_id: 'SESS1', screen_id: 'SCR1', jti: 'JTI_Y', status: 'REJECTED', failure_reason: 'TOKEN_EXPIRED', verified_at: now });
    const b = await store.insertVerification({ id: 'v4', event_id: 'E1', session_id: 'SESS1', screen_id: 'SCR1', jti: 'JTI_Y', status: 'VERIFIED', verified_at: now });
    assert.strictEqual(a.conflict, false);
    assert.strictEqual(b.conflict, false);
  });

  await test('attendance listing is newest-first, limited', async () => {
    const rows = await store.listVerificationsForEvent('E1');
    assert.ok(rows.length >= 3, 'expected at least 3 rows');
    const times = rows.map((r) => new Date(r.verified_at).getTime());
    for (let i = 1; i < times.length; i++) assert.ok(times[i - 1] >= times[i]);
  });

  await test('reset truncates', async () => {
    await store._reset();
    assert.strictEqual((await store.listVerificationsForEvent('E1')).length, 0);
    assert.strictEqual((await store.getEvent('E1')), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('pg store test crashed:', err);
  process.exit(1);
});
