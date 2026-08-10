// Minimal in-memory rate limiter keyed by client IP + bucket name.
// Fine for single-instance MVP; use Redis for multi-instance production.

const hits = new Map(); // key -> [timestamps]

function checkRateLimit(key, { windowMs, max }) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length <= max;
}

module.exports = { checkRateLimit };
