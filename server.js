/* RUSSELL FTD — real messaging server v2
 * Features: accounts, 1:1 + group chats, photos, status/stories (24h),
 * WebRTC call signaling (voice/video), read receipts, typing indicators.
 * Zero dependencies: plain Node.js (v18+). Run with:  node server.js
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 6 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/* ---------------- Storage ---------------- */
let db = { users: [], chats: [], tokens: {}, statuses: [], seq: 1 };
try {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!db.statuses) db.statuses = [];
  }
} catch (e) {
  console.error("Could not read data.json, starting fresh:", e.message);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => {
      if (err) console.error("save failed:", err.message);
    });
  }, 200);
}
function nid() { return db.seq++; }

/* In-memory (not persisted): call signals + typing state */
let signals = [];   // {id, ts, to, from, fromName, type, data}
let signalSeq = 1;
const typing = {};  // "chatId:userId" -> ts

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
function newToken(userId) {
  const t = crypto.randomBytes(24).toString("hex");
  db.tokens[t] = userId;
  save();
  return t;
}
function userFromReq(req) {
  const h = req.headers["authorization"] || "";
  const t = h.replace(/^Bearer\s+/i, "").trim();
  if (!t || !(t in db.tokens)) return null;
  return db.users.find(u => u.id === db.tokens[t]) || null;
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

function chatSummary(chat, me) {
  const last = chat.messages.length ? chat.messages[chat.messages.length - 1] : null;
  const lastRead = (chat.reads && chat.reads[me.id]) || 0;
  let unread = 0;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.ts <= lastRead) break;
    if (m.from !== me.id) unread++;
  }
  let name = chat.name;
  if (!chat.isGroup) {
    const otherId = chat.members.find(id => id !== me.id);
    const other = db.users.find(u => u.id === otherId);
    name = other ? other.name : "Unknown";
  }
  return {
    id: chat.id,
    name: name,
    isGroup: !!chat.isGroup,
    members: chat.members.map(id => {
      const u = db.users.find(x => x.id === id);
      return u ? publicUser(u) : { id: id, name: "?", username: "?" };
    }),
    unread: unread,
    lastMessage: last ? {
      text: last.img ? "📷 Photo" : last.text,
      fromName: last.fromName,
      fromMe: last.from === me.id,
      ts: last.ts
    } : null,
    lastTs: last ? last.ts : (chat.created || 0)
  };
}

