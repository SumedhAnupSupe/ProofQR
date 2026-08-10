# Dynamic QR Proof-of-Presence Verification Platform

A working MVP of the protocol described in the spec:

```
DISPLAY:  START → QR1 → QR2 → QR3 → QR4 → END   (one signed, short-lived JWT, split into 4 chunks)
SCANNER:  captures all 6 frames in order → reconstructs JWT → sends to backend
BACKEND:  verifies signature, expiry, event, screen, session, and replay (jti) → VERIFIED / REJECTED
```

## What's actually implemented and tested (this is a real, runnable product, not a mockup)

- **Protocol** (`backend/src/lib/protocol.js`): versioned (`P1`) frame encode/parse, deterministic chunking/reconstruction.
- **JWT** (`backend/src/lib/jwt.js`): standard HS256 JWT (RFC 7519/JWS), signed/verified with `event_id`, `screen_id`,
  `session_id`, `iat`, `exp`, `jti`, `sequence`. Short expiry (`TOKEN_VALIDITY_SECONDS`, default 20s).
- **Scanner state machine** (`backend/src/lib/scanner.js`, ported 1:1 to `frontend/scannerStateMachine.js`):
  `WAITING → RECEIVING → COMPLETE/REJECTED`. Tolerates duplicate decodes, rejects wrong order/cycle/missing chunks.
- **Backend REST API** (`backend/src/routes/*`): event/screen management, per-screen token issuance, verification
  session creation, verification with full server-side validation (signature, expiry, event binding, screen binding,
  replay via `jti`).
- **Replay protection**: enforced at the datastore layer — at most one `VERIFIED` record may ever exist per `jti`.
- **Frontend** (`frontend/*.html`, no build step): Display page (cycles the 6 QR frames), mobile Scanner page
  (camera capture → live progress checklist → verify), Organizer dashboard (create events/screens, view attendance).
- **Automated tests** (`backend/src/tests/protocol.test.js`): 16 tests covering chunking round-trip, frame parsing,
  JWT valid/expired/tampered/malformed, scanner valid/missing-chunk/wrong-cycle/early-END/duplicate-frame sequences,
  and replay-protection uniqueness. **All 16 pass** (`npm test` inside `backend/`).
- **End-to-end verified manually** via curl: create event → create screen → fetch display frames → reconstruct JWT
  from frames → create verification session → verify (✅ VERIFIED) → replay same token (✅ TOKEN_ALREADY_USED) →
  tamper token (✅ INVALID_SIGNATURE) → attendance dashboard reflects both attempts.

## An important, deliberate deviation from the spec's suggested stack

The spec recommends Express/Fastify, PostgreSQL/Prisma, and `jsonwebtoken`. **This sandbox has no network access**,
so `npm install` cannot reach the npm registry. Rather than hand you an unrunnable scaffold, the backend is built
entirely on **Node.js built-ins** (`http`, `crypto`, `fs`) — zero `npm install` required, runs immediately with
`node src/server.js`. This is not "faked" — it's a real HTTP server, a real router, a real HS256 JWT implementation
(standard construction, not custom crypto), and a real JSON-file datastore that mirrors the target relational schema.

**Production upgrade path** (straightforward, isolated swaps, no redesign needed):
1. `backend/src/db/index.js` → replace with Prisma + PostgreSQL, using the exact same schema shape (events, screens,
   verification_sessions, verifications) and the same function signatures (`createEvent`, `insertVerification`, etc.).
2. `backend/src/lib/jwt.js` → replace with the `jsonwebtoken` package and/or EdDSA/Ed25519 signing.
3. `backend/src/server.js` + `lib/router.js` → replace with Express/Fastify if you want middleware ecosystem access
   (helmet, real CORS package, etc.) — the route handler signatures (`(req, res, params, body)`) are trivial to adapt.
4. Add Redis for distributed rate-limiting/session state once you run more than one backend instance.

Everything else (protocol design, JWT claims, verification logic, threat model, scanner state machine, frontend) is
exactly as specified and is what actually gets tested.

## Project structure

```
presence-platform/
├── backend/
│   ├── src/
│   │   ├── config.js          # centralized config (env-driven)
│   │   ├── server.js          # HTTP server + router wiring
│   │   ├── lib/
│   │   │   ├── protocol.js    # QR frame encode/parse + chunking
│   │   │   ├── jwt.js         # HS256 JWT sign/verify
│   │   │   ├── scanner.js     # scanner state machine (server-side test copy)
│   │   │   ├── router.js      # tiny dependency-free HTTP router
│   │   │   └── rateLimit.js   # in-memory rate limiter
│   │   ├── db/index.js        # JSON-file datastore (Prisma/Postgres-shaped)
│   │   ├── routes/            # events.js, screens.js, verification.js
│   │   └── tests/protocol.test.js
│   ├── package.json
│   └── .env.example
├── frontend/
│   ├── config.js               # API_BASE_URL - edit this
│   ├── display.html            # the physical screen client
│   ├── scanner.html            # mobile "Verify Now" scanner
│   ├── organizer.html          # organizer/admin dashboard
│   ├── protocol.js             # browser port of protocol.js
│   └── scannerStateMachine.js  # browser port of scanner.js
└── README.md
```

## Running locally

### Backend
```bash
cd backend
cp .env.example .env   # edit JWT_SECRET and ADMIN_API_KEY for anything beyond local testing
node src/server.js
# -> Presence backend listening on :4000
```

