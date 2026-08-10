// Vercel build step (see frontend/vercel.json). Generates config.js from the
// PRESENCE_API_BASE_URL environment variable set in the Vercel project, so the
// static frontend knows where the Railway backend lives. Falls back to the
// local dev value so a plain static serve still works.
const fs = require('fs');
const path = require('path');

const baseUrl = process.env.PRESENCE_API_BASE_URL || 'http://localhost:4000';
const out = path.join(__dirname, '..', 'config.js');

const content =
  `// Auto-generated at build time by scripts/gen-config.js (Vercel).
// Source of truth: the PRESENCE_API_BASE_URL Vercel project environment variable.
window.PRESENCE_CONFIG = {
  API_BASE_URL: ${JSON.stringify(baseUrl)},
};
`;

fs.writeFileSync(out, content);
console.log(`gen-config: wrote ${out} with API_BASE_URL=${baseUrl}`);
