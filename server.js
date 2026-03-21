// ═══════════════════════════════════════════════════════════════
// HEGEMONY — Globe RTS — Multiplayer Server
// ═══════════════════════════════════════════════════════════════
// Authoritative server: all game logic runs here.
// Clients send commands, server broadcasts state.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ── Constants ──
const GLOBE_RADIUS = 5;
const TICK_RATE = 20; // 20 ticks/sec
const TICK_MS = 1000 / TICK_RATE;

// ── Unit Definitions ──
const UNIT_DEFS = {
  worker: {
    name: 'Worker', hp: 40, maxHp: 40, speed: 0.4, attack: 5, range: 0.3,
    cost: { minerals: 50, energy: 0 }, popCost: 1,
    gatherRate: 8, isBuilding: false,
  },
  soldier: {
    name: 'Soldier', hp: 80, maxHp: 80, speed: 0.55, attack: 15, range: 1.5,
    cost: { minerals: 80, energy: 20 }, popCost: 1,
    attackSpeed: 1.2, isBuilding: false,
  },
  base: {
    name: 'Command Base', hp: 300, maxHp: 300, isBuilding: true,
    attack: 0, range: 0,
  },
  outpost: {
    name: 'Outpost', hp: 150, maxHp: 150, isBuilding: true,
    cost: { minerals: 200, energy: 50 }, popCapBonus: 5,
    attack: 0, range: 0,
  },
  turret: {
    name: 'Defense Turret', hp: 120, maxHp: 120, isBuilding: true,
    cost: { minerals: 120, energy: 40 },
    attack: 20, range: 2.5, attackSpeed: 1.5,
  },
};

// ── Math Helpers ──
function vec3(x, y, z) { return { x, y, z }; }

function normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
}

function applyAxisAngle(v, axis, angle) {
  // Rodrigues' rotation
  const c = Math.cos(angle), s = Math.sin(angle);
  const d = dot(axis, v);
  const cr = cross(axis, v);
  return {
    x: v.x * c + cr.x * s + axis.x * d * (1 - c),
    y: v.y * c + cr.y * s + axis.y * d * (1 - c),
    z: v.z * c + cr.z * s + axis.z * d * (1 - c),
  };
}

