process.env.JWT_SECRET = 'test-secret-please-ignore';
process.env.TOKEN_VALIDITY_SECONDS = '20';

const assert = require('assert');
const {
  chunkToken,
  reconstructToken,
  parseFrame,
  encodeStart,
  encodeEnd,
  encodeData,
} = require('../lib/protocol');
const { signPresenceToken, verifyPresenceToken } = require('../lib/jwt');
const { runScanner } = require('../lib/scanner');

let passed = 0;
let failed = 0;
const queue = [];
function test(name, fn) {
  queue.push([name, fn]);
}

async function runAll() {
  for (const [name, fn] of queue) {
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
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

console.log('Protocol chunking');
test('chunk + reconstruct round-trips', () => {
  const token = 'header.payload.signature-abcdefghijklmnopqrstuvwxyz';
  const chunks = chunkToken(token, 4);
  assert.strictEqual(chunks.length, 4);
  const map = { 1: chunks[0], 2: chunks[1], 3: chunks[2], 4: chunks[3] };
  assert.strictEqual(reconstructToken(map, 4), token);
});

test('reconstruct throws on missing chunk', () => {
  assert.throws(() => reconstructToken({ 1: 'a', 2: 'b', 4: 'd' }, 4), /Missing chunk 3/);
});

console.log('Protocol frame parsing');
test('parses START/DATA/END frames', () => {
  assert.deepStrictEqual(parseFrame(encodeStart(18291)), { type: 'START', cycle: 18291 });
  assert.deepStrictEqual(parseFrame(encodeEnd(18291)), { type: 'END', cycle: 18291 });
  assert.deepStrictEqual(parseFrame(encodeData(18291, 2, 4, 'xyz')), {
    type: 'DATA', cycle: 18291, chunk: 2, total: 4, data: 'xyz',
  });
});

test('rejects unrecognized frame / wrong protocol version', () => {
  assert.strictEqual(parseFrame('garbage'), null);
  assert.strictEqual(parseFrame('P2|S|1'), null);
});

console.log('JWT signing/verification (HS256, built on Node crypto)');
test('valid token verifies', () => {
  const { token } = signPresenceToken({ eventId: 'EVT_1', screenId: 'SCREEN_1', sessionId: 'SESSION_1', cycle: 1 });
  const result = verifyPresenceToken(token);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.payload.event_id, 'EVT_1');
});

test('expired token is rejected', () => {
  const crypto = require('crypto');
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'presence-platform', aud: 'presence-verification',
    event_id: 'EVT_1', screen_id: 'S1', session_id: 'SESS',
    iat: Math.floor(Date.now() / 1000) - 100, exp: Math.floor(Date.now() / 1000) - 50, jti: 'x',
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  const expired = `${header}.${payload}.${sig}`;
  const result = verifyPresenceToken(expired);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'TOKEN_EXPIRED');
});

test('modified/tampered token is rejected (invalid signature)', () => {
  const { token } = signPresenceToken({ eventId: 'EVT_1', screenId: 'S1', sessionId: 'SESS', cycle: 1 });
  const tampered = token.slice(0, -2) + 'xx';
  const result = verifyPresenceToken(tampered);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'INVALID_SIGNATURE');
});

test('malformed JWT structure is rejected', () => {
  const result = verifyPresenceToken('not-a-jwt');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'INVALID_JWT');
});

console.log('Scanner state machine');
test('valid full sequence -> COMPLETE with reconstructed token', () => {
  const token = 'abcd.efgh.ijkl';
  const chunks = chunkToken(token, 4);
  const cycle = 18291;
  const frames = [
    encodeStart(cycle),
    encodeData(cycle, 1, 4, chunks[0]),
    encodeData(cycle, 2, 4, chunks[1]),
    encodeData(cycle, 3, 4, chunks[2]),
    encodeData(cycle, 4, 4, chunks[3]),
    encodeEnd(cycle),
  ];
  const result = runScanner(frames);
  assert.strictEqual(result.state, 'COMPLETE');
  assert.strictEqual(result.token, token);
});

