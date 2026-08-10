const fs = require('fs');
const path = require('path');

// Tiny built-in .env loader (avoids requiring the `dotenv` package).
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseFile: process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'presence.json'),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  tokenValiditySeconds: parseInt(process.env.TOKEN_VALIDITY_SECONDS || '20', 10),
  verificationSessionTtlSeconds: parseInt(process.env.VERIFICATION_SESSION_TTL_SECONDS || '60', 10),
  frameDurationMs: parseInt(process.env.FRAME_DURATION_MS || '500', 10),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  adminApiKey: process.env.ADMIN_API_KEY || 'dev-admin-key',
};

module.exports = config;
