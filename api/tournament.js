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
//   POST {action:'next_round', id, from}    -> {ok, round}     (any member; locks membership. `from` =
//        the round the client saw; advances only if it still matches -> concurrent clicks can't skip a round)
//   POST {action:'drop',  id, name}         -> {ok}            (also closes the vacated slot: maxPlayers=members)
//   POST {action:'close', id}               -> {ok, maxPlayers}(start now: lock maxPlayers to current members)
//
// "Challenge the World" all-time ladder lives in ONE global hash `world:all`:
//   field "<name>" -> {name, roster, submittedAt}   (one entry per name; resubmit replaces)
//   GET  /api/tournament?world=1  -> {entries:[...], month:'YYYY-MM', champions:[{month,name,w,l,roster,at}]}
//        Monthly seasons: on a calendar-month change the previous month's leader is crowned into
//        `world:champions` (hash by month) and `world:all` is reset (lazy, on first GET/submit of the new month).
//   POST {action:'world_endmonth', key} -> {ok, crowned}  (admin: crown the current leader + reset now)
//   POST {action:'world_submit', name, roster} -> {ok}
//   POST {action:'world_delete', key, name}    -> {ok} | {error:'forbidden'}   (admin: remove one squad)
//   POST {action:'world_reset',  key}          -> {ok} | {error:'forbidden'}   (admin: clear the board)
//        admin actions require key === process.env.ADMIN_KEY (set in Vercel; never in the client bundle)
//   Feedback messages live in ONE global hash `feedback:all` (field <id> -> {id,name,msg,at}):
//   POST {action:'feedback_submit', name, msg, hp}  -> {ok}   (public; hp = honeypot, msg capped 1000)
//   POST {action:'feedback_list',   key}            -> {items} (admin)
//   POST {action:'feedback_delete', key, id} / {action:'feedback_clear', key} -> {ok} (admin)
//   Sub-leagues = private/public mini-Worlds, ONE hash `league:<ID>` (field "meta", fields "t:<tid>" -> team).
//   The all-time team ladder is computed client-side (everyone-vs-everyone), like the World. Public leagues
//   are indexed in hash `leagues:pub` (field <ID> -> {id,name,teams,createdAt}) for the Browse directory.
//   GET  ?leagues=1            -> {leagues:[{id,name,teams,createdAt}]}   (public directory, top 300)
//   GET  ?league=<ID>          -> {meta:{id,name,visibility,owner}, entries:[{name,owner,label,teamId,roster}]} | null
//   POST {action:'league_create', name, visibility, owner}        -> {ok, id}
//   POST {action:'league_submit', id, owner, token, label, roster}-> {ok, teamId} | {error:owner_cap|league_full|not_found}
//   POST {action:'league_delete_team', id, teamId, token|key}     -> {ok} | {error:forbidden}  (owner token or admin)
//   POST {action:'league_delete', id, key}                        -> {ok} | {error:forbidden}  (admin: drop a league)

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
const ADMIN_KEY = process.env.ADMIN_KEY; // set in Vercel env; gates world moderation (delete/reset)

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

// ---- Challenge-the-World monthly seasons ----
function monthKey() { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }
function _wprof(e) { // reduce an entry to category sums (rounded) + shooter eFG + team eFG, like the client
  const v = [0, 0, 0, 0, 0, 0]; let ts = 0, sh = null;
  (e.roster || []).forEach((p) => { if (!p) return; v[0] += p.ppg; v[1] += p.rpg; v[2] += p.apg; v[3] += p.spg; v[4] += p.bpg; v[5] += p.tpg; ts += (+p.efg || 0); if (p._shooter) sh = (+p.efg || 0); });
  for (let k = 0; k < 6; k++) v[k] = Math.round(v[k] * 10) / 10;
  return { name: e.name, roster: e.roster, v, ts, sh, w: 0, l: 0 };
}
function _wcmp(a, b) {
  let wa = 0, wb = 0;
  for (let k = 0; k < 6; k++) { const x = a.v[k], y = b.v[k]; if (k === 5) { if (x < y) wa++; else if (y < x) wb++; } else { if (x > y) wa++; else if (y > x) wb++; } }
  if (wa > wb) return 0; if (wb > wa) return 1;
  if (a.sh != null && b.sh != null) return a.sh >= b.sh ? 0 : 1;
  return a.ts >= b.ts ? 0 : 1;
}
function worldWinner(entries) {
  const b = entries.filter((e) => e.roster).map(_wprof); const n = b.length;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i === j) continue; if (_wcmp(b[i], b[j]) === 0) b[i].w++; else b[i].l++; }
  b.forEach((x) => { const g = x.w + x.l; x.pct = g ? x.w / g : 0; });
  b.sort((p, q) => q.pct - p.pct || q.w - p.w || String(p.name).localeCompare(String(q.name)));
  return b[0] || null;
}
async function worldEntries() {
  const flat = await redis(['HGETALL', 'world:all']); const out = [];
  if (flat) for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}
