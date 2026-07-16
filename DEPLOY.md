# Deploying the Replenishment Planner for your team

This turns the local tool into a shared https:// site your team logs into. It runs on
[Fly.io](https://fly.io) — one small always-on machine with a persistent disk for the SQLite
database. At this size it costs roughly **$0–3/month** (Fly waives invoices under $5), and needs a
credit card on file.

Your data (transfers, POs, snapshots) lives on the machine's disk and is backed up daily inside the
app. Nothing here rewrites the app — it's the same server, just reachable and behind a login.

## One-time setup

1. **Install the Fly CLI and sign in**
   ```sh
   brew install flyctl        # or: curl -L https://fly.io/install.sh | sh
   fly auth signup            # (or `fly auth login` if you already have an account)
   ```

2. **Create the app (don't deploy yet)** — from the project folder:
   ```sh
   fly launch --no-deploy --copy-config
   ```
   Accept the settings from `fly.toml`. If the name `qalo-replen` is taken, it'll pick a unique one —
   note the final app name and region.

3. **Create the persistent disk** (holds the database):
   ```sh
   fly volumes create replen_data --size 1 --region <your-region>
   ```

4. **Set the shared login** (pick any username/password — your team all use the same one):
   ```sh
   fly secrets set AUTH_USER=qalo AUTH_PASS='choose-a-strong-password'
   ```

5. **Deploy**
   ```sh
   fly deploy
   ```
   When it finishes, `fly open` launches the site. The browser will prompt for the username/password
   you set above.

## Bring your existing data over (optional but recommended)

A fresh deploy starts with an empty database. To keep your current transfers, POs, and snapshots,
copy your local DB onto the volume **once, right after the first deploy**:

```sh
fly machine stop            # stop the app so the DB file isn't in use
fly sftp shell
  put data/replen.db /data/replen.db
  quit
fly machine start
```

(Alternatively, skip this and just re-import your two files — the FBA export and the NetSuite
warehouse report — on the new site. That rebuilds the catalog + warehouse, but in-flight transfers
and POs would not carry over. Copying the DB is the clean option.)

## Day-to-day

- **Share with the team:** send them the URL + the username/password. That's the whole login.
- **Change the password / rotate access:** `fly secrets set AUTH_PASS='new-password'` (redeploys automatically).
- **Update the app after code changes:** `git`-commit as usual, then `fly deploy`.
- **Logs / health:** `fly logs`, and `https://<your-app>.fly.dev/health` should return `{"ok":true}`.

## Important guardrails

- **Keep it to one machine.** SQLite means only one process may touch the database file. Do not run
  `fly scale count 2` — it would corrupt/split the data. One machine is plenty for your team.
- **Backups** run daily inside the app to `/data/backups` (kept 30 days). To pull one down:
  `fly sftp get /data/backups/replen-YYYY-MM-DD.db`.
- The site sleeps when idle and wakes on the next request (a ~1–2s cold start). That's what keeps the
  cost near zero; set `min_machines_running = 1` in `fly.toml` if you'd rather it never sleeps.
