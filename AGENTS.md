# RUSSELL FTD

Single-product Node.js repo. `server.js` is a from-scratch HTTP server (no web
framework) that serves both the REST API (`/api/*`) and a single-file vanilla-JS
web app (`public/index.html`). Persistence is PostgreSQL; schema is auto-created
on boot via `initDb()`. Only runtime dependency is `pg`. No build step, no lint
config, no automated tests exist in the repo.

Standard commands live in `package.json` (`npm start` → `node server.js`) and
`README.md`. Note the README's "zero dependencies" claim is outdated: this is
v3 and PostgreSQL is required.

## Cursor Cloud specific instructions

- **PostgreSQL is a hard boot requirement.** `server.js` exits immediately with
  `FATAL: DATABASE_URL environment variable is not set.` if `DATABASE_URL` is
  unset. There is no in-memory fallback.
- PostgreSQL 16 is installed in the VM but is not started automatically. Start
  it before running the server: `sudo pg_ctlcluster 16 main start`.
- A dev database and role are provisioned (they live in the persisted PG data
  dir). If missing after a fresh boot, recreate with:
  `sudo -u postgres psql -c "CREATE ROLE russell LOGIN PASSWORD 'russell';" -c "CREATE DATABASE russellftd OWNER russell;"`
- Run the server with the localhost connection string (SSL is auto-disabled when
  the URL contains `localhost`):
  `DATABASE_URL="postgres://russell:russell@localhost:5432/russellftd" node server.js`
  It listens on `PORT` (default 3000); health check is `GET /healthz`.
- End-to-end test flow: register two accounts (`POST /api/register` needs
  `agree:true`), create a 1:1 chat (`POST /api/chats` with `memberIds`), send a
  message (`POST /api/messages`), and the recipient sees it via
  `GET /api/messages?chatId=...`. In the browser, open two sessions and message
  between them. Real-time delivery is HTTP polling (~2s), not websockets.
- Call signaling and typing state are in-memory (reset on restart) by design.
