/* RUSSELL FTD — messaging server v3 (PostgreSQL persistence)
 * Accounts, messages, groups, photos, status, calls, ticks, typing.
 * Data persists permanently in PostgreSQL (survives restarts).
 * Needs env var DATABASE_URL (Render provides it). Run:  npm start
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 6 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL environment variable is not set.");
  console.error("On Render, create a free PostgreSQL database and it will be provided automatically.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 8
});

async function q(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/* In-memory (ephemeral by nature): call signals + typing state */
let signals = [];
let signalSeq = 1;
const typing = {};

/* ---------------- Schema ---------------- */
async function initDb() {
  await q(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    pass TEXT NOT NULL,
    created BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  )`);
  await q(`CREATE TABLE IF NOT EXISTS chats (
    id SERIAL PRIMARY KEY,
    is_group BOOLEAN NOT NULL DEFAULT false,
    name TEXT,
    created BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (chat_id, user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    from_id INTEGER NOT NULL,
    from_name TEXT NOT NULL,
    body TEXT,
    img TEXT,
    ts BIGINT NOT NULL
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, ts)`);
  await q(`CREATE TABLE IF NOT EXISTS reads (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    ts BIGINT NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS statuses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT,
    bg TEXT,
    img TEXT,
    ts BIGINT NOT NULL
  )`);
  await q(`CREATE TABLE IF NOT EXISTS status_views (
    status_id INTEGER NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    PRIMARY KEY (status_id, user_id)
  )`);
  /* User-Generated-Content safety (App Store Guideline 1.2) */
  await q(`CREATE TABLE IF NOT EXISTS blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    ts BIGINT NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER NOT NULL,
    reported_id INTEGER,
    chat_id INTEGER,
    message_id INTEGER,
    reason TEXT,
    handled BOOLEAN NOT NULL DEFAULT false,
    ts BIGINT NOT NULL
  )`);
  console.log("Database schema ready.");
}

/* ---------------- Auth helpers ---------------- */
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return salt + ":" + hash;
}
function checkPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(":");
    const test = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch (e) { return false; }
}
async function newToken(userId) {
  const t = crypto.randomBytes(24).toString("hex");
  await q("INSERT INTO tokens(token, user_id) VALUES($1,$2)", [t, userId]);
  return t;
}
async function userFromReq(req) {
  const h = req.headers["authorization"] || "";
  const t = h.replace(/^Bearer\s+/i, "").trim();
  if (!t) return null;
  const rows = await q(
    "SELECT u.* FROM tokens tk JOIN users u ON u.id = tk.user_id WHERE tk.token = $1",
    [t]
  );
  return rows[0] || null;
}

/* ---------------- API helpers ---------------- */
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}
function publicUser(u) { return { id: u.id, username: u.username, name: u.name }; }
function validImg(s, max) {
  return typeof s === "string" &&
    /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(s) &&
    s.length < (max || 5 * 1024 * 1024);
}

async function chatSummary(chatRow, me) {
  const members = await q(
    "SELECT u.id, u.username, u.name FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = $1",
    [chatRow.id]
  );
  const lastRows = await q(
    "SELECT * FROM messages WHERE chat_id = $1 ORDER BY ts DESC LIMIT 1", [chatRow.id]
  );
  const last = lastRows[0] || null;
  const readRows = await q(
    "SELECT ts FROM reads WHERE chat_id = $1 AND user_id = $2", [chatRow.id, me.id]
  );
  const lastRead = readRows.length ? Number(readRows[0].ts) : 0;
  const unreadRows = await q(
    "SELECT COUNT(*)::int AS n FROM messages WHERE chat_id = $1 AND ts > $2 AND from_id <> $3",
    [chatRow.id, lastRead, me.id]
  );
  const unread = unreadRows[0].n;
  let name = chatRow.name;
  if (!chatRow.is_group) {
    const other = members.find(m => m.id !== me.id);
    name = other ? other.name : "Unknown";
  }
  return {
    id: chatRow.id,
    name: name,
    isGroup: chatRow.is_group,
    members: members.map(publicUser),
    unread: unread,
    lastMessage: last ? {
      text: last.img ? "📷 Photo" : last.body,
      fromName: last.from_name,
      fromMe: last.from_id === me.id,
      ts: Number(last.ts)
    } : null,
    lastTs: last ? Number(last.ts) : Number(chatRow.created)
  };
}

function msgOut(m) {
  return { id: m.id, from: m.from_id, fromName: m.from_name, text: m.body || "", img: m.img || null, ts: Number(m.ts) };
}

/* Returns all user ids that `meId` should not see, in either direction:
   people I blocked, and people who blocked me. */
async function blockedIds(meId) {
  const rows = await q(
    "SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1 " +
    "UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = $1",
    [meId]
  );
  return rows.map(r => Number(r.id));
}

/* ---------------- Routes ---------------- */
const routes = {

  "POST /api/register": async (req, res, body) => {
    const username = String(body.username || "").trim().toLowerCase();
    const name = (String(body.name || "").trim() || username).slice(0, 40);
    const password = String(body.password || "");
    if (!/^[a-z0-9_.]{3,20}$/.test(username))
      return json(res, 400, { error: "Username: 3-20 chars, letters/numbers/._ only" });
    if (password.length < 4)
      return json(res, 400, { error: "Password must be at least 4 characters" });
    if (body.agree !== true)
      return json(res, 400, { error: "You must accept the Terms of Use to create an account" });
    const exists = await q("SELECT 1 FROM users WHERE username = $1", [username]);
    if (exists.length) return json(res, 409, { error: "Username already taken" });
    const rows = await q(
      "INSERT INTO users(username, name, pass, created) VALUES($1,$2,$3,$4) RETURNING *",
      [username, name, hashPassword(password), Date.now()]
    );
    const user = rows[0];
    json(res, 200, { token: await newToken(user.id), user: publicUser(user) });
  },

  "POST /api/login": async (req, res, body) => {
    const username = String(body.username || "").trim().toLowerCase();
    const rows = await q("SELECT * FROM users WHERE username = $1", [username]);
    const user = rows[0];
    if (!user || !checkPassword(String(body.password || ""), user.pass))
      return json(res, 401, { error: "Wrong username or password" });
    json(res, 200, { token: await newToken(user.id), user: publicUser(user) });
  },

  "GET /api/me": async (req, res, body, me) => {
    json(res, 200, { user: publicUser(me) });
  },

  "GET /api/users": async (req, res, body, me) => {
    const blocked = await blockedIds(me.id);
    const rows = await q(
      "SELECT id, username, name FROM users WHERE id <> $1 AND NOT (id = ANY($2::int[])) ORDER BY name",
      [me.id, blocked]
    );
    json(res, 200, { users: rows.map(publicUser) });
  },

  "GET /api/chats": async (req, res, body, me) => {
    const chatRows = await q(
      "SELECT c.* FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE cm.user_id = $1",
      [me.id]
    );
    const blocked = new Set(await blockedIds(me.id));
    const list = [];
    for (const c of chatRows) {
      const summary = await chatSummary(c, me);
      if (!summary.isGroup) {
        const other = summary.members.find(m => m.id !== me.id);
        if (other && blocked.has(other.id)) continue; // hide blocked 1:1 chats
      }
      list.push(summary);
    }
    list.sort((a, b) => b.lastTs - a.lastTs);
    json(res, 200, { chats: list });
  },

  "POST /api/chats": async (req, res, body, me) => {
    const isGroup = !!body.isGroup;
    let memberIds = Array.isArray(body.memberIds) ? body.memberIds.map(Number) : [];
    const valid = await q("SELECT id FROM users WHERE id = ANY($1::int[])", [memberIds]);
    const validSet = new Set(valid.map(r => r.id));
    memberIds = memberIds.filter(id => validSet.has(id) && id !== me.id);
    if (!isGroup) {
      if (memberIds.length !== 1) return json(res, 400, { error: "Pick exactly one contact" });
      const existing = await q(
        `SELECT c.* FROM chats c
         WHERE c.is_group = false
         AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $1)
         AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = $2)
         AND (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) = 2
         LIMIT 1`,
        [me.id, memberIds[0]]
      );
      if (existing.length) return json(res, 200, { chat: await chatSummary(existing[0], me) });
    } else {
      if (memberIds.length < 1) return json(res, 400, { error: "Pick at least one member" });
      if (!String(body.name || "").trim()) return json(res, 400, { error: "Group needs a name" });
    }
    const created = Date.now();
    const chatRows = await q(
      "INSERT INTO chats(is_group, name, created) VALUES($1,$2,$3) RETURNING *",
      [isGroup, isGroup ? String(body.name).trim().slice(0, 40) : null, created]
    );
    const chat = chatRows[0];
    const all = [me.id].concat(memberIds);
    for (const uid of all) {
      await q("INSERT INTO chat_members(chat_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [chat.id, uid]);
    }
    json(res, 200, { chat: await chatSummary(chat, me) });
  },

  "GET /api/messages": async (req, res, body, me, query) => {
    const chatId = Number(query.chatId);
    const member = await q("SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2", [chatId, me.id]);
    if (!member.length) return json(res, 404, { error: "Chat not found" });
    const after = Number(query.after || 0);
    const blocked = await blockedIds(me.id);
    const rows = await q(
      "SELECT * FROM messages WHERE chat_id = $1 AND ts > $2 AND NOT (from_id = ANY($3::int[])) ORDER BY ts ASC LIMIT 200",
      [chatId, after, blocked]
    );
    const newestRows = await q("SELECT MAX(ts) AS m FROM messages WHERE chat_id = $1", [chatId]);
    const newest = newestRows[0].m;
    if (newest) {
      await q(
        `INSERT INTO reads(chat_id, user_id, ts) VALUES($1,$2,$3)
         ON CONFLICT (chat_id, user_id) DO UPDATE SET ts = GREATEST(reads.ts, EXCLUDED.ts)`,
        [chatId, me.id, newest]
      );
    }
    const readRows = await q("SELECT user_id, ts FROM reads WHERE chat_id = $1", [chatId]);
    const reads = {};
    readRows.forEach(r => { reads[r.user_id] = Number(r.ts); });
    const now = Date.now();
    const memRows = await q("SELECT user_id FROM chat_members WHERE chat_id = $1", [chatId]);
    const typers = [];
    for (const m of memRows) {
      if (m.user_id === me.id) continue;
      const t = typing[chatId + ":" + m.user_id];
      if (t && now - t < 4000) {
        const u = await q("SELECT name FROM users WHERE id = $1", [m.user_id]);
        if (u.length) typers.push(u[0].name);
      }
    }
    json(res, 200, { messages: rows.map(msgOut), reads: reads, typing: typers });
  },

  "POST /api/messages": async (req, res, body, me) => {
    const chatId = Number(body.chatId);
    const member = await q("SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2", [chatId, me.id]);
    if (!member.length) return json(res, 404, { error: "Chat not found" });
    const text = String(body.text || "").slice(0, 4000);
    const img = validImg(body.img) ? body.img : null;
    if (!text && !img) return json(res, 400, { error: "Empty message" });
    const ts = Date.now();
    const rows = await q(
      "INSERT INTO messages(chat_id, from_id, from_name, body, img, ts) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [chatId, me.id, me.name, text, img, ts]
    );
    await q(
      `INSERT INTO reads(chat_id, user_id, ts) VALUES($1,$2,$3)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET ts = EXCLUDED.ts`,
      [chatId, me.id, ts]
    );
    delete typing[chatId + ":" + me.id];
    json(res, 200, { message: msgOut(rows[0]) });
  },

  "POST /api/typing": async (req, res, body, me) => {
    const chatId = Number(body.chatId);
    const member = await q("SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2", [chatId, me.id]);
    if (member.length) typing[chatId + ":" + me.id] = Date.now();
    json(res, 200, { ok: true });
  },

  "GET /api/status": async (req, res, body, me) => {
    const cutoff = Date.now() - DAY;
    await q("DELETE FROM statuses WHERE ts < $1", [cutoff]);
    const rows = await q(
      `SELECT s.*, u.username, u.name AS uname,
        EXISTS(SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.user_id = $1) AS seen
       FROM statuses s JOIN users u ON u.id = s.user_id
       ORDER BY s.ts ASC`,
      [me.id]
    );
    const byUser = {};
    for (const s of rows) {
      if (!byUser[s.user_id]) byUser[s.user_id] = { user: { id: s.user_id, username: s.username, name: s.uname }, items: [] };
      byUser[s.user_id].items.push({ id: s.id, text: s.body, bg: s.bg, img: s.img, ts: Number(s.ts), seen: s.seen });
    }
    const mine = byUser[me.id] || { user: publicUser(me), items: [] };
    delete byUser[me.id];
    const others = Object.values(byUser).sort((a, b) =>
      b.items[b.items.length - 1].ts - a.items[a.items.length - 1].ts);
    json(res, 200, { mine, others });
  },

  "POST /api/status": async (req, res, body, me) => {
    const text = String(body.text || "").slice(0, 200);
    const img = validImg(body.img, 3 * 1024 * 1024) ? body.img : null;
    if (!text && !img) return json(res, 400, { error: "Empty status" });
    const rows = await q(
      "INSERT INTO statuses(user_id, body, bg, img, ts) VALUES($1,$2,$3,$4,$5) RETURNING id, ts",
      [me.id, text, String(body.bg || "").slice(0, 120), img, Date.now()]
    );
    json(res, 200, { status: { id: rows[0].id, ts: Number(rows[0].ts) } });
  },

  "POST /api/status/view": async (req, res, body, me) => {
    await q("INSERT INTO status_views(status_id, user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [Number(body.id), me.id]);
    json(res, 200, { ok: true });
  },

  "POST /api/delete-account": async (req, res, body, me) => {
    /* Permanently delete the user and all data they've shared.
       Deleting the user row cascades to tokens, chat_members, statuses,
       and status_views (ON DELETE CASCADE). Messages are removed explicitly. */
    await q("DELETE FROM messages WHERE from_id = $1", [me.id]);
    await q("DELETE FROM users WHERE id = $1", [me.id]);
    json(res, 200, { ok: true });
  },

  /* ---- User-Generated-Content safety (Guideline 1.2) ---- */

  "POST /api/report": async (req, res, body, me) => {
    /* Flag objectionable content or an abusive user. Stored for moderation. */
    const reportedId = body.reportedId ? Number(body.reportedId) : null;
    const chatId = body.chatId ? Number(body.chatId) : null;
    const messageId = body.messageId ? Number(body.messageId) : null;
    const reason = String(body.reason || "").slice(0, 500);
    await q(
      "INSERT INTO reports(reporter_id, reported_id, chat_id, message_id, reason, ts) VALUES($1,$2,$3,$4,$5,$6)",
      [me.id, reportedId, chatId, messageId, reason, Date.now()]
    );
    json(res, 200, { ok: true });
  },

  "POST /api/block": async (req, res, body, me) => {
    /* Block an abusive user. Their messages disappear from this user's feed
       instantly, and the block is logged so the developer is notified. */
    const targetId = Number(body.targetId);
    const exists = await q("SELECT 1 FROM users WHERE id = $1", [targetId]);
    if (!exists.length) return json(res, 400, { error: "No such user" });
    if (targetId === me.id) return json(res, 400, { error: "You cannot block yourself" });
    await q(
      "INSERT INTO blocks(blocker_id, blocked_id, ts) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [me.id, targetId, Date.now()]
    );
    /* Notify developer/moderation of the block + any provided reason. */
    await q(
      "INSERT INTO reports(reporter_id, reported_id, reason, ts) VALUES($1,$2,$3,$4)",
      [me.id, targetId, String(body.reason || "User blocked as abusive").slice(0, 500), Date.now()]
    );
    json(res, 200, { ok: true });
  },

  "POST /api/unblock": async (req, res, body, me) => {
    await q("DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2", [me.id, Number(body.targetId)]);
    json(res, 200, { ok: true });
  },

  "GET /api/blocks": async (req, res, body, me) => {
    const rows = await q(
      "SELECT u.id, u.username, u.name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY u.name",
      [me.id]
    );
    json(res, 200, { blocked: rows.map(publicUser) });
  },

  "POST /api/signal": async (req, res, body, me) => {
    const to = Number(body.to);
    const exists = await q("SELECT 1 FROM users WHERE id = $1", [to]);
    if (!exists.length) return json(res, 400, { error: "No such user" });
    const type = String(body.type || "").slice(0, 30);
    if (!type) return json(res, 400, { error: "Missing type" });
    let data = body.data;
    try { if (JSON.stringify(data).length > 200000) return json(res, 413, { error: "Signal too large" }); }
    catch (e) { data = null; }
    signals.push({ id: signalSeq++, ts: Date.now(), to, from: me.id, fromName: me.name, type, data });
    const cutoff = Date.now() - 90000;
    signals = signals.filter(s => s.ts > cutoff);
    if (signals.length > 1000) signals = signals.slice(-1000);
    json(res, 200, { ok: true });
  },

  "GET /api/signal": async (req, res, body, me, query) => {
    const after = Number(query.after || 0);
    const mine = signals.filter(s => s.to === me.id && s.id > after);
    json(res, 200, { signals: mine, last: signals.length ? signals[signals.length - 1].id : after });
  }
};

const OPEN_ROUTES = { "POST /api/register": 1, "POST /api/login": 1 };

/* ---------------- Static files ---------------- */
function serveStatic(req, res, urlPath) {
  let file = urlPath === "/" ? "/index.html" : urlPath;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    const ext = path.extname(full).toLowerCase();
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".ico": "image/x-icon" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------- Server ---------------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://localhost");
  const key = req.method + " " + u.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  if (u.pathname === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (!u.pathname.startsWith("/api/")) return serveStatic(req, res, u.pathname);

  const handler = routes[key];
  if (!handler) return json(res, 404, { error: "No such endpoint" });

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BODY) { json(res, 413, { error: "Too large" }); req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", async () => {
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch (e) { return json(res, 400, { error: "Bad JSON" }); }
    }
    const query = Object.fromEntries(u.searchParams);
    try {
      if (OPEN_ROUTES[key]) return await handler(req, res, body);
      const me = await userFromReq(req);
      if (!me) return json(res, 401, { error: "Please log in" });
      await handler(req, res, body, me, query);
    } catch (e) {
      console.error("Handler error:", e);
      json(res, 500, { error: "Server error" });
    }
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log("RUSSELL FTD server v3 (PostgreSQL) running on port " + PORT);
    console.log("Data now persists permanently across restarts.");
  });
}).catch(err => {
  console.error("Failed to initialise database:", err);
  process.exit(1);
});
