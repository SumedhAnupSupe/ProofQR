// Scanner state machine - mirrors backend/src/lib/scanner.js exactly, so the
// same rules that are unit-tested server-side govern the live scanner.
// States: WAITING -> RECEIVING -> COMPLETE -> (caller drives VERIFYING/VERIFIED) | REJECTED
window.createScanner = function createScanner() {
  let state = 'WAITING';
  let cycle = null;
  let chunks = {};
  let total = null;
  const captured = new Set(); // for UI progress display: which of START/1/2/3/4/END seen

  function reset() {
    state = 'WAITING';
    cycle = null;
    chunks = {};
    total = null;
    captured.clear();
  }

  function feed(raw) {
    const frame = window.Protocol.parseFrame(raw);
    if (!frame) return state;

    if (frame.type === 'START') {
      state = 'RECEIVING';
      cycle = frame.cycle;
      chunks = {};
      total = null;
      captured.clear();
      captured.add('START');
      return state;
    }

    if (state === 'WAITING') return state;

    if (frame.type === 'DATA') {
      if (frame.cycle !== cycle) { state = 'REJECTED'; return state; }
      if (total !== null && frame.total !== total) { state = 'REJECTED'; return state; }
      total = frame.total;
      if (chunks[frame.chunk] !== undefined && chunks[frame.chunk] !== frame.data) {
        state = 'REJECTED';
        return state;
      }
      chunks[frame.chunk] = frame.data;
      captured.add('QR' + frame.chunk);
      return state;
    }

    if (frame.type === 'END') {
      if (frame.cycle !== cycle) { state = 'REJECTED'; return state; }
      if (total === null || Object.keys(chunks).length !== total) { state = 'REJECTED'; return state; }
      captured.add('END');
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
    getCaptured: () => captured,
    getToken: () => {
      if (state !== 'COMPLETE') return null;
      try { return window.Protocol.reconstructToken(chunks, total); } catch { return null; }
    },
  };
};
