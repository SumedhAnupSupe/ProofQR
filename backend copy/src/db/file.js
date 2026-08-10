// JSON-file datastore (local dev / tests). Async API mirroring pg.js so the
// store can be swapped via DATABASE_URL without touching routes.
//
// NOT suitable for multi-instance production deployment (no cross-process
// locking, no real indexes, no concurrent-writer safety). PostgreSQL + Neon
// is the production store (see pg.js). Replay protection here is an
// application-level check; in PostgreSQL it is additionally enforced by a
// unique partial index (see schema in pg.js).

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
  async init() {
    if (!fs.existsSync(file)) persist();
    return { engine: 'file', file };
  },

  // --- events ---
  async createEvent(event) {
    state.events[event.id] = event;
    persist();
    return event;
  },
  async getEvent(id) {
    return state.events[id] || null;
  },
  async listEvents() {
    return Object.values(state.events).sort((a, b) => b.created_at.localeCompare(a.created_at));
  },

  // --- screens ---
  async createScreen(screen) {
    state.screens[screen.id] = screen;
    persist();
    return screen;
  },
  async getScreen(id) {
    return state.screens[id] || null;
  },
  async listScreensForEvent(eventId) {
    return Object.values(state.screens).filter((s) => s.event_id === eventId);
  },
  async updateScreen(id, patch) {
    if (!state.screens[id]) return null;
    Object.assign(state.screens[id], patch);
    persist();
    return state.screens[id];
  },

  // --- verification sessions ---
  async createSession(session) {
    state.verification_sessions[session.id] = session;
    persist();
    return session;
  },
  async getSession(id) {
    return state.verification_sessions[id] || null;
  },
  async updateSession(id, patch) {
    if (!state.verification_sessions[id]) return null;
    Object.assign(state.verification_sessions[id], patch);
    persist();
    return state.verification_sessions[id];
  },

  // --- verifications ---
  // Enforces replay protection: at most one VERIFIED row may ever exist per jti.
  async insertVerification(record) {
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
  async listVerificationsForEvent(eventId) {
    return Object.values(state.verifications)
      .filter((v) => v.event_id === eventId)
      .sort((a, b) => b.verified_at.localeCompare(a.verified_at))
      .slice(0, 500);
  },

  // exposed for tests only
  async _reset() {
    state = emptyState();
    persist();
  },
};

module.exports = db;
