// Versioned QR frame protocol (P1) - mirrors backend/src/lib/protocol.js exactly.
// START: P1|S|<cycle>   DATA: P1|D|<cycle>|<chunkIndex>|<totalChunks>|<data>   END: P1|E|<cycle>
window.Protocol = (() => {
  const VERSION = 'P1';

  function parseFrame(raw) {
    if (typeof raw !== 'string') return null;
    const parts = raw.split('|');
    if (parts[0] !== VERSION) return null;

    if (parts[1] === 'S' && parts.length === 3) {
      const cycle = Number(parts[2]);
      if (!Number.isFinite(cycle)) return null;
      return { type: 'START', cycle };
    }
    if (parts[1] === 'E' && parts.length === 3) {
      const cycle = Number(parts[2]);
      if (!Number.isFinite(cycle)) return null;
      return { type: 'END', cycle };
    }
    if (parts[1] === 'D' && parts.length >= 6) {
      const cycle = Number(parts[2]);
      const chunk = Number(parts[3]);
      const total = Number(parts[4]);
      const data = parts.slice(5).join('|');
      if (![cycle, chunk, total].every(Number.isFinite)) return null;
      return { type: 'DATA', cycle, chunk, total, data };
    }
    return null;
  }

  function reconstructToken(chunksByIndex, totalChunks) {
    const parts = [];
    for (let i = 1; i <= totalChunks; i++) {
      if (!(i in chunksByIndex)) throw new Error(`Missing chunk ${i}`);
      parts.push(chunksByIndex[i]);
    }
    return parts.join('');
  }

  return { VERSION, parseFrame, reconstructToken };
})();
