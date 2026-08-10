# Dynamic QR Proof-of-Presence Verification Platform

A production-oriented MVP of the protocol:

```
DISPLAY:  START → QR1 → QR2 → QR3 → QR4 → END   (one signed, short-lived JWT, split into 4 chunks)
SCANNER:  captures all 6 frames in order → reconstructs JWT → sends to backend
BACKEND:  verifies signature, expiry, event, screen, session, and replay (jti) → VERIFIED / REJECTED
```

Deployment targets (see below): **Frontend → Vercel**, **Backend → Railway**, **Database → Neon PostgreSQL**. Also runs locally with `docker compose` or plain Node.

---

## What's implemented and tested

- **Protocol** (`backend/src/lib/protocol.js`, mirrored in `frontend/protocol.js`): versioned (`P1`) QR frame
  encode/parse (`P1|S|<cycle>`, `P1|D|<cycle>|<chunk>|<total>|<data>`, `P1|E|<cycle>`), deterministic 4-chunk
  JWT splitting and reconstruction (modular, supports N chunks later).
- **JWT** (`backend/src/lib/jwt.js`): standard HS256 JWT (RFC 7519/JWS) via Node `crypto`. Claims: `iss`, `aud`,
  `event_id`, `screen_id`, `session_id`, `iat`, `exp`, `jti` (random UUID), `sequence` (cycle). Short expiry
  (`TOKEN_VALIDITY_SECONDS`, default 20 s). Signing mechanism is isolated in one module — swap to EdDSA/Ed25519
  (e.g. `jsonwebtoken`) without touching anything else.
- **Scanner state machine** (`backend/src/lib/scanner.js`, mirrored in `frontend/scannerStateMachine.js`):
  `WAITING → RECEIVING → COMPLETE | REJECTED`. Tolerates duplicate decodes, rejects wrong cycle / conflicting
  chunks / early END / missing chunks. Chunk index is authoritative (not scan order), so out-of-order physical
  capture still reconstructs correctly.
- **Backend REST API** (`backend/src/routes/*`): events, screens (with one-time `screen_key`), per-screen token
  issuance, verification sessions, verification with full server-side validation.
- **Datastore** (`backend/src/db/`): async facade with two interchangeable implementations —
  - `pg.js` → **PostgreSQL** (Neon/Railway/docker-compose), selected when `DATABASE_URL` is set. Schema is created
    automatically on boot (idempotent). Replay protection is a **hard unique partial index**:
    `UNIQUE INDEX ... ON verifications(jti) WHERE status = 'VERIFIED'`.
  - `file.js` → JSON-file store for zero-dependency local dev / tests, selected when `DATABASE_URL` is unset.
- **Replay protection**: enforced twice — application check + the database constraint above. A second `VERIFIED`
  for the same `jti` is impossible by construction.
- **Frontend** (`frontend/`, static, no build step): Display page (cycles the 6 frames on a screen/TV), mobile
  Scanner page (camera → live progress checklist → verify), Organizer dashboard (events/screens/attendance).
- **Tests** (all green):
  - `npm run test:unit` — protocol/JWT/scanner/replay: **16 tests**
  - `npm run test:e2e` — full HTTP flow on the file store: **14 tests**
  - `npm run test:pg` — PostgreSQL store via pg-mem: **8 tests**
  - `npm run test:e2e:pg` — full HTTP flow on the PostgreSQL store (pg-mem): **14 tests**

The e2e suite exercises: create event → create screen → display fetches 6 frames → scanner reconstructs JWT →
create session → verify ✅ → replay ✅ `TOKEN_ALREADY_USED` → tamper ✅ `INVALID_SIGNATURE` → wrong event
✅ `WRONG_EVENT` → revoked screen ✅ `WRONG_SCREEN` → expired session ✅ `INVALID_SESSION` → attendance reflects
attempts → unauthenticated admin ✅ `401`.

---

## Project structure

```
presence-platform/
├── apps/frontend → frontend/                    (static, deployed to Vercel)
├── backend/
│   ├── src/
│   │   ├── config.js            # centralized, env-driven config
│   │   ├── server.js            # HTTP server + router (exported for tests)
│   │   ├── db/
│   │   │   ├── index.js         # facade: DATABASE_URL ? pg : file
│   │   │   ├── pg.js            # PostgreSQL store (Neon) + schema/migration
│   │   │   └── file.js          # JSON-file store (local dev / tests)
│   │   ├── lib/
│   │   │   ├── protocol.js      # QR frame encode/parse + chunking
│   │   │   ├── jwt.js           # HS256 sign/verify
│   │   │   ├── scanner.js       # scanner state machine
│   │   │   ├── router.js        # tiny dependency-free HTTP router
│   │   │   └── rateLimit.js     # in-memory rate limiter
│   │   ├── routes/              # events.js, screens.js, verification.js
│   │   └── tests/               # protocol.test.js, e2e.test.js, pg.test.js
│   ├── Dockerfile, railway.json
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── config.js                # API_BASE_URL (generated on Vercel)
│   ├── index.html, display.html, scanner.html, organizer.html
│   ├── protocol.js, scannerStateMachine.js
│   └── scripts/gen-config.js    # Vercel build step (injects PRESENCE_API_BASE_URL)
├── vercel.json                  # Vercel build/output config (repo root)
├── docker-compose.yml
├── .env.example → see backend/.env.example
└── README.md
```

---

## Running locally (plain Node, no database)

```bash
cd backend
cp .env.example .env          # leave DATABASE_URL commented out -> JSON-file store
npm install
npm run dev                   # -> :4000  (health: http://localhost:4000/health)
```

```bash
# frontend (no build step; camera works on localhost)
cd frontend
python3 -m http.server 5173
# -> http://localhost:5173
```

**Flow:** open `/organizer.html` → enter the admin key (`ADMIN_API_KEY`) → create an event → create a screen
(one-time `screen_key`) → open `/display.html`, paste screen ID/key → open `/scanner.html` on a phone, enter the
Event ID → **VERIFY NOW** → point the camera at the display → checklist fills → VERIFIED.

## Running locally with Docker Compose (PostgreSQL)

```bash
docker compose up --build
# backend  -> http://localhost:4000
# frontend -> http://localhost:8080  (/display, /scanner, /organizer)
```

This starts `postgres` + `backend` (built from `backend/Dockerfile`) + `frontend` (nginx static). The backend uses
`DATABASE_URL` → PostgreSQL, and creates the schema automatically on boot.

## Tests

```bash
cd backend
npm test                  # unit + e2e (file store)
npm run test:pg           # PostgreSQL store logic (pg-mem, no server needed)
npm run test:e2e:pg       # full HTTP flow against PostgreSQL store (pg-mem)
```

## Deployment

### 1. Database → Neon

1. Create a project at neon.tech and copy the pooled connection string (starts with `postgres://`).
2. No manual schema step needed — the backend creates tables/indexes on first boot.

### 2. Backend → Railway

1. Deploy the `backend/` folder as a new Railway service (or `railway up`). Railway auto-uses the **Dockerfile**
   (see `railway.json`); healthcheck hits `/health`.
2. Set environment variables:
   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string |
   | `DATABASE_SSL` | `true` (Neon requires SSL) |
   | `JWT_SECRET` | long random string |
   | `ADMIN_API_KEY` | long random string |
   | `CORS_ORIGIN` | your Vercel origin (e.g. `https://your-app.vercel.app`) or `*` |
   | `TOKEN_VALIDITY_SECONDS` | `20` (configurable) |
   | `VERIFICATION_SESSION_TTL_SECONDS` | `60` |
   | `FRAME_DURATION_MS` | `500` |
3. Copy the service's public URL (e.g. `https://your-backend.up.railway.app`).

> Railway sets `PORT` automatically; the app listens on it.

### 3. Frontend → Vercel

1. Import the repo. **Root Directory** must be the **repo root** (remove/leave blank the `frontend/` value) — the
   root `vercel.json` configures the build. Vercel discovers `vercel.json` at the repo root, not inside a
   subdirectory.
2. The root `vercel.json` sets: build command (`node frontend/scripts/gen-config.js`), output directory
   (`frontend`), and `cleanUrls` (so `/organizer` works instead of `/organizer.html`).
3. Make sure **Build Command** and **Output Directory** in the Vercel dashboard (Settings → General) are left as
   defaults (empty), otherwise dashboard values override `vercel.json`.
4. Set the project environment variable `PRESENCE_API_BASE_URL` to your Railway backend URL
   (e.g. `https://your-backend.up.railway.app`). This is injected into `frontend/config.js` at build time.
5. Deploy. The landing page links to `/organizer`, `/display`, `/scanner`.

> Camera access requires HTTPS — Vercel provides it automatically.

## Environment variables (backend)

See `backend/.env.example`:

