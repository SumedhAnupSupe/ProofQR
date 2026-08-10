// PostgreSQL datastore factory (production, e.g. Neon). Selected automatically
// when DATABASE_URL is set. Same async interface as file.js so routes are
// agnostic. Exported as a factory so tests can inject a pg-compatible pool
// (e.g. pg-mem); index.js wires the real Pool.
//
// Replay protection is a HARD database constraint, not just an application
// check: a unique partial index guarantees at most one VERIFIED row per jti.
// Any attempt to insert a second VERIFIED row for the same jti raises a
// unique-violation (SQLSTATE 23505) and is surfaced as { conflict: true }.

const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  token_validity INT  NOT NULL DEFAULT 20,
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS screens (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  screen_key TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_screens_event ON screens(event_id);

CREATE TABLE IF NOT EXISTS verification_sessions (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_event ON verification_sessions(event_id);

CREATE TABLE IF NOT EXISTS verifications (
  id             TEXT PRIMARY KEY,
  event_id       TEXT,
  session_id     TEXT,
  screen_id      TEXT,
  jti            TEXT,
  user_id        TEXT,
  status         TEXT NOT NULL,
  failure_reason TEXT,
  verified_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Replay protection (hard constraint): one VERIFIED row per jti, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_verifications_verified_jti
  ON verifications(jti) WHERE status = 'VERIFIED';
CREATE INDEX IF NOT EXISTS idx_verifications_event   ON verifications(event_id);
CREATE INDEX IF NOT EXISTS idx_verifications_session ON verifications(session_id);
CREATE INDEX IF NOT EXISTS idx_verifications_screen  ON verifications(screen_id);
`;

function createPgStore(pool) {
  let initialized = false;

  function serialize(row) {
    if (!row) return row;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    return out;
  }

  return {
    async init() {
      if (!initialized) {
        await pool.query(SCHEMA);
        initialized = true;
      }
      return { engine: 'postgres', host: pool.connectionParameters?.host || 'pg' };
    },

    // --- events ---
    async createEvent(event) {
      const { rows } = await pool.query(
        `INSERT INTO events (id, name, token_validity, active, created_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [event.id, event.name, event.token_validity, event.active, event.created_at]
      );
      return serialize(rows[0]);
    },
    async getEvent(id) {
      const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [id]);
      return serialize(rows[0] || null);
    },
    async listEvents() {
      const { rows } = await pool.query('SELECT * FROM events ORDER BY created_at DESC');
      return rows.map(serialize);
    },

    // --- screens ---
    async createScreen(screen) {
      const { rows } = await pool.query(
        `INSERT INTO screens (id, event_id, name, screen_key, status, created_at, last_seen)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [screen.id, screen.event_id, screen.name, screen.screen_key, screen.status, screen.created_at, screen.last_seen]
      );
      return serialize(rows[0]);
    },
    async getScreen(id) {
      const { rows } = await pool.query('SELECT * FROM screens WHERE id = $1', [id]);
      return serialize(rows[0] || null);
    },
    async listScreensForEvent(eventId) {
      const { rows } = await pool.query('SELECT * FROM screens WHERE event_id = $1', [eventId]);
      return rows.map(serialize);
    },
    async updateScreen(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.getScreen(id);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const { rows } = await pool.query(`UPDATE screens SET ${sets} WHERE id = $1 RETURNING *`, [id, ...Object.values(patch)]);
      return serialize(rows[0] || null);
    },

    // --- verification sessions ---
    async createSession(session) {
      const { rows } = await pool.query(
        `INSERT INTO verification_sessions (id, event_id, status, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [session.id, session.event_id, session.status, session.created_at, session.expires_at]
      );
      return serialize(rows[0]);
    },
    async getSession(id) {
      const { rows } = await pool.query('SELECT * FROM verification_sessions WHERE id = $1', [id]);
      return serialize(rows[0] || null);
    },
    async updateSession(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return this.getSession(id);
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const { rows } = await pool.query(
        `UPDATE verification_sessions SET ${sets} WHERE id = $1 RETURNING *`,
        [id, ...Object.values(patch)]
      );
      return serialize(rows[0] || null);
    },

    // --- verifications ---
    async insertVerification(record) {
      try {
        const { rows } = await pool.query(
          `INSERT INTO verifications (id, event_id, session_id, screen_id, jti, user_id, status, failure_reason, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            record.id,
            record.event_id || null,
            record.session_id || null,
            record.screen_id || null,
            record.jti || null,
            record.user_id || null,
            record.status,
            record.failure_reason || null,
            record.verified_at || new Date().toISOString(),
          ]
        );
        return { conflict: false, verification: serialize(rows[0]) };
      } catch (err) {
        // SQLSTATE 23505 = unique_violation (replay protection index).
        if (err.code === '23505') return { conflict: true, verification: null };
        throw err;
      }
    },
    async listVerificationsForEvent(eventId) {
      const { rows } = await pool.query(
        'SELECT * FROM verifications WHERE event_id = $1 ORDER BY verified_at DESC LIMIT 500',
        [eventId]
      );
      return rows.map(serialize);
    },

    // exposed for tests only
    async _reset() {
      // DELETE (child-first) instead of TRUNCATE for broad compatibility
      // (e.g. pg-mem); behavior is identical for this schema.
      await pool.query('DELETE FROM verifications');
      await pool.query('DELETE FROM verification_sessions');
      await pool.query('DELETE FROM screens');
      await pool.query('DELETE FROM events');
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPgStore };
