# Deploying Euroleague Guru (with multiplayer backend)

The game is a static `index.html` plus one serverless function (`api/tournament.js`)
backed by **Vercel KV** (Redis). Tournaments persist and work across devices.

## Setup (one time, ~3 min)

1. **Import the repo into Vercel** (New Project → import this Git repo). It's a
   zero-config static site + functions — no build command, no framework.
2. **Create a KV store:** in the Vercel project → **Storage** tab → **Create Database**
   → **KV** → connect it to this project. Vercel auto-injects `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` into the project's environment variables.
3. **Deploy** (or redeploy so it picks up the new env vars).

That's it. Open the deployment URL:
- **Challenge a Friend → New Tournament** → share the link (it contains `?t=GURU-XXXX`).
- Friends open the link on any device → **Join** → draft → **Submit**.
- Everyone's rosters + standings are stored server-side and update on **Refresh**.

## How it works
- `index.html` calls `/api/tournament` for all persistence (the `tApi`/`tGet` helpers).
- Each tournament is one Redis hash `tourn:<ID>`; each player is a separate hash field,
  so concurrent **joins/submits are atomic** (no player gets overwritten).
- Keys auto-expire after 30 days.

## Local testing (no Vercel/Redis needed)
From `RawDataOriginal/`: `python3.12 devserver.py` → open http://localhost:8138/.
`devserver.py` mimics `/api/tournament` with an in-memory store (local only — don't deploy it).

## Rebuilding `index.html`
`index.html` is generated from `eurodraft_12.html` by `RawDataOriginal/build_v13.py`
(swaps the persistence layer). Re-run it after changing the base game.