```env
PORT=4000
DATABASE_URL=            # unset -> JSON-file store; set -> PostgreSQL
DATABASE_SSL=true        # false for local docker-compose
DATABASE_FILE=./data/presence.json
JWT_SECRET=change-me
TOKEN_VALIDITY_SECONDS=20
VERIFICATION_SESSION_TTL_SECONDS=60
FRAME_DURATION_MS=500
CORS_ORIGIN=*
ADMIN_API_KEY=change-me
```

## API

```
POST /api/v1/events                              (admin) create event
GET  /api/v1/events/:id                                   read event
POST /api/v1/events/:id/screens                   (admin) create screen -> {id, screen_key} (one-time)
GET  /api/v1/events/:id/screens                   (admin) list screens (screen_key redacted)
POST /api/v1/events/:id/screens/:screenId/revoke  (admin) revoke a screen
GET  /api/v1/events/:id/attendance                (admin) verified/failed counts + attempts

POST /api/v1/screens/:id/token       {screen_key}                     -> {cycle, frames[6], frame_duration_ms}
POST /api/v1/verification/session    {event_id}                       -> {session_id, expires_at}
POST /api/v1/verification/verify     {session_id, token, user_id?}    -> {verified, ...}
GET  /health                                                            -> {ok:true, engine}
```

Failure reasons: `INVALID_SESSION`, `INVALID_SIGNATURE`, `TOKEN_EXPIRED`, `TOKEN_NOT_YET_VALID`, `WRONG_EVENT`,
`WRONG_SCREEN`, `INVALID_SEQUENCE`, `TOKEN_ALREADY_USED`, `INVALID_JWT`, `RATE_LIMITED`.

## Security model (what's enforced, and by whom)

- Server never trusts client-declared `event_id`, `screen_id`, or timestamps — every claim in the JWT is
  independently re-validated against the verification session and the screens table.
- Screens authenticate with a server-issued `screen_key` (never exposed to the scanner/browser).
- Replay protection is a **hard database constraint** (unique partial index on `VERIFIED.jti`), not just an
  application check — applies to all app instances sharing the same PostgreSQL.
- JWT secret lives only in backend env; never sent to any frontend.
- Rate limiting on `/verification/session` and `/verification/verify` (30 req/min/IP, configurable). In-memory —
  swap to Redis if you run multiple backend instances.
- Logs never contain the JWT or secret material — only `event`, `reason`, `screen`.
- The JWT-signing module is isolated so HS256 can be replaced with EdDSA/Ed25519 without touching business logic.

## Threat model (all covered by the automated tests)

| Attack | Result |
|---|---|
| Static screenshot replayed later | `TOKEN_EXPIRED` |
| Old recorded sequence | `TOKEN_EXPIRED` |
| Partial sequence (e.g. only QR1+QR2) | Scanner never reaches `COMPLETE`; nothing submitted |
| Wrong frame order | Reconstructed correctly if all chunks present (chunk index is authoritative) — wrong `cycle` mid-sequence is rejected |
| Duplicate submission of same JWT | First `VERIFIED`, second `TOKEN_ALREADY_USED` (tested) |
| Tampered JWT (modified event/screen/exp) | `INVALID_SIGNATURE` (tested) |
| Token from a different event | `WRONG_EVENT` (tested) |
| Token from a revoked/foreign screen | `WRONG_SCREEN` (tested) |
| Expired verification session | `INVALID_SESSION` (tested) |

### Explicit limitation

This system does **not** mathematically guarantee physical presence. A determined attacker could relay the live
video feed to a remote device in real time. The correct claim is: *dynamic cryptographic proof-of-presence
verification designed to make static QR sharing and simple replay significantly harder* — not an unbreakable
guarantee.

## Notes / honest limitations

- The PostgreSQL store is exercised against **pg-mem** (in-memory Postgres emulation) in CI, which validates the
  SQL, CRUD, and the unique-partial-index replay protection. A real Neon connection uses the exact same store
  (`pg.js`); verify against a live Neon DB before a big event.
- `display.html` / `scanner.html` / `organizer.html` were tested against the backend API manually and by review;
  test the camera flow on real devices (low-light/focus tuning may be needed).
- Rate limiting is per-process (in-memory). For multiple Railway instances, add Redis for shared limiting.
- The `sequence`-monotonicity check across cycles isn't separately enforced beyond the JWT's own `exp`; the JWT
  `exp` (≤20 s) already bounds a stale display. Add if you need per-screen strict ordering.
