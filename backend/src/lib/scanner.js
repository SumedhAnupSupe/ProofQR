const { parseFrame, reconstructToken } = require('./protocol');

// States: WAITING -> RECEIVING -> COMPLETE -> (VERIFYING/VERIFIED handled by caller) | REJECTED
function createScanner() {
  let state = 'WAITING';
  let cycle = null;
  let chunks = {};
  let total = null;

  function reset() {
    state = 'WAITING';
    cycle = null;
    chunks = {};
    total = null;
  }

  // Feed one decoded raw QR string into the state machine. Returns new state.
  function feed(raw) {
    const frame = parseFrame(raw);
    if (!frame) return state; // ignore unrecognized decode noise, don't reset

    if (frame.type === 'START') {
      state = 'RECEIVING';
      cycle = frame.cycle;
      chunks = {};
      total = null;
      return state;
    }

    if (state === 'WAITING') return state; // ignore DATA/END before START

    if (frame.type === 'DATA') {
      if (frame.cycle !== cycle) {
        state = 'REJECTED';
        return state;
      }
      if (total !== null && frame.total !== total) {
        state = 'REJECTED';
        return state;
      }
      total = frame.total;
      if (chunks[frame.chunk] !== undefined && chunks[frame.chunk] !== frame.data) {
        state = 'REJECTED'; // conflicting data for same index = real error
        return state;
      }
      chunks[frame.chunk] = frame.data; // duplicate identical decode = tolerated no-op
      return state;
    }

    if (frame.type === 'END') {
      if (frame.cycle !== cycle) {
        state = 'REJECTED';
        return state;
      }
      if (total === null || Object.keys(chunks).length !== total) {
        state = 'REJECTED';
        return state;
      }
      state = 'COMPLETE';
      return state;
    }

    return state;
  }

  return {
    feed,
    reset,
    getState: () => state,
    getCycle: () => cycle,
    getToken: () => {
      if (state !== 'COMPLETE') return null;
      try {
        return reconstructToken(chunks, total);
      } catch {
        return null;
      }
    },
  };
}

function runScanner(frames) {
  const scanner = createScanner();
  for (const raw of frames) {
    scanner.feed(raw);
    if (scanner.getState() === 'REJECTED') break;
  }
  return { state: scanner.getState(), token: scanner.getToken(), cycle: scanner.getCycle() };
}

module.exports = { createScanner, runScanner };
