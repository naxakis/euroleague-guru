// Serverless store for "Beat The Guru" monthly gauntlet — Vercel KV / Upstash Redis
// over the REST API, zero npm dependencies (Node 18+ global fetch).
// Follows the conventions of api/tournament.js.
//
// ONE Redis hash per month: `btg:<YYYY-MM>`
//   field "t:<token>" -> {token, name, won:[b,b,b,b,b], losses, strikes, startedAt, updatedAt, finishedAt}
// Per-field writes are atomic; one record per device token per month.
//
// Routes:
//   GET  /api/btg?token=<t>            -> {month, me|null, pantheon:[...], players}
//        pantheon = finishers (all 5 won), sorted losses ASC, strikes ASC, finishedAt ASC,
//        tier: 'FLAWLESS' (0 losses) | 'GURU'. players = total participants this month.
//   POST {action:'sync', token, name, won, losses, strikes}
//        -> {ok, me}   Upsert with monotonic guards: won bits can only turn true,
//        losses/strikes can only grow (prevents trivial rollbacks; same trust level as world ladder).
//   POST {action:'reset', key}         -> {ok}  (admin: wipe current month, ADMIN_KEY gated)

function envBySuffix(suffixes, excludes) {
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (excludes && excludes.some((e) => k.includes(e))) continue;
    if (suffixes.some((s) => k.endsWith(s))) return v;
  }
  return undefined;
}
const REST_URL =
  process.env.KV_REST_API_URL ||
  process.env.UPSTASH_REDIS_REST_URL ||
  envBySuffix(['REST_API_URL', 'REDIS_REST_URL']);
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN ||
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  envBySuffix(['REST_API_TOKEN', 'REDIS_REST_TOKEN'], ['READ_ONLY']);
const TTL_SECONDS = 60 * 60 * 24 * 62; // κρατάμε ~2 μήνες (τρέχων + προηγούμενος για το πάνθεον)
const ADMIN_KEY = process.env.ADMIN_KEY;

async function redis(command) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
const keyOf = (m) => `btg:${m}`;
const tf = (token) => `t:${String(token).slice(0, 64)}`;

function clean(e) {
  const won = Array.isArray(e.won) ? e.won.slice(0, 5).map(Boolean) : [false, false, false, false, false];
  while (won.length < 5) won.push(false);
  return {
    token: String(e.token).slice(0, 64),
    name: String(e.name || 'Anonymous').slice(0, 24),
    won,
    losses: Math.max(0, Math.min(999, +e.losses || 0)),
    strikes: Math.max(0, Math.min(9999, +e.strikes || 0)),
    startedAt: e.startedAt || Date.now(),
    updatedAt: Date.now(),
    finishedAt: e.finishedAt || null,
  };
}

async function entries(m) {
  const flat = await redis(['HGETALL', keyOf(m)]);
  const out = [];
  if (flat) for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}
function pantheonOf(list) {
  return list
    .filter((e) => e.won && e.won.every(Boolean))
    .sort((a, b) => a.losses - b.losses || a.strikes - b.strikes || (a.finishedAt || 9e15) - (b.finishedAt || 9e15))
    .slice(0, 100)
    .map((e) => ({ name: e.name, losses: e.losses, strikes: e.strikes, tier: e.losses === 0 ? 'FLAWLESS' : 'GURU', at: e.finishedAt }));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REST_URL || !REST_TOKEN) return res.status(500).json({ error: 'kv_not_configured' });
  const m = monthKey();
  try {
    if (req.method === 'GET') {
      const token = String((req.query && req.query.token) || '');
      const list = await entries(m);
      const me = token ? list.find((e) => e.token === token) || null : null;
      return res.status(200).json({ month: m, me, pantheon: pantheonOf(list), players: list.length });
    }
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { action } = body;

    if (action === 'sync') {
      if (!body.token) return res.status(400).json({ error: 'no_token' });
      const field = tf(body.token);
      const prevRaw = await redis(['HGET', keyOf(m), field]);
      let prev = null; try { prev = prevRaw ? JSON.parse(prevRaw) : null; } catch (e) {}
      const next = clean({ ...body, startedAt: prev ? prev.startedAt : Date.now() });
      if (prev) { // monotonic guards
        next.won = next.won.map((w, i) => w || !!prev.won[i]);
        next.losses = Math.max(next.losses, prev.losses || 0);
        next.strikes = Math.max(next.strikes, prev.strikes || 0);
        next.finishedAt = prev.finishedAt || null;
      }
      if (!next.finishedAt && next.won.every(Boolean)) next.finishedAt = Date.now();
      await redis(['HSET', keyOf(m), field, JSON.stringify(next)]);
      await redis(['EXPIRE', keyOf(m), TTL_SECONDS]);
      return res.status(200).json({ ok: true, me: next });
    }

    if (action === 'reset') {
      if (!ADMIN_KEY || body.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
      await redis(['DEL', keyOf(m)]);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (e) {
    return res.status(500).json({ error: 'server_error', detail: String((e && e.message) || e).slice(0, 200) });
  }
};
