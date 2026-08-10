// Versioned QR frame protocol (P1)
// START: P1|S|<cycle>
// DATA : P1|D|<cycle>|<chunkIndex>|<totalChunks>|<data>
// END  : P1|E|<cycle>

const VERSION = 'P1';

function encodeStart(cycle) {
  return `${VERSION}|S|${cycle}`;
}

function encodeEnd(cycle) {
  return `${VERSION}|E|${cycle}`;
}

function encodeData(cycle, chunkIndex, totalChunks, data) {
  return `${VERSION}|D|${cycle}|${chunkIndex}|${totalChunks}|${data}`;
}

// Splits a token string into `totalChunks` deterministic, ordered, reconstructable pieces.
function chunkToken(token, totalChunks) {
  if (!token) throw new Error('token required');
  if (totalChunks < 1) throw new Error('totalChunks must be >= 1');
  const size = Math.ceil(token.length / totalChunks);
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    chunks.push(token.slice(i * size, (i + 1) * size));
  }
  return chunks;
}

function reconstructToken(chunksByIndex, totalChunks) {
  const parts = [];
  for (let i = 1; i <= totalChunks; i++) {
    if (!(i in chunksByIndex)) throw new Error(`Missing chunk ${i}`);
    parts.push(chunksByIndex[i]);
  }
  return parts.join('');
}

// Parses a raw scanned string into a structured frame, or null if unrecognized.
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

module.exports = { VERSION, encodeStart, encodeEnd, encodeData, chunkToken, reconstructToken, parseFrame };