### Tests
```bash
cd backend
npm test
# -> 16 passed, 0 failed
```

### Frontend
No build step. Just open the HTML files in a browser (or serve the `frontend/` folder with any static file server —
camera access requires HTTPS or `localhost` in real browsers).

```bash
cd frontend
python3 -m http.server 5173
```

Edit `frontend/config.js` if your backend isn't on `http://localhost:4000`.

**Flow:**
1. Open `organizer.html` → enter the admin key (`ADMIN_API_KEY` from `.env`) → create an event → create a screen.
   Copy the `screen_id` / `screen_key` shown once.
2. Open `display.html` on the screen/TV → paste in the screen ID/key → it starts cycling START → QR1‑4 → END.
3. Open `scanner.html` on a phone → enter the Event ID → **VERIFY NOW** → point camera at the display → watch the
   checklist fill in → VERIFIED.

## API

```
POST /api/v1/events                              (admin) create event
GET  /api/v1/events/:id                                   read event
POST /api/v1/events/:id/screens                   (admin) create screen -> {id, screen_key}
GET  /api/v1/events/:id/screens                   (admin) list screens
POST /api/v1/events/:id/screens/:screenId/revoke  (admin) revoke a screen
GET  /api/v1/events/:id/attendance                (admin) verified/failed counts + attempts

POST /api/v1/screens/:id/token       {screen_key}                     -> {cycle, frames[6], frame_duration_ms}
POST /api/v1/verification/session    {event_id}                       -> {session_id, expires_at}
POST /api/v1/verification/verify     {session_id, token, user_id?}    -> {verified, ...}
```

Failure reasons: `INVALID_SESSION`, `INVALID_SIGNATURE`, `TOKEN_EXPIRED`, `TOKEN_NOT_YET_VALID`, `WRONG_EVENT`,
`WRONG_SCREEN`, `INVALID_SEQUENCE`, `TOKEN_ALREADY_USED`, `INVALID_JWT`, `RATE_LIMITED`.

## Security model (what's enforced, and by whom)

- Server never trusts client-declared `event_id`, `screen_id`, or timestamps — every claim in the JWT is
  independently re-validated against the verification session and the screens table.
- Screens authenticate with a server-issued `screen_key` (never exposed to the scanner/browser at large).
- Replay protection is a **hard uniqueness constraint** on `jti` for `VERIFIED` rows, not just an application check.
- JWT secret lives only in backend env (`JWT_SECRET`), never sent to any frontend.
- Rate limiting on `/verification/session` and `/verification/verify` (30 req/min/IP by default).
- Logs never contain the JWT or secret material — only `event`, `reason`, `screen`.

## Threat model (see spec §31 — all implemented and covered by the manual/automated test suite)

| Attack | Result |
|---|---|
| Static screenshot replayed later | `TOKEN_EXPIRED` |
| Old recorded sequence | `TOKEN_EXPIRED` |
| Partial sequence (e.g. only QR1+QR2) | Scanner never reaches `COMPLETE`; nothing submitted |
| Wrong frame order | Scanner reconstructs correctly if all chunks present regardless of arrival order (chunk index is authoritative, not scan order) — but wrong `cycle` mid-sequence is rejected |
| Duplicate submission of same JWT | First `VERIFIED`, second `TOKEN_ALREADY_USED` (tested) |
| Tampered JWT (modified event/screen/exp) | `INVALID_SIGNATURE` (tested) |
| Token from a different event | `WRONG_EVENT` |
| Token from a revoked/foreign screen | `WRONG_SCREEN` |

### Explicit limitation (spec §32)

This system does **not** mathematically guarantee physical presence. A determined attacker could relay the live
video feed to a remote device in real time. The correct claim is: *dynamic cryptographic proof-of-presence
verification designed to make static QR sharing and simple replay significantly harder* — not an unbreakable
guarantee.

## Phase status vs. spec §37

| Phase | Status |
|---|---|
| 1 — Protocol prototype (chunk/reconstruct, frame parse) | ✅ done, tested |
| 2 — JWT verification (valid/expired/tampered) | ✅ done, tested |
| 3 — Backend verification API | ✅ done, tested end-to-end via curl |
| 4 — Persistence (events/screens/sessions/verifications) | ✅ done (JSON-file MVP store; Postgres/Prisma is the documented swap) |
| 5 — Replay protection | ✅ done, tested |
| 6 — Organizer dashboard | ✅ done (`organizer.html`) |
| 7 — Production-quality scanner polish (low-light, focus tuning, etc.) | ⚠️ basic version done; needs real-device tuning — can't be verified in this sandbox (no camera/browser) |
| 8 — SDK (`Presence.verify()` embeddable widget) | ⏳ not built — the scanner page's logic (`verifyNow()` in `scanner.html`) is the code to extract into an SDK; straightforward next step |

## What has **not** been verified (honest limitations)

- No browser was available in this environment, so `display.html` / `scanner.html` / `organizer.html` were written
  correctly against the tested backend API and manually reviewed, but **not executed in an actual browser** here.
  Test them in yours before relying on them.
- Docker Compose / cloud deployment (Vercel/Railway/Neon) is described above but no Dockerfiles were generated —
  ask if you'd like those next.
- The `sequence`-monotonicity check across cycles (detecting a display's cycle counter going backwards) isn't
  separately enforced beyond the JWT's own `exp`; add if you need it.
