/* RUSSELL FTD — real messaging server
 * Zero dependencies: plain Node.js (v18+). Run with:  node server.js
 * Data is persisted to data.json next to this file.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_BODY = 6 * 1024 * 1024; // 6 MB (allows photo messages)

/* ---------------- Storage ---------------- */
let db = { users: [], chats: [], tokens: {}, seq: 1 };
try {
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
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

  "GET /api/messages": (req, res, body, me, query) => {
    const chat = db.chats.find(c => c.id === Number(query.chatId));
    if (!chat || !chat.members.includes(me.id)) return json(res, 404, { error: "Chat not found" });
    const after = Number(query.after || 0);
    const msgs = chat.messages.filter(m => m.ts > after).slice(-200);
    // mark read up to newest
    if (chat.messages.length) {
      chat.reads = chat.reads || {};
      chat.reads[me.id] = chat.messages[chat.messages.length - 1].ts;
      save();
    }
    json(res, 200, { messages: msgs });
  },

  "POST /api/messages": (req, res, body, me) => {
    const chat = db.chats.find(c => c.id === Number(body.chatId));
    if (!chat || !chat.members.includes(me.id)) return json(res, 404, { error: "Chat not found" });
    const text = String(body.text || "").slice(0, 4000);
    let img = null;
    if (typeof body.img === "string" && /^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(body.img) && body.img.length < 5 * 1024 * 1024) {
      img = body.img;
    }
    if (!text && !img) return json(res, 400, { error: "Empty message" });
    const msg = { id: nid(), from: me.id, fromName: me.name, text, img, ts: Date.now() };
    chat.messages.push(msg);
    if (chat.messages.length > 2000) chat.messages = chat.messages.slice(-2000);
    chat.reads = chat.reads || {};
    chat.reads[me.id] = msg.ts;
    save();
    json(res, 200, { message: msg });
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
  console.log("RUSSELL FTD server running:");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("Open in two different browsers, register two users, and chat for real.");
});
