// MVP datastore: a JSON file on disk, guarded by an in-process write queue.
//
// This intentionally mirrors the target relational schema (events, screens,
// verification_sessions, verifications) documented in README.md so that
// migrating to PostgreSQL + Prisma later is a matter of swapping this module,
// not redesigning the data model.
//
// NOT suitable for multi-process / multi-instance production deployment
// (no cross-process locking, no real indexes, no concurrent-writer safety).
// See README "Production upgrade path".

const fs = require('fs');
const path = require('path');
const config = require('../config');

const file = config.databaseFile;
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

function emptyState() {
  return { events: {}, screens: {}, verification_sessions: {}, verifications: {} };
}

let state = emptyState();
if (fs.existsSync(file)) {
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = emptyState();
  }
}

function persist() {
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

const db = {
  // --- events ---
  createEvent(event) {
    state.events[event.id] = event;
    persist();
    return event;
  },
  getEvent(id) {
    return state.events[id] || null;
  },
  listEvents() {
    return Object.values(state.events).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  // --- screens ---
  createScreen(screen) {
    state.screens[screen.id] = screen;
    persist();
    return screen;
  },
  getScreen(id) {
    return state.screens[id] || null;
  },
  listScreensForEvent(eventId) {
    return Object.values(state.screens).filter((s) => s.event_id === eventId);
  },
  updateScreen(id, patch) {
    if (!state.screens[id]) return null;
    Object.assign(state.screens[id], patch);
    persist();
    return state.screens[id];
  },

  // --- verification sessions ---
  createSession(session) {
    state.verification_sessions[session.id] = session;
    persist();
    return session;
  },
  getSession(id) {
    return state.verification_sessions[id] || null;
  },
  updateSession(id, patch) {
    if (!state.verification_sessions[id]) return null;
    Object.assign(state.verification_sessions[id], patch);
    persist();
    return state.verification_sessions[id];
  },

  // --- verifications ---
  // Enforces the replay-protection uniqueness constraint:
  // at most one VERIFIED row may ever exist per jti.
  insertVerification(record) {
    if (record.status === 'VERIFIED') {
      const alreadyUsed = Object.values(state.verifications).some(
        (v) => v.jti === record.jti && v.status === 'VERIFIED'
      );
      if (alreadyUsed) return { conflict: true, verification: null };
    }
    state.verifications[record.id] = record;
    persist();
    return { conflict: false, verification: record };
  },
  listVerificationsForEvent(eventId) {
    return Object.values(state.verifications)
      .filter((v) => v.event_id === eventId)
      .sort((a, b) => b.verified_at.localeCompare(a.verified_at))
      .slice(0, 500);
  },

  // exposed for tests only
  _reset() {
    state = emptyState();
    persist();
  },
};

module.exports = db;