/* ---------------- Routes ---------------- */
const routes = {

  "POST /api/register": (req, res, body) => {
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.name || "").trim() || username;
    const password = String(body.password || "");
    if (!/^[a-z0-9_.]{3,20}$/.test(username))
      return json(res, 400, { error: "Username: 3-20 chars, letters/numbers/._ only" });
    if (password.length < 4)
      return json(res, 400, { error: "Password must be at least 4 characters" });
    if (db.users.some(u => u.username === username))
      return json(res, 409, { error: "Username already taken" });
    const user = { id: nid(), username, name: name.slice(0, 40), pass: hashPassword(password), created: Date.now() };
    db.users.push(user);
    save();
    json(res, 200, { token: newToken(user.id), user: publicUser(user) });
  },

  "POST /api/login": (req, res, body) => {
    const username = String(body.username || "").trim().toLowerCase();
    const user = db.users.find(u => u.username === username);
    if (!user || !checkPassword(String(body.password || ""), user.pass))
      return json(res, 401, { error: "Wrong username or password" });
    json(res, 200, { token: newToken(user.id), user: publicUser(user) });
  },

  "GET /api/me": (req, res, body, me) => {
    json(res, 200, { user: publicUser(me) });
  },

  "GET /api/users": (req, res, body, me) => {
    json(res, 200, { users: db.users.filter(u => u.id !== me.id).map(publicUser) });
  },

  /* ---------- chats ---------- */
  "GET /api/chats": (req, res, body, me) => {
    const list = db.chats
      .filter(c => c.members.includes(me.id))
      .map(c => chatSummary(c, me))
      .sort((a, b) => b.lastTs - a.lastTs);
    json(res, 200, { chats: list });
  },

  "POST /api/chats": (req, res, body, me) => {
    const isGroup = !!body.isGroup;
    let memberIds = Array.isArray(body.memberIds) ? body.memberIds.map(Number) : [];
    memberIds = memberIds.filter(id => db.users.some(u => u.id === id) && id !== me.id);
    if (!isGroup) {
      if (memberIds.length !== 1) return json(res, 400, { error: "Pick exactly one contact" });
      const existing = db.chats.find(c => !c.isGroup && c.members.includes(me.id) && c.members.includes(memberIds[0]));
      if (existing) return json(res, 200, { chat: chatSummary(existing, me) });
    } else {
      if (memberIds.length < 1) return json(res, 400, { error: "Pick at least one member" });
      if (!String(body.name || "").trim()) return json(res, 400, { error: "Group needs a name" });
    }
    const chat = {
      id: nid(),
      isGroup: isGroup,
      name: isGroup ? String(body.name).trim().slice(0, 40) : null,
      members: [me.id].concat(memberIds),
      messages: [],
      reads: {},
      created: Date.now()
    };
    db.chats.push(chat);
    save();
    json(res, 200, { chat: chatSummary(chat, me) });
  },

  /* ---------- messages ---------- */
  "GET /api/messages": (req, res, body, me, query) => {
    const chat = db.chats.find(c => c.id === Number(query.chatId));
    if (!chat || !chat.members.includes(me.id)) return json(res, 404, { error: "Chat not found" });
    const after = Number(query.after || 0);
    const msgs = chat.messages.filter(m => m.ts > after).slice(-200);
    if (chat.messages.length) {
      chat.reads = chat.reads || {};
      const newest = chat.messages[chat.messages.length - 1].ts;
      if ((chat.reads[me.id] || 0) < newest) {
        chat.reads[me.id] = newest;
        save();
      }
    }
    // typing users (others, active within 4s)
    const now = Date.now();
    const typers = [];
    chat.members.forEach(id => {
      if (id === me.id) return;
      const t = typing[chat.id + ":" + id];
      if (t && now - t < 4000) {
        const u = db.users.find(x => x.id === id);
        if (u) typers.push(u.name);
      }
    });
    json(res, 200, { messages: msgs, reads: chat.reads || {}, typing: typers });
  },

  "POST /api/messages": (req, res, body, me) => {
    const chat = db.chats.find(c => c.id === Number(body.chatId));
    if (!chat || !chat.members.includes(me.id)) return json(res, 404, { error: "Chat not found" });
    const text = String(body.text || "").slice(0, 4000);
    let img = validImg(body.img) ? body.img : null;
    if (!text && !img) return json(res, 400, { error: "Empty message" });
    const msg = { id: nid(), from: me.id, fromName: me.name, text, img, ts: Date.now() };
    chat.messages.push(msg);
    if (chat.messages.length > 2000) chat.messages = chat.messages.slice(-2000);
    chat.reads = chat.reads || {};
    chat.reads[me.id] = msg.ts;
    delete typing[chat.id + ":" + me.id];
    save();
    json(res, 200, { message: msg });
  },

  "POST /api/typing": (req, res, body, me) => {
    const chat = db.chats.find(c => c.id === Number(body.chatId));
    if (chat && chat.members.includes(me.id)) typing[chat.id + ":" + me.id] = Date.now();
    json(res, 200, { ok: true });
  },

  /* ---------- status / stories ---------- */
  "GET /api/status": (req, res, body, me) => {
    const cutoff = Date.now() - DAY;
    db.statuses = db.statuses.filter(s => s.ts > cutoff);
    const byUser = {};
    db.statuses.forEach(s => {
      if (!byUser[s.userId]) {
        const u = db.users.find(x => x.id === s.userId);
        byUser[s.userId] = { user: u ? publicUser(u) : { id: s.userId, name: "?", username: "?" }, items: [] };
      }
      byUser[s.userId].items.push({
        id: s.id, text: s.text, bg: s.bg, img: s.img, ts: s.ts,
        seen: (s.views || []).includes(me.id)
      });
    });
    const mine = byUser[me.id] || { user: publicUser(me), items: [] };
    delete byUser[me.id];
    const others = Object.values(byUser).sort((a, b) => {
      const la = a.items[a.items.length - 1].ts, lb = b.items[b.items.length - 1].ts;
      return lb - la;
    });
    json(res, 200, { mine: mine, others: others });
  },

  "POST /api/status": (req, res, body, me) => {
    const text = String(body.text || "").slice(0, 200);
    const img = validImg(body.img, 3 * 1024 * 1024) ? body.img : null;
    if (!text && !img) return json(res, 400, { error: "Empty status" });
    const st = {
      id: nid(), userId: me.id, text: text, img: img,
      bg: String(body.bg || "").slice(0, 120), ts: Date.now(), views: []
    };
    db.statuses.push(st);
    if (db.statuses.length > 500) db.statuses = db.statuses.slice(-500);
    save();
    json(res, 200, { status: { id: st.id, ts: st.ts } });
  },

  "POST /api/status/view": (req, res, body, me) => {
    const st = db.statuses.find(s => s.id === Number(body.id));
    if (st) {
      st.views = st.views || [];
      if (!st.views.includes(me.id)) { st.views.push(me.id); save(); }
    }
    json(res, 200, { ok: true });
  },

  /* ---------- call signaling (WebRTC) ---------- */
  "POST /api/signal": (req, res, body, me) => {
    const to = Number(body.to);
    if (!db.users.some(u => u.id === to)) return json(res, 400, { error: "No such user" });
    const type = String(body.type || "").slice(0, 30);
    if (!type) return json(res, 400, { error: "Missing type" });
    let data = body.data;
    try {
      if (JSON.stringify(data).length > 200000) return json(res, 413, { error: "Signal too large" });
    } catch (e) { data = null; }
    signals.push({ id: signalSeq++, ts: Date.now(), to: to, from: me.id, fromName: me.name, type: type, data: data });
    const cutoff = Date.now() - 90000;
    signals = signals.filter(s => s.ts > cutoff);
    if (signals.length > 1000) signals = signals.slice(-1000);
    json(res, 200, { ok: true });
  },

  "GET /api/signal": (req, res, body, me, query) => {
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
  req.on("end", () => {
    let body = {};
    if (chunks.length) {
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch (e) { return json(res, 400, { error: "Bad JSON" }); }
    }
    const query = Object.fromEntries(u.searchParams);
    if (OPEN_ROUTES[key]) return handler(req, res, body);
    const me = userFromReq(req);
    if (!me) return json(res, 401, { error: "Please log in" });
    try { handler(req, res, body, me, query); }
    catch (e) { console.error(e); json(res, 500, { error: "Server error" }); }
  });
});

server.listen(PORT, () => {
  console.log("RUSSELL FTD server v2 running:");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("Features: chats, groups, photos, status, real calls, ticks, typing.");
});