async function advEntries() { // advanced (per-season) ladder, separate all-time namespace
  const flat = await redis(['HGETALL', 'advworld:all']); const out = [];
  if (flat) for (let i = 0; i < flat.length; i += 2) { try { out.push(JSON.parse(flat[i + 1])); } catch (e) {} }
  return out;
}
async function crownIfNew(month) { // record the winner of `month` from the current board (HSETNX -> once)
  const entries = await worldEntries();
  if (entries.length < 2) return null;
  const win = worldWinner(entries);
  if (!win) return null;
  const added = await redis(['HSETNX', 'world:champions', month, JSON.stringify({ month, name: win.name, w: win.w, l: win.l, roster: win.roster, at: Date.now() })]);
  return added ? win.name : null;
}
async function worldRollover() { // lazy: when the calendar month changes, crown last month + reset
  const cur = monthKey();
  const m = await redis(['HGET', 'world:meta', 'm']);
  if (!m) { await redis(['HSET', 'world:meta', 'm', cur]); return cur; }
  if (m === cur) return cur;
  await crownIfNew(m);
  await redis(['DEL', 'world:all']);
  await redis(['HSET', 'world:meta', 'm', cur]);
  await redis(['EXPIRE', 'world:champions', TTL_SECONDS * 12]);
  return cur;
}