function lerpVec(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

function randomSurfacePoint() {
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  return normalize({
    x: Math.sin(phi) * Math.cos(theta),
    y: Math.sin(phi) * Math.sin(theta),
    z: Math.cos(phi),
  });
}

// Simple noise for terrain height
function hash(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1274126177;
  h = ((h ^ (h >> 13)) * 1274126177) | 0;
  return (h & 0x7fffffff) / 0x7fffffff;
}

function smoothNoise(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  function h(a, b, c) { return hash(a & 0xff, b & 0xff, c & 0xff); }
  return (
    h(ix, iy, iz) * (1 - sx) * (1 - sy) * (1 - sz) +
    h(ix + 1, iy, iz) * sx * (1 - sy) * (1 - sz) +
    h(ix, iy + 1, iz) * (1 - sx) * sy * (1 - sz) +
    h(ix + 1, iy + 1, iz) * sx * sy * (1 - sz) +
    h(ix, iy, iz + 1) * (1 - sx) * (1 - sy) * sz +
    h(ix + 1, iy, iz + 1) * sx * (1 - sy) * sz +
    h(ix, iy + 1, iz + 1) * (1 - sx) * sy * sz +
    h(ix + 1, iy + 1, iz + 1) * sx * sy * sz
  ) * 2 - 1;
}

function fbmNoise(x, y, z) {
  return smoothNoise(x, y, z) * 0.5 + smoothNoise(x * 2, y * 2, z * 2) * 0.25 +
    smoothNoise(x * 4, y * 4, z * 4) * 0.125;
}

function getSurfaceHeight(normal) {
  const s = 2.5;
  let h = 0;
  h += fbmNoise(normal.x * s, normal.y * s, normal.z * s) * 0.3;
  h += fbmNoise(normal.x * s * 2 + 5, normal.y * s * 2 + 5, normal.z * s * 2 + 5) * 0.15;
  h += fbmNoise(normal.x * s * 4 + 10, normal.y * s * 4 + 10, normal.z * s * 4 + 10) * 0.07;
  return GLOBE_RADIUS + h;
}

// ── Game Room ──
class GameRoom {
  constructor() {
    this.players = {};       // { id: { ws, faction, minerals, energy, pop, popCap } }
    this.entities = [];      // All game entities
    this.projectiles = [];
    this.nextEntityId = 1;
    this.started = false;
    this.tickInterval = null;
    this.events = [];        // Events to broadcast this tick (explosions, notifications, etc.)
  }

  addPlayer(ws) {
    const playerIds = Object.keys(this.players);
    if (playerIds.length >= 2) {
      ws.send(JSON.stringify({ type: 'error', msg: 'Game is full' }));
      ws.close();
      return null;
    }

    const id = playerIds.length === 0 ? 'p1' : 'p2';
    const faction = id === 'p1' ? 1 : 2;

    this.players[id] = {
      ws,
      id,
      faction,
      minerals: 500,
      energy: 200,
      pop: 0,
      popCap: 10,
    };

    ws.send(JSON.stringify({
      type: 'assigned',
      playerId: id,
      faction,
    }));

    // Notify all players of roster
    this.broadcastLobby();

    if (Object.keys(this.players).length === 2 && !this.started) {
      this.startGame();
    }

    return id;
  }

  removePlayer(id) {
    delete this.players[id];
    this.broadcastLobby();
    if (this.started && Object.keys(this.players).length === 0) {
      this.stop();
    }
  }

  broadcastLobby() {
    const roster = Object.values(this.players).map(p => ({ id: p.id, faction: p.faction }));
    this.broadcast({ type: 'lobby', players: roster, started: this.started });
  }

  startGame() {
    this.started = true;
    this.initEntities();
    this.broadcast({ type: 'gameStart', terrain: this.getTerrainSeed() });
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.started = false;
  }

  getTerrainSeed() {
    // Clients use the same noise functions — just confirm they share logic
    return { globeRadius: GLOBE_RADIUS };
  }

  initEntities() {
    // Player 1 base (north-ish)
    const p1Start = normalize({ x: 0, y: 0.3, z: 1 });
    this.spawnEntity('base', p1Start, 1);
    for (let i = 0; i < 3; i++) {
      const offset = normalize(lerpVec(randomSurfacePoint(), p1Start, 0.92));
      this.spawnEntity('worker', offset, 1);
    }

    // Player 2 base (south-ish / opposite)
    const p2Start = normalize({ x: 0, y: -0.3, z: -1 });
    this.spawnEntity('base', p2Start, 2);
    for (let i = 0; i < 3; i++) {
      const offset = normalize(lerpVec(randomSurfacePoint(), p2Start, 0.92));
      this.spawnEntity('worker', offset, 2);
    }

    // Resource nodes
    const resTypes = ['minerals', 'energy'];
    for (let i = 0; i < 20; i++) {
      const pos = randomSurfacePoint();
      const resType = resTypes[i % 2];
      this.entities.push({
        id: this.nextEntityId++,
        type: 'resource',
        resourceType: resType,
        amount: resType === 'minerals' ? 500 : 300,
        maxAmount: resType === 'minerals' ? 500 : 300,
        pos,
        faction: 0,
        alive: true,
      });
    }
  }

  spawnEntity(type, pos, faction) {
    const def = UNIT_DEFS[type];
    const entity = {
      id: this.nextEntityId++,
      type,
      pos: normalize(pos),
      faction,
      hp: def.hp,
      maxHp: def.maxHp,
      attack: def.attack || 0,
      range: def.range || 0,
      speed: def.speed || 0,
      attackSpeed: def.attackSpeed || 1,
      attackCooldown: 0,
      gatherRate: def.gatherRate || 0,
      popCost: def.popCost || 0,
      isBuilding: def.isBuilding || false,
      target: null,
      attackTarget: null,
      gatherTarget: null,
      gathering: false,
      gatherCooldown: 0,
      alive: true,
      name: def.name,
    };

    this.entities.push(entity);

    // Update pop
    const player = Object.values(this.players).find(p => p.faction === faction);
    if (player && !def.isBuilding && def.popCost) {
      player.pop += def.popCost;
    }
    if (def.popCapBonus && player) {
      player.popCap += def.popCapBonus;
    }

    return entity;
  }

  handleCommand(playerId, cmd) {
    const player = this.players[playerId];
    if (!player) return;

    switch (cmd.action) {
      case 'move': {
        const units = cmd.unitIds.map(id => this.entities.find(e => e.id === id));
        const target = normalize(cmd.target);
        for (const u of units) {
          if (u && u.alive && u.faction === player.faction && !u.isBuilding) {
            u.target = target;
            u.attackTarget = null;
            u.gatherTarget = null;
            u.gathering = false;
          }
        }
        break;
      }

      case 'attack': {
        const units = cmd.unitIds.map(id => this.entities.find(e => e.id === id));
        const targetEntity = this.entities.find(e => e.id === cmd.targetId);
        if (!targetEntity || !targetEntity.alive) break;
        for (const u of units) {
          if (u && u.alive && u.faction === player.faction && !u.isBuilding) {
            u.attackTarget = cmd.targetId;
            u.target = { ...targetEntity.pos };
            u.gatherTarget = null;
            u.gathering = false;
          }
        }
        break;
      }

      case 'gather': {
        const units = cmd.unitIds.map(id => this.entities.find(e => e.id === id));
        const resource = this.entities.find(e => e.id === cmd.targetId && e.type === 'resource');
        if (!resource || !resource.alive) break;
        for (const u of units) {
          if (u && u.alive && u.type === 'worker' && u.faction === player.faction) {
            u.gatherTarget = cmd.targetId;
            u.target = { ...resource.pos };
            u.attackTarget = null;
          }
        }
        break;
      }

      case 'build_unit': {
        const unitType = cmd.unitType;
        const def = UNIT_DEFS[unitType];
        if (!def || def.isBuilding) break;
        if (player.minerals < (def.cost?.minerals || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Need more minerals!' });
          break;
        }
        if (player.energy < (def.cost?.energy || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Need more energy!' });
          break;
        }
        if (player.pop >= player.popCap) {
          this.sendTo(playerId, { type: 'notify', msg: 'Population cap reached!' });
          break;
        }
        player.minerals -= def.cost.minerals;
        player.energy -= def.cost.energy;
        const base = this.entities.find(e =>
          e.type === 'base' && e.faction === player.faction && e.alive
        );
        if (base) {
          const offset = normalize(lerpVec(randomSurfacePoint(), base.pos, 0.93));
          this.spawnEntity(unitType, offset, player.faction);
          this.sendTo(playerId, { type: 'notify', msg: `${def.name} deployed` });
        }
        break;
      }

      case 'build_structure': {
        const structType = cmd.structType;
        const def = UNIT_DEFS[structType];
        if (!def || !def.isBuilding) break;
        if (player.minerals < (def.cost?.minerals || 0) || player.energy < (def.cost?.energy || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Insufficient resources!' });
          break;
        }
        player.minerals -= def.cost.minerals;
        player.energy -= def.cost.energy;
        const pos = normalize(cmd.pos);
        this.spawnEntity(structType, pos, player.faction);
        this.sendTo(playerId, { type: 'notify', msg: `${def.name} constructed` });
        break;
      }
    }
  }

  tick() {
    const dt = TICK_MS / 1000;
    this.events = [];

    // Passive energy income
    for (const p of Object.values(this.players)) {
      p.energy += 1 * dt; // 1 per second
    }

    for (const e of this.entities) {
      if (!e.alive || e.type === 'resource') continue;

      // ── Movement ──
      if (e.target && !e.isBuilding && e.speed) {
        const current = normalize(e.pos);
        const target = normalize(e.target);
        const dist = angleBetween(current, target);

        if (dist > 0.015) {
          const ax = normalize(cross(current, target));
          if (ax.x === 0 && ax.y === 0 && ax.z === 0) continue;
          const step = Math.min(e.speed * dt * 0.1, dist);
          e.pos = normalize(applyAxisAngle(current, ax, step));
        } else {
          if (e.gatherTarget) {
            const res = this.entities.find(r => r.id === e.gatherTarget);
            if (res && res.alive && res.amount > 0) {
              e.gathering = true;
            }
          }
          if (!e.attackTarget) e.target = null;
        }
      }

      // ── Gathering ──
      if (e.gathering && e.gatherTarget && e.gatherRate) {
        e.gatherCooldown -= dt;
        if (e.gatherCooldown <= 0) {
          e.gatherCooldown = 1;
          const res = this.entities.find(r => r.id === e.gatherTarget);
          if (res && res.alive && res.amount > 0) {
            const amt = Math.min(e.gatherRate, res.amount);
            res.amount -= amt;
            const player = Object.values(this.players).find(p => p.faction === e.faction);
            if (player) {
              if (res.resourceType === 'minerals') player.minerals += amt;
              else player.energy += amt;
            }
            if (res.amount <= 0) {
              res.alive = false;
              e.gathering = false;
              e.gatherTarget = null;
            }
          } else {
            e.gathering = false;
            e.gatherTarget = null;
          }
        }
      }

      // ── Attack cooldown ──
      if (e.attackCooldown > 0) e.attackCooldown -= dt;

      // ── Auto-target ──
      if (e.attack && !e.attackTarget) {
        let nearest = null, nearestDist = Infinity;
        for (const o of this.entities) {
          if (!o.alive || o.faction === e.faction || o.faction === 0) continue;
          const d = angleBetween(e.pos, o.pos) * GLOBE_RADIUS;
          if (d < e.range && d < nearestDist) {
            nearest = o;
            nearestDist = d;
          }
        }
        if (nearest) e.attackTarget = nearest.id;
      }

      // ── Attack ──
      if (e.attackTarget && e.attack) {
        const target = this.entities.find(t => t.id === e.attackTarget);
        if (!target || !target.alive) {
          e.attackTarget = null;
          e.target = null;
          continue;
        }

        const dist = angleBetween(e.pos, target.pos) * GLOBE_RADIUS;
        if (dist <= e.range) {
          if (e.attackCooldown <= 0) {
            e.attackCooldown = e.attackSpeed || 1;
            target.hp -= e.attack;

            this.events.push({
              type: 'projectile',
              from: { ...e.pos },
              to: { ...target.pos },
              faction: e.faction,
            });

            if (target.hp <= 0) {
              this.destroyEntity(target);
              e.attackTarget = null;
              e.target = null;
            }
          }
        } else if (!e.isBuilding) {
          e.target = { ...target.pos };
        }
      }
    }

    // Broadcast state
    this.broadcastState();
  }

  destroyEntity(entity) {
    entity.alive = false;
    this.events.push({ type: 'explosion', pos: { ...entity.pos } });

    const player = Object.values(this.players).find(p => p.faction === entity.faction);
    if (player && !entity.isBuilding && entity.popCost) {
      player.pop -= entity.popCost;
    }

    if (entity.type === 'base') {
      const loser = entity.faction;
      const winner = loser === 1 ? 2 : 1;
      this.broadcast({
        type: 'gameOver',
        winner,
        loser,
      });
      setTimeout(() => this.stop(), 3000);
    }
  }

  broadcastState() {
    const entityStates = this.entities
      .filter(e => e.alive)
      .map(e => ({
        id: e.id,
        type: e.type,
        pos: e.pos,
        faction: e.faction,
        hp: e.hp,
        maxHp: e.maxHp,
        isBuilding: e.isBuilding,
        name: e.name,
        resourceType: e.resourceType,
        amount: e.amount,
        maxAmount: e.maxAmount,
        gathering: e.gathering,
        attack: e.attack,
        range: e.range,
        gatherRate: e.gatherRate,
      }));

    const playerStates = {};
    for (const [id, p] of Object.entries(this.players)) {
      playerStates[id] = {
        faction: p.faction,
        minerals: Math.floor(p.minerals),
        energy: Math.floor(p.energy),
        pop: p.pop,
        popCap: p.popCap,
      };
    }

    this.broadcast({
      type: 'state',
      entities: entityStates,
      players: playerStates,
      events: this.events,
    });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const p of Object.values(this.players)) {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(msg);
      }
    }
  }

  sendTo(playerId, data) {
    const p = this.players[playerId];
    if (p && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(data));
    }
  }
}

// ── Server State ──
let currentRoom = new GameRoom();

wss.on('connection', (ws) => {
  // If room is full or game ended, create new room
  if (Object.keys(currentRoom.players).length >= 2 && currentRoom.started) {
    currentRoom = new GameRoom();
  }

  const playerId = currentRoom.addPlayer(ws);
  if (!playerId) return;

  const room = currentRoom;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'command') {
        room.handleCommand(playerId, msg);
      }
    } catch (err) {
      console.error('Bad message:', err);
    }
  });

  ws.on('close', () => {
    room.removePlayer(playerId);
    room.broadcast({ type: 'playerLeft', playerId });
  });
});

server.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════════════╗`);
  console.log(`  ║   HEGEMONY — Globe RTS Server            ║`);
  console.log(`  ║   Running on http://localhost:${PORT}        ║`);
  console.log(`  ║                                          ║`);
  console.log(`  ║   Share your IP:${PORT} with your friend    ║`);
  console.log(`  ║   Both open the URL in a browser.        ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
