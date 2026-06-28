// Serverless tournament/championship store for "Euroleague Guru" — Vercel KV /
// Upstash Redis over the REST API, zero npm dependencies (Node 18+ global fetch).
//
// Each tournament is ONE Redis hash `tourn:<ID>`:
//   field "meta"        -> {maxPlayers, createdAt, round}        (round = current round, 1-based)
//   field "p:<name>"    -> {name, joinedAt}                       (membership; locked once round > 1)
//   field "r<R>:<name>" -> {roster, completedAt}                  (a member's roster for round R)
// Per-field writes are atomic, so concurrent joins/submits never clobber each other.
//
// Routes:
//   GET  /api/tournament?id=GURU-XXXX
//        -> {id, maxPlayers, round, players:[{name,joinedAt,roster,completedAt}], rounds:{R:{name:{roster,completedAt}}}} | null
//        (players[].roster/completedAt reflect the CURRENT round, for the results screen)
//   POST {action:'create', id, maxPlayers, name}
//   POST {action:'join',   id, name}        -> {ok} | {error:not_found|full|name_taken|locked}
//   POST {action:'submit', id, name, roster}-> {ok, round}     (stores under the current round)
//   POST {action:'next_round', id}          -> {ok, round}     (any member; locks membership)
//   POST {action:'drop',  id, name}         -> {ok}            (also closes the vacated slot: maxPlayers=members)
//   POST {action:'close', id}               -> {ok, maxPlayers}(start now: lock maxPlayers to current members)
//
// "Challenge the World" all-time ladder lives in ONE global hash `world:all`:
//   field "<name>" -> {name, roster, submittedAt}   (one entry per name; resubmit replaces)
//   GET  /api/tournament?world=1  -> {entries:[{name,roster,submittedAt}]}
//   POST {action:'world_submit', name, roster} -> {ok}

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
const TTL_SECONDS = 60 * 60 * 24 * 30; // auto-expire after 30 days of inactivity

async function redis(command) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`redis ${r.status}: ${await r.text()}`);
  return (await r.json()).result;
}

const keyOf = (id) => `tourn:${String(id).toUpperCase()}`;
const pf = (name) => `p:${name}`;
const rf = (round, name) => `r${round}:${name}`;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!REST_URL || !REST_TOKEN) return res.status(500).json({ error: 'kv_unconfigured' });

  try {
    if (req.method === 'GET') {
      if (req.query.world) {
        const flat = await redis(['HGETALL', 'world:all']);
        const entries = [];
        if (flat) for (let i = 0; i < flat.length; i += 2) { try { entries.push(JSON.parse(flat[i + 1])); } catch (e) {} }
        return res.status(200).json({ entries });
      }
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'id_required' });
      const flat = await redis(['HGETALL', keyOf(id)]);
      if (!flat || flat.length === 0) return res.status(200).json(null);
      const h = {};
      for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1];
      const meta = JSON.parse(h.meta || '{}');
      const round = meta.round || 1;
      const members = Object.keys(h)
        .filter((k) => k.startsWith('p:'))
        .map((k) => JSON.parse(h[k]))
        .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
      const rounds = {};
      Object.keys(h).forEach((k) => {
        const m = k.match(/^r(\d+):([\s\S]+)$/);
        if (m) {
          const rn = m[1], nm = m[2];
          (rounds[rn] = rounds[rn] || {})[nm] = JSON.parse(h[k]);
        }
      });
      const cur = rounds[round] || {};
      const players = members.map((m) => ({
        name: m.name,
        joinedAt: m.joinedAt,
        roster: cur[m.name] ? cur[m.name].roster : null,
        completedAt: cur[m.name] ? cur[m.name].completedAt : undefined,
      }));
      return res.status(200).json({ id: String(id).toUpperCase(), maxPlayers: meta.maxPlayers, round, players, rounds });
    }

    if (req.method === 'POST') {
      const b = parseBody(req);
      if (b.action === 'world_submit') {
        if (!b.name) return res.status(400).json({ error: 'name_required' });
        await redis(['HSET', 'world:all', b.name, JSON.stringify({ name: b.name, roster: b.roster, submittedAt: Date.now() })]);
        return res.status(200).json({ ok: true });
      }
      if (!b.id) return res.status(400).json({ error: 'id_required' });
      const key = keyOf(b.id);

      if (b.action === 'create') {
        const meta = JSON.stringify({ maxPlayers: Number(b.maxPlayers) || 2, createdAt: Date.now(), round: 1 });
        await redis(['HSET', key, 'meta', meta, pf(b.name), JSON.stringify({ name: b.name, joinedAt: Date.now() })]);
        await redis(['EXPIRE', key, TTL_SECONDS]);
        return res.status(200).json({ ok: true, round: 1 });
      }

      if (b.action === 'join') {
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (!metaRaw) return res.status(200).json({ error: 'not_found' });
        const meta = JSON.parse(metaRaw);
        if ((meta.round || 1) > 1) return res.status(200).json({ error: 'locked' });
        const fields = (await redis(['HKEYS', key])) || [];
        const count = fields.filter((f) => f.startsWith('p:')).length;
        if (count >= (meta.maxPlayers || 2)) return res.status(200).json({ error: 'full' });
        const added = await redis(['HSETNX', key, pf(b.name), JSON.stringify({ name: b.name, joinedAt: Date.now() })]);
        if (!added) return res.status(200).json({ error: 'name_taken' });
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'submit') {
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (!metaRaw) return res.status(200).json({ error: 'not_found' });
        const round = JSON.parse(metaRaw).round || 1;
        await redis(['HSET', key, rf(round, b.name), JSON.stringify({ roster: b.roster, completedAt: Date.now() })]);
        await redis(['EXPIRE', key, TTL_SECONDS]);
        return res.status(200).json({ ok: true, round });
      }

      if (b.action === 'next_round') {
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (!metaRaw) return res.status(200).json({ error: 'not_found' });
        const meta = JSON.parse(metaRaw);
        meta.round = (meta.round || 1) + 1;
        await redis(['HSET', key, 'meta', JSON.stringify(meta)]);
        await redis(['EXPIRE', key, TTL_SECONDS]);
        return res.status(200).json({ ok: true, round: meta.round });
      }

      if (b.action === 'drop') {
        if (!b.name) return res.status(400).json({ error: 'name_required' });
        await redis(['HDEL', key, pf(b.name)]); // remove membership; their orphan round rosters are ignored
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (metaRaw) {
          const meta = JSON.parse(metaRaw);
          const fields = (await redis(['HKEYS', key])) || [];
          const cur = fields.filter((f) => f.startsWith('p:')).length;
          if (cur >= 2 && cur < (meta.maxPlayers || 0)) { // close the vacated slot
            meta.maxPlayers = cur;
            await redis(['HSET', key, 'meta', JSON.stringify(meta)]);
          }
        }
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'close') { // "start with current players": lock the size to whoever's in
        const metaRaw = await redis(['HGET', key, 'meta']);
        if (!metaRaw) return res.status(200).json({ error: 'not_found' });
        const meta = JSON.parse(metaRaw);
        const fields = (await redis(['HKEYS', key])) || [];
        const cur = fields.filter((f) => f.startsWith('p:')).length;
        if (cur >= 2) {
          meta.maxPlayers = cur;
          await redis(['HSET', key, 'meta', JSON.stringify(meta)]);
          await redis(['EXPIRE', key, TTL_SECONDS]);
        }
        return res.status(200).json({ ok: true, maxPlayers: meta.maxPlayers });
      }

      return res.status(400).json({ error: 'bad_action' });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server', detail: String((e && e.message) || e) });
  }
};
