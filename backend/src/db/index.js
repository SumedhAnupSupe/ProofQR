// Datastore facade. Picks the store based on configuration:
//   - DATABASE_URL set     -> PostgreSQL (Neon/railway/docker-compose), pg.js
//   - otherwise            -> JSON-file store (local dev / tests), file.js
// Both expose the same async interface, so routes never care which is active.

const config = require('../config');

const db = config.databaseUrl || process.env.TEST_PG_MEM
  ? (() => {
      const { createPgStore } = require('./pg');
      // TEST_PG_MEM=1 runs against pg-mem (in-memory Postgres emulation) so the
      // full PostgreSQL code path is exercised in CI/local without a server.
      const pool = process.env.TEST_PG_MEM
        ? (() => {
            const { newDb } = require('pg-mem');
            const { Pool } = newDb().adapters.createPg();
            return new Pool();
          })()
        : (() => {
            const { Pool } = require('pg');
            return new Pool({
              connectionString: config.databaseUrl,
              ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
              max: 10,
              idleTimeoutMillis: 30_000,
              connectionTimeoutMillis: 10_000,
            });
          })();
      return createPgStore(pool);
    })()
  : require('./file');

module.exports = db;
