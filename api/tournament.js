// Serverless tournament store for "Euroleague Guru" — Vercel KV / Upstash Redis
// over the REST API, zero npm dependencies (uses Node 18+ global fetch).
//
// Each tournament is ONE Redis hash `tourn:<ID>`:
//   field "meta"    -> {maxPlayers, createdAt}
//   field "p:<name>"-> {name, roster, joinedAt, completedAt}
// Per-player fields make joins/submits ATOMIC — two players acting at the same
// time never clobber each other (the bug a naive read-modify-write would have).
//
// Routes:
//   GET  /api/tournament?id=GURU-XXXX     -> {id, maxPlayers, createdAt, players:[...]} | null
//   POST /api/tournament {action:'create', id, maxPlayers, name}
//   POST /api/tournament {action:'join',   id, name}   -> {ok} | {error:not_found|full|name_taken}
//   POST /api/tournament {action:'submit', id, name, roster} -> {ok}

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL_SECONDS = 60 * 60 * 24 * 30; // tournaments auto-expire after 30 days

async function redis(command) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

const keyOf = (id) => `tourn:${String(id).toUpperCase()}`;
const pf = (name) => `p:${name}`;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch {
    return {};
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REST_URL || !REST_TOKEN)
    return res.status(500).json({ error: 'kv_unconfigured' });

  try {
    if (req.method === 'GET') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id_required' });
      const flat = await redis(['HGETALL', keyOf(id)]);
      if (!flat || flat.length === 0) return res.status(200).json(null);
      const h = {};
      for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1];
      const meta = JSON.parse(h.meta || '{}');
      const players = Object.keys(h)
        .filter((k) => k.startsWith('p:'))
        .map((k) => JSON.parse(h[k]))
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      return res.status(200).json({
        id: String(id).toUpperCase(),
        maxPlayers: meta.maxPlayers,
        createdAt: meta.createdAt,
        players,
      });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      if (!b.id) return res.status(400).json({ error: 'id_required' });
      const key = keyOf(b.id);

      if (b.action === 'create') {
        const meta = JSON.stringify({
          maxPlayers: Number(b.maxPlayers) || 2,
          createdAt: Date.now(),
        });
        const player = JSON.stringify({
          name: b.name,
          roster: null,
          joinedAt: Date.now(),
        });
        await redis(['HSET', key, 'meta', meta, pf(b.name), player]);
        await redis(['EXPIRE', key, TTL_SECONDS]);
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'join') {
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (!metaRaw) return res.status(200).json({ error: 'not_found' });
        const meta = JSON.parse(metaRaw);
        const fields = (await redis(['HKEYS', key])) || [];
        const count = fields.filter((f) => f.startsWith('p:')).length;
        if (count >= (meta.maxPlayers || 2))
          return res.status(200).json({ error: 'full' });
        const added = await redis([
          'HSETNX',
          key,
          pf(b.name),
          JSON.stringify({ name: b.name, roster: null, joinedAt: Date.now() }),
        ]);
        if (!added) return res.status(200).json({ error: 'name_taken' });
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'submit') {
        const prevRaw = await redis(['HGET', key, pf(b.name)]);
        const prev = prevRaw
          ? JSON.parse(prevRaw)
          : { name: b.name, joinedAt: Date.now() };
        prev.roster = b.roster;
        prev.completedAt = Date.now();
        await redis(['HSET', key, pf(b.name), JSON.stringify(prev)]);
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'bad_action' });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
