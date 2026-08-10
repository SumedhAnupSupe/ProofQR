const http = require('http');
const url = require('url');
const config = require('./config');
const { createRouter, readJsonBody } = require('./lib/router');

const router = createRouter();
require('./routes/events').register(router);
require('./routes/screens').register(router);
require('./routes/verification').register(router);

router.get('/health', async (req, res) => res.json(200, { ok: true }));

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  res.json = (status, obj) => {
    const payload = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  };

  // Minimal request log (no secrets/tokens logged).
  console.log(`${new Date().toISOString()} ${req.method} ${pathname}`);

  const match = router.match(req.method, pathname);
  if (!match) {
    return res.json(404, { error: 'NOT_FOUND' });
  }

  try {
    let body = {};
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }
    await match.handler(req, res, match.params, body);
  } catch (err) {
    if (err.message === 'INVALID_JSON') {
      return res.json(400, { error: 'INVALID_JSON' });
    }
    console.error('Unhandled error:', err.message);
    if (!res.headersSent) res.json(500, { error: 'INTERNAL_ERROR' });
  }
});

server.listen(config.port, () => {
  console.log(`Presence backend listening on :${config.port} (Node built-ins only, no npm install required)`);
});