test('missing chunk -> rejected', () => {
  const token = 'abcd.efgh.ijkl';
  const chunks = chunkToken(token, 4);
  const cycle = 1;
  const frames = [
    encodeStart(cycle),
    encodeData(cycle, 1, 4, chunks[0]),
    encodeData(cycle, 2, 4, chunks[1]),
    encodeData(cycle, 4, 4, chunks[3]), // chunk 3 missing
    encodeEnd(cycle),
  ];
  assert.strictEqual(runScanner(frames).state, 'REJECTED');
});

test('wrong order (out-of-sequence chunk indices) still reconstructs correctly if all present', () => {
  const token = 'abcd.efgh.ijkl';
  const chunks = chunkToken(token, 4);
  const cycle = 1;
  const frames = [
    encodeStart(cycle),
    encodeData(cycle, 1, 4, chunks[0]),
    encodeData(cycle, 3, 4, chunks[2]),
    encodeData(cycle, 2, 4, chunks[1]),
    encodeData(cycle, 4, 4, chunks[3]),
    encodeEnd(cycle),
  ];
  const result = runScanner(frames);
  assert.strictEqual(result.state, 'COMPLETE');
  assert.strictEqual(result.token, token);
});

test('duplicate identical frame decode is tolerated', () => {
  const token = 'abcd.efgh.ijkl';
  const chunks = chunkToken(token, 4);
  const cycle = 1;
  const frames = [
    encodeStart(cycle),
    encodeData(cycle, 1, 4, chunks[0]),
    encodeData(cycle, 1, 4, chunks[0]),
    encodeData(cycle, 2, 4, chunks[1]),
    encodeData(cycle, 3, 4, chunks[2]),
    encodeData(cycle, 4, 4, chunks[3]),
    encodeEnd(cycle),
  ];
  const result = runScanner(frames);
  assert.strictEqual(result.state, 'COMPLETE');
  assert.strictEqual(result.token, token);
});

test('wrong cycle injected mid-sequence -> rejected', () => {
  const cycle = 1;
  const frames = [
    encodeStart(cycle),
    encodeData(cycle, 1, 4, 'a'),
    encodeData(2, 2, 4, 'b'), // wrong cycle
    encodeData(cycle, 3, 4, 'c'),
    encodeData(cycle, 4, 4, 'd'),
    encodeEnd(cycle),
  ];
  assert.strictEqual(runScanner(frames).state, 'REJECTED');
});

test('END before all chunks captured -> rejected', () => {
  const cycle = 1;
  const frames = [encodeStart(cycle), encodeData(cycle, 1, 4, 'a'), encodeEnd(cycle)];
  assert.strictEqual(runScanner(frames).state, 'REJECTED');
});

test('DATA/END before START is ignored, not fatal, until START arrives', () => {
  const cycle = 1;
  const frames = [
    encodeData(cycle, 1, 4, 'a'), // ignored, no START yet
    encodeStart(cycle),
    encodeData(cycle, 1, 4, 'a'),
    encodeData(cycle, 2, 4, 'b'),
    encodeData(cycle, 3, 4, 'c'),
    encodeData(cycle, 4, 4, 'd'),
    encodeEnd(cycle),
  ];
  assert.strictEqual(runScanner(frames).state, 'COMPLETE');
});

console.log('\nReplay protection (datastore layer)');
test('same jti cannot be recorded VERIFIED twice', async () => {
  process.env.DATABASE_FILE = require('path').join(__dirname, 'tmp-test-db.json');
  delete process.env.DATABASE_URL;
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../db')];
  const db = require('../db');
  await db._reset();
  const jti = 'replay-test-jti';
  const first = await db.insertVerification({ id: 'v1', event_id: 'E', jti, status: 'VERIFIED', verified_at: new Date().toISOString() });
  const second = await db.insertVerification({ id: 'v2', event_id: 'E', jti, status: 'VERIFIED', verified_at: new Date().toISOString() });
  assert.strictEqual(first.conflict, false);
  assert.strictEqual(second.conflict, true);
  require('fs').unlinkSync(process.env.DATABASE_FILE);
});

runAll();