# RUSSELL FTD — Real Messaging Server

Real accounts. Real messages between real people. No fake replies.
Zero dependencies — only Node.js needed.

## 1. Run it on your Mac (2 minutes)

```
cd ~/Desktop/russell-ftd-server
node server.js
```

You'll see: `RUSSELL FTD server running: http://localhost:3000`

## 2. Test real messaging right now

1. Open **Safari** → go to `http://localhost:3000` → **Create an account** (e.g. `russell`)
2. Open **Chrome** (or a Safari Private window) → same address → create a second account (e.g. `amina`)
3. In one window: **Contacts** tab → tap the other user → send a message
4. Watch it arrive in the other window within 2 seconds. That's real messaging.

## 3. Test from your iPhone/iPad (same Wi-Fi)

1. Find your Mac's local IP: **System Settings → Wi-Fi → Details** (e.g. `192.168.1.5`)
2. On the iPhone, open Safari → `http://192.168.1.5:3000`
3. Register and chat — your Mac is now the server.

The **Server address** field on the login screen lets any device point at your server.

## 4. Put it on the internet (so anyone can use it)

Your Mac can't stay on forever. Host the server on a cloud service — good
options with free tiers:

- **Render** (render.com): New Web Service → upload this folder to GitHub →
  Build command: *(none)* → Start command: `node server.js`
- **Railway** (railway.app): similar, auto-detects Node

You'll get a URL like `https://russell-ftd.onrender.com` — type it in the
app's Server address field. HTTPS is required for the App Store version.

## 5. Wire the iOS app to it

Replace the `www/index.html` in your Capacitor project with `public/index.html`
from this folder, then:

```
cd ~/Desktop/russell-ftd-ios
npx cap sync ios
npx cap open ios
```

Build & run — the iOS app now has login and real chat. Enter your server's
URL on the login screen (must be `https://` for App Store builds).

## What's inside

- `server.js` — the whole backend: accounts (passwords stored hashed),
  login tokens, 1:1 chats, group chats, photo messages, unread counts,
  message history saved to `data.json`
- `public/index.html` — the RUSSELL FTD app, connected version

## Honest limits (fine for TestFlight, fix before big launch)

- Polling every 2s (simple + reliable) instead of instant push
- Photos stored as text in data.json — fine for testing, not for thousands of users
- No push notifications when app is closed (needs Apple Push service)
- Voice/video calling not included (needs WebRTC infrastructure)
