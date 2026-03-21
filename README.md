# HEGEMONY — Globe RTS (Multiplayer)

A real-time strategy game played on a 3D globe with WebSocket multiplayer.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

The server runs on **http://localhost:3000** by default.

## Playing with a Friend

### Option A: Same Network (LAN)
1. Find your local IP: `ipconfig` (Windows) or `ifconfig` / `ip a` (Mac/Linux)
2. Share `http://YOUR_LOCAL_IP:3000` with your friend
3. Both open the URL — game starts when 2 players connect

### Option B: Over the Internet (Recommended Methods)

#### Replit / Render / Railway (Easiest)
1. Push the project to GitHub
2. Import into [Replit](https://replit.com), [Render](https://render.com), or [Railway](https://railway.app)
3. It auto-detects Node.js — just deploy
4. Share the public URL with your friend

#### Fly.io (Free Tier)
```bash
# Install flyctl, then:
fly launch
fly deploy
```

#### ngrok (Quick Tunnel)
```bash
# Install ngrok, then:
ngrok http 3000
```
Share the generated `https://xxxx.ngrok.io` URL.

#### VPS (DigitalOcean, Linode, etc.)
```bash
scp -r hegemony-mp/ user@your-server:~/
ssh user@your-server
cd hegemony-mp
npm install
PORT=3000 node server.js
```

### Option C: Port Forwarding
1. Forward port 3000 on your router to your machine
2. Share `http://YOUR_PUBLIC_IP:3000`
3. (Less recommended — exposes your network)

## How to Play

| Action | Control |
|--------|---------|
| Orbit globe | Click + drag |
| Zoom | Scroll wheel |
| Select unit | Left click |
| Multi-select | Shift + click |
| Move | Right click ground |
| Attack | Right click enemy |
| Gather | Right click resource |
| Build structure | Click button, then click globe |

### Units
- **Worker** (50M) — Harvests minerals and energy from resource nodes
- **Soldier** (80M, 20E) — Combat unit

### Buildings
- **Outpost** (200M, 50E) — Increases population cap by 5
- **Defense Turret** (120M, 40E) — Auto-attacks nearby enemies

### Win Condition
Destroy the enemy **Command Base**.

## Architecture

```
hegemony-mp/
├── server.js          # Authoritative game server (Node.js + WebSocket)
├── public/
│   └── index.html     # Game client (Three.js + WebSocket)
├── package.json
└── README.md
```

- **Server** runs all game logic (movement, combat, resource gathering) at 20 ticks/sec
- **Clients** send commands (move, attack, build) and render the authoritative state
- No cheating possible — server validates all actions

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## Tech Stack
- **Server**: Node.js, Express, ws (WebSocket)
- **Client**: Three.js (r128), vanilla JS
- **Protocol**: JSON over WebSocket