// ---- Sub-leagues (private/public mini-Worlds, all-time team ladder) ----
const lk = (id) => 'league:' + String(id).toUpperCase();
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode(n) { let s = ''; for (let i = 0; i < n; i++) s += CODE_CH[Math.floor(Math.random() * CODE_CH.length)]; return s; }
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
async function genLeagueId() { for (let i = 0; i < 20; i++) { const c = newCode(5); if (!(await redis(['EXISTS', lk(c)]))) return c; } return newCode(8); }
async function readHash(key) { const flat = await redis(['HGETALL', key]); if (!flat || flat.length === 0) return null; const h = {}; for (let i = 0; i < flat.length; i += 2) h[flat[i]] = flat[i + 1]; return h; }
async function pubSet(meta, teamsN) { // keep the public directory entry in sync (public leagues only)
  if (meta.visibility === 'public') await redis(['HSET', 'leagues:pub', meta.id, JSON.stringify({ id: meta.id, name: meta.name, teams: teamsN, createdAt: meta.createdAt })]);
}

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
        const month = await worldRollover();
        const entries = await worldEntries();
        const cflat = await redis(['HGETALL', 'world:champions']);
        const champions = [];
        if (cflat) for (let i = 0; i < cflat.length; i += 2) { try { champions.push(JSON.parse(cflat[i + 1])); } catch (e) {} }
        champions.sort((a, b) => String(b.month).localeCompare(String(a.month)));
        return res.status(200).json({ entries, month, champions });
      }
      if (req.query.advworld) { // advanced (per-season) ladder — all-time, own namespace
        return res.status(200).json({ entries: await advEntries() });
      }
      if (req.query.leagues) { // public league directory (browse)
        const flat = await redis(['HGETALL', 'leagues:pub']);
        const leagues = [];
        if (flat) for (let i = 0; i < flat.length; i += 2) { try { leagues.push(JSON.parse(flat[i + 1])); } catch (e) {} }
        leagues.sort((a, b) => (b.teams || 0) - (a.teams || 0) || (b.createdAt || 0) - (a.createdAt || 0));
        return res.status(200).json({ leagues: leagues.slice(0, 300) });
      }
      if (req.query.league) { // one league's all-time team ladder
        const h = await readHash(lk(req.query.league));
        if (!h || !h.meta) return res.status(200).json(null);
        const meta = JSON.parse(h.meta);
        const entries = Object.keys(h).filter((k) => k.startsWith('t:')).map((k) => {
          const t = JSON.parse(h[k]);
          return { name: t.label || t.owner || 'Team', owner: t.owner, label: t.label, teamId: t.teamId, roster: t.roster };
        });
        return res.status(200).json({ meta: { id: meta.id, name: meta.name, visibility: meta.visibility, owner: meta.owner }, entries });
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
        await worldRollover(); // start a fresh month if the calendar month changed
        // names are unique — HSETNX creates only if the name isn't already taken (no overwrite)
        const created = await redis(['HSETNX', 'world:all', b.name, JSON.stringify({ name: b.name, roster: b.roster, submittedAt: Date.now() })]);
        if (!created) return res.status(200).json({ error: 'name_taken' });
        await redis(['INCR', 'stats:squads']);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'advworld_submit') { // advanced (per-season) ladder — all-time, no monthly reset
        if (!b.name) return res.status(400).json({ error: 'name_required' });
        const created = await redis(['HSETNX', 'advworld:all', b.name, JSON.stringify({ name: b.name, roster: b.roster, submittedAt: Date.now() })]);
        if (!created) return res.status(200).json({ error: 'name_taken' });
        await redis(['INCR', 'stats:adv_squads']);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'advworld_delete') { // admin: remove one advanced squad
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        if (!b.name) return res.status(400).json({ error: 'name_required' });
        await redis(['HDEL', 'advworld:all', b.name]);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'advworld_reset') { // admin: clear the advanced ladder
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        await redis(['DEL', 'advworld:all']);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'world_endmonth') { // admin: crown the current leader now + start a fresh month
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        const cur = (await redis(['HGET', 'world:meta', 'm'])) || monthKey();
        const crowned = await crownIfNew(cur);
        await redis(['DEL', 'world:all']);
        return res.status(200).json({ ok: true, crowned });
      }
      if (b.action === 'world_delete') { // moderation: remove one squad (admin only)
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        if (!b.name) return res.status(400).json({ error: 'name_required' });
        await redis(['HDEL', 'world:all', b.name]);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'world_reset') { // moderation: clear the whole board (admin only)
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        await redis(['DEL', 'world:all']);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'champion_rename') { // admin: rename a crowned monthly champion
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        const name = String(b.name || '').trim().slice(0, 40);
        if (!b.month || !name) return res.status(400).json({ error: 'month_and_name_required' });
        const raw = await redis(['HGET', 'world:champions', b.month]);
        if (!raw) return res.status(404).json({ error: 'no_champion' });
        let c; try { c = JSON.parse(raw); } catch (e) { return res.status(500).json({ error: 'bad_record' }); }
        c.name = name;
        await redis(['HSET', 'world:champions', b.month, JSON.stringify(c)]);
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'stats') { // admin: engagement metrics (all-time counters + current snapshot)
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        const getn = async (k) => Number(await redis(['GET', k])) || 0;
        const hlen = async (k) => Number(await redis(['HLEN', k])) || 0;
        const allTime = {
          squads: await getn('stats:squads'), leagues: await getn('stats:leagues'),
          leagueTeams: await getn('stats:league_teams'), tournaments: await getn('stats:tournaments'),
        };
        const cflat = await redis(['HGETALL', 'leagues:pub']); let publicTeams = 0;
        if (cflat) for (let i = 1; i < cflat.length; i += 2) { try { publicTeams += JSON.parse(cflat[i]).teams || 0; } catch (e) {} }
        const now = {
          ladderSquads: await hlen('world:all'), champions: await hlen('world:champions'),
          advLadder: await hlen('advworld:all'),
          publicLeagues: await hlen('leagues:pub'), publicTeams, feedback: await hlen('feedback:all'),
        };
        return res.status(200).json({ allTime, now });
      }

      if (b.action === 'feedback_submit') { // public: store a message (honeypot + length cap vs spam)
        const msg = String(b.msg || '').trim().slice(0, 1000);
        if (!msg || b.hp) return res.status(200).json({ ok: true }); // empty or bot -> silently accept
        const id = `${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
        await redis(['HSET', 'feedback:all', id, JSON.stringify({ id, name: String(b.name || '').trim().slice(0, 40), msg, at: Date.now() })]);
        await redis(['EXPIRE', 'feedback:all', TTL_SECONDS]);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'feedback_list') { // admin only
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        const flat = await redis(['HGETALL', 'feedback:all']);
        const items = [];
        if (flat) for (let i = 0; i < flat.length; i += 2) { try { items.push(JSON.parse(flat[i + 1])); } catch (e) {} }
        items.sort((a, b2) => (b2.at || 0) - (a.at || 0));
        return res.status(200).json({ items });
      }
      if (b.action === 'feedback_delete') { // admin only
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        if (b.id) await redis(['HDEL', 'feedback:all', b.id]);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'feedback_clear') { // admin only
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        await redis(['DEL', 'feedback:all']);
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'league_create') { // create a public/private mini-World
        const name = clean(b.name, 40);
        if (!name) return res.status(400).json({ error: 'name_required' });
        const id = await genLeagueId();
        const meta = { id, name, visibility: b.visibility === 'public' ? 'public' : 'private', owner: clean(b.owner, 40), createdAt: Date.now() };
        await redis(['HSET', lk(id), 'meta', JSON.stringify(meta)]);
        await redis(['EXPIRE', lk(id), TTL_SECONDS]);
        await pubSet(meta, 0);
        await redis(['INCR', 'stats:leagues']);
        return res.status(200).json({ ok: true, id });
      }
      if (b.action === 'league_submit') { // add a team to a league (cap 10/owner, 1000/league)
        const h = await readHash(lk(b.id || ''));
        if (!h || !h.meta) return res.status(404).json({ error: 'not_found' });
        const meta = JSON.parse(h.meta);
        const tks = Object.keys(h).filter((k) => k.startsWith('t:'));
        if (tks.length >= 1000) return res.status(400).json({ error: 'league_full' });
        const owner = clean(b.owner, 40);
        if (owner && tks.filter((k) => { try { return JSON.parse(h[k]).owner === owner; } catch (e) { return false; } }).length >= 10)
          return res.status(400).json({ error: 'owner_cap' });
        const label = clean(b.label, 40);
        if (label && tks.some((k) => { try { return (JSON.parse(h[k]).label || '').toLowerCase() === label.toLowerCase(); } catch (e) { return false; } }))
          return res.status(400).json({ error: 'name_taken' });
        const tid = `${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
        await redis(['HSET', lk(b.id), 't:' + tid, JSON.stringify({ teamId: tid, owner, ownerToken: clean(b.token, 40), label, roster: b.roster, submittedAt: Date.now() })]);
        await redis(['EXPIRE', lk(b.id), TTL_SECONDS]);
        await pubSet(meta, tks.length + 1);
        await redis(['INCR', 'stats:league_teams']);
        return res.status(200).json({ ok: true, teamId: tid });
      }
      if (b.action === 'league_delete_team') { // owner-token (or admin) may remove a team
        const fld = 't:' + (b.teamId || '');
        const raw = await redis(['HGET', lk(b.id || ''), fld]);
        if (!raw) return res.status(200).json({ ok: true });
        const isAdmin = ADMIN_KEY && b.key === ADMIN_KEY;
        if (!isAdmin && JSON.parse(raw).ownerToken !== clean(b.token, 40)) return res.status(403).json({ error: 'forbidden' });
        await redis(['HDEL', lk(b.id), fld]);
        const metaRaw = await redis(['HGET', lk(b.id), 'meta']);
        if (metaRaw) { const meta = JSON.parse(metaRaw); if (meta.visibility === 'public') { const keys = (await redis(['HKEYS', lk(b.id)])) || []; await pubSet(meta, keys.filter((k) => k.startsWith('t:')).length); } }
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'league_delete') { // admin: remove a whole league (moderation)
        if (!ADMIN_KEY || b.key !== ADMIN_KEY) return res.status(403).json({ error: 'forbidden' });
        await redis(['DEL', lk(b.id || '')]);
        await redis(['HDEL', 'leagues:pub', String(b.id || '').toUpperCase()]);
        return res.status(200).json({ ok: true });
      }
      if (!b.id) return res.status(400).json({ error: 'id_required' });
      const key = keyOf(b.id);

      if (b.action === 'create') {
        const meta = JSON.stringify({ maxPlayers: Number(b.maxPlayers) || 2, createdAt: Date.now(), round: 1 });
        await redis(['HSET', key, 'meta', meta, pf(b.name), JSON.stringify({ name: b.name, joinedAt: Date.now() })]);
        await redis(['EXPIRE', key, TTL_SECONDS]);
        await redis(['INCR', 'stats:tournaments']);
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
        const cur = meta.round || 1;
        // compare-and-swap: only advance from the round the client saw, so two players both
        // clicking "Start Round N" (or a stale double-click) don't skip a round (1 -> 2 -> 3).
        if (b.from == null || Number(b.from) === cur) {
          meta.round = cur + 1;
          await redis(['HSET', key, 'meta', JSON.stringify(meta)]);
          await redis(['EXPIRE', key, TTL_SECONDS]);
        }
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
