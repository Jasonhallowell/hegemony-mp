// ═══════════════════════════════════════════════════════════════
// HEGEMONY — Globe RTS — Multiplayer Server
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
const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;

// ── Age System ──
const AGE_NAMES = ['Stone Age', 'Industrial Age', 'Modern Age', 'Space Age'];
const BUILD_TIMES = { outpost: 12, turret: 8, dock: 15, silo: 20 };
const AGE_ADVANCE_COST = [
  null,
  { minerals: 600,  energy: 300  },
  { minerals: 1200, energy: 600  },
  { minerals: 2500, energy: 1200 },
];

// ── Unit / Building Definitions ──
const UNIT_DEFS = {

  // ── Stone Age (0) ──
  worker: {
    name: 'Worker', hp: 40, maxHp: 40, speed: 0.4, attack: 5, range: 0.3,
    cost: { minerals: 50, energy: 0 }, popCost: 1,
    gatherRate: 8, isBuilding: false, minAge: 0,
  },
  soldier: {
    name: 'Soldier', hp: 80, maxHp: 80, speed: 0.55, attack: 15, range: 1.5,
    cost: { minerals: 80, energy: 20 }, popCost: 1,
    attackSpeed: 1.2, isBuilding: false, minAge: 0,
  },
  base: {
    name: 'Command Base', hp: 500, maxHp: 500, isBuilding: true,
    attack: 0, range: 0, minAge: 0,
  },
  outpost: {
    name: 'Outpost', hp: 150, maxHp: 150, isBuilding: true,
    cost: { minerals: 200, energy: 50 }, popCapBonus: 5,
    attack: 0, range: 0, minAge: 0,
  },
  turret: {
    name: 'Defense Turret', hp: 120, maxHp: 120, isBuilding: true,
    cost: { minerals: 120, energy: 40 },
    attack: 20, range: 2.5, attackSpeed: 1.5, minAge: 0,
  },

  // ── Industrial Age (1) ──
  tank: {
    name: 'Tank', hp: 200, maxHp: 200, speed: 0.35, attack: 35, range: 2.0,
    cost: { minerals: 150, energy: 60 }, popCost: 2,
    attackSpeed: 2.0, isBuilding: false, minAge: 1,
  },
  dock: {
    name: 'Dock', hp: 180, maxHp: 180, isBuilding: true,
    cost: { minerals: 250, energy: 80 },
    attack: 0, range: 0, minAge: 1, isNaval: true,
  },
  boat: {
    name: 'Warship', hp: 160, maxHp: 160, speed: 0.45, attack: 28, range: 2.8,
    cost: { minerals: 130, energy: 60 }, popCost: 2,
    attackSpeed: 1.8, isBuilding: false, minAge: 1, spawnFromDock: true, isNaval: true,
  },

  // ── Modern Age (2) ──
  airplane: {
    name: 'Fighter Jet', hp: 100, maxHp: 100, speed: 1.2, attack: 40, range: 3.0,
    cost: { minerals: 200, energy: 120 }, popCost: 2,
    attackSpeed: 1.5, isBuilding: false, minAge: 2, isAir: true,
  },
  silo: {
    name: 'Missile Silo', hp: 200, maxHp: 200, isBuilding: true,
    cost: { minerals: 400, energy: 200 },
    attack: 80, range: 7.0, attackSpeed: 10.0, minAge: 2,
  },

  // ── Space Age (3) ──
  rocket: {
    name: 'Orbital Rocket', hp: 120, maxHp: 120, speed: 1.5, attack: 150, range: 8.0,
    cost: { minerals: 500, energy: 300 }, popCost: 2,
    attackSpeed: 3.0, isBuilding: false, minAge: 3, isAir: true,
  },
  nuke: {
    name: 'Nuclear ICBM', hp: 60, maxHp: 60, speed: 2.0, attack: 400,
    cost: { minerals: 800, energy: 500 }, popCost: 3,
    isBuilding: false, minAge: 3, isAir: true,
    isNuke: true, nukeRadius: 2.5,
  },
};

// ── Math Helpers ──
function normalize(v) {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len === 0) return { x: 0, y: 1, z: 0 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function angleBetween(a, b) {
  return Math.acos(Math.max(-1, Math.min(1, dot(normalize(a), normalize(b)))));
}
function applyAxisAngle(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), d = dot(axis, v), cr = cross(axis, v);
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
  return normalize({ x: Math.sin(phi) * Math.cos(theta), y: Math.sin(phi) * Math.sin(theta), z: Math.cos(phi) });
}
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
    h(ix,iy,iz)*(1-sx)*(1-sy)*(1-sz) + h(ix+1,iy,iz)*sx*(1-sy)*(1-sz) +
    h(ix,iy+1,iz)*(1-sx)*sy*(1-sz) + h(ix+1,iy+1,iz)*sx*sy*(1-sz) +
    h(ix,iy,iz+1)*(1-sx)*(1-sy)*sz + h(ix+1,iy,iz+1)*sx*(1-sy)*sz +
    h(ix,iy+1,iz+1)*(1-sx)*sy*sz + h(ix+1,iy+1,iz+1)*sx*sy*sz
  ) * 2 - 1;
}
function fbmNoise(x, y, z) {
  return smoothNoise(x,y,z)*0.5 + smoothNoise(x*2,y*2,z*2)*0.25 + smoothNoise(x*4,y*4,z*4)*0.125;
}
function getSurfaceHeight(n) {
  const s = 2.5;
  let h = fbmNoise(n.x*s, n.y*s, n.z*s)*0.3 +
          fbmNoise(n.x*s*2+5, n.y*s*2+5, n.z*s*2+5)*0.15 +
          fbmNoise(n.x*s*4+10, n.y*s*4+10, n.z*s*4+10)*0.07;
  return GLOBE_RADIUS + h;
}
function getTerrainH(pos) {
  const n = normalize(pos);
  const s = 2.5;
  return fbmNoise(n.x*s, n.y*s, n.z*s)*0.3 +
         fbmNoise(n.x*s*2+5, n.y*s*2+5, n.z*s*2+5)*0.15 +
         fbmNoise(n.x*s*4+10, n.y*s*4+10, n.z*s*4+10)*0.07;
}
function isWater(pos)  { return getTerrainH(pos) < -0.02; }
function canTraverse(pos, entity) {
  if (entity.isAir) return true;
  if (entity.isNaval) return isWater(pos);
  return !isWater(pos);
}
// Find a valid spawn point near anchorPos matching terrain type
function findValidSpawn(anchorPos, isNaval, isAir) {
  if (isAir) return normalize(lerpVec(randomSurfacePoint(), anchorPos, 0.88 + Math.random() * 0.07));
  for (let i = 0; i < 120; i++) {
    const blend = 0.75 + Math.random() * 0.20;
    const candidate = normalize(lerpVec(randomSurfacePoint(), anchorPos, blend));
    if (isNaval ? isWater(candidate) : !isWater(candidate)) return candidate;
  }
  return normalize(anchorPos);
}
// Compute forward + right tangent vectors at current toward target
function getSteerVectors(current, target) {
  const d = dot(target, current);
  const fwd = normalize({
    x: target.x - d * current.x,
    y: target.y - d * current.y,
    z: target.z - d * current.z,
  });
  const right = normalize(cross(current, fwd));
  return { fwd, right };
}

// Try to take a step of `step` radians steered toward `side` (+1/-1) away from direct.
// Tries angles 10°, 20°, … 170° on that side. Returns new pos if traversable, else null.
function steerStep(current, target, entity, side, step) {
  const { fwd, right } = getSteerVectors(current, target);
  if (fwd.x === 0 && fwd.y === 0 && fwd.z === 0) return null;
  for (let i = 1; i <= 17; i++) {
    const theta = i * (Math.PI / 18) * side;
    const sd = {
      x: fwd.x * Math.cos(theta) + right.x * Math.sin(theta),
      y: fwd.y * Math.cos(theta) + right.y * Math.sin(theta),
      z: fwd.z * Math.cos(theta) + right.z * Math.sin(theta),
    };
    const ax = normalize(cross(current, sd));
    if (ax.x === 0 && ax.y === 0 && ax.z === 0) continue;
    const candidate = normalize(applyAxisAngle(current, ax, step));
    if (canTraverse(candidate, entity)) return candidate;
  }
  return null;
}

// Find a valid land starting position near an approximate location
function findStartBase(approxPos) {
  const n = normalize(approxPos);
  for (let i = 0; i < 200; i++) {
    const blend = i < 100 ? (0.88 + Math.random() * 0.10) : (0.60 + Math.random() * 0.35);
    const candidate = normalize(lerpVec(randomSurfacePoint(), n, blend));
    if (!isWater(candidate)) return candidate;
  }
  return n;
}

// ── Game Room ──
class GameRoom {
  constructor() {
    this.players = {};
    this.entities = [];
    this.nextEntityId = 1;
    this.started = false;
    this.tickInterval = null;
    this.events = [];
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
      ws, id, faction,
      minerals: 500, energy: 200,
      pop: 0, popCap: 10,
      age: 0,
    };
    ws.send(JSON.stringify({ type: 'assigned', playerId: id, faction }));
    this.broadcastLobby();
    if (Object.keys(this.players).length === 2 && !this.started) this.startGame();
    return id;
  }

  removePlayer(id) {
    delete this.players[id];
    this.broadcastLobby();
    if (this.started && Object.keys(this.players).length === 0) this.stop();
  }

  broadcastLobby() {
    const roster = Object.values(this.players).map(p => ({ id: p.id, faction: p.faction }));
    this.broadcast({ type: 'lobby', players: roster, started: this.started });
  }

  startGame() {
    this.started = true;
    this.initEntities();
    this.broadcast({ type: 'gameStart', terrain: { globeRadius: GLOBE_RADIUS } });
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.started = false;
  }

  initEntities() {
    const p1Start = findStartBase({ x: 0, y: 0.3, z: 1 });
    this.spawnEntity('base', p1Start, 1);
    for (let i = 0; i < 3; i++)
      this.spawnEntity('worker', findValidSpawn(p1Start, false, false), 1);

    const p2Start = findStartBase({ x: 0, y: -0.3, z: -1 });
    this.spawnEntity('base', p2Start, 2);
    for (let i = 0; i < 3; i++)
      this.spawnEntity('worker', findValidSpawn(p2Start, false, false), 2);

    // Resource nodes — more variety
    for (let i = 0; i < 28; i++) {
      const pos = randomSurfacePoint();
      const resType = i % 2 === 0 ? 'minerals' : 'energy';
      this.entities.push({
        id: this.nextEntityId++, type: 'resource', resourceType: resType,
        amount: resType === 'minerals' ? 700 : 450,
        maxAmount: resType === 'minerals' ? 700 : 450,
        pos, faction: 0, alive: true,
      });
    }
  }

  spawnEntity(type, pos, faction) {
    const def = UNIT_DEFS[type];
    const entity = {
      id: this.nextEntityId++, type,
      pos: normalize(pos), faction,
      hp: def.hp, maxHp: def.maxHp,
      attack: def.attack || 0,
      range: def.range || 0,
      speed: def.speed || 0,
      attackSpeed: def.attackSpeed || 1,
      attackCooldown: 0,
      gatherRate: def.gatherRate || 0,
      popCost: def.popCost || 0,
      isBuilding: def.isBuilding || false,
      isAir: def.isAir || false,
      isNaval: def.isNaval || false,
      isNuke: def.isNuke || false,
      nukeRadius: def.nukeRadius || 0,
      target: null, attackTarget: null, gatherTarget: null,
      gathering: false, gatherCooldown: 0, constructTarget: null,
      wallFollowing: false, wallSide: 0,
      alive: true, name: def.name,
    };
    this.entities.push(entity);
    const player = Object.values(this.players).find(p => p.faction === faction);
    if (player && !def.isBuilding && def.popCost) player.pop += def.popCost;
    if (def.popCapBonus && player) player.popCap += def.popCapBonus;
    return entity;
  }

  handleCommand(playerId, cmd) {
    const player = this.players[playerId];
    if (!player) return;

    switch (cmd.action) {
      case 'move': {
        const target = normalize(cmd.target);
        for (const uid of cmd.unitIds) {
          const u = this.entities.find(e => e.id === uid);
          if (u && u.alive && u.faction === player.faction && !u.isBuilding) {
            if (!canTraverse(target, u)) {
              this.sendTo(playerId, { type: 'notify', msg: u.isNaval ? 'Warships can only move on water!' : 'Land units cannot enter water!' });
              continue;
            }
            u.target = target;
            u.attackTarget = null;
            u.gatherTarget = null;
            u.gathering = false;
            u.constructTarget = null;
            u.wallFollowing = false; u.wallSide = 0;
          }
        }
        break;
      }

      case 'attack': {
        const targetEntity = this.entities.find(e => e.id === cmd.targetId);
        if (!targetEntity || !targetEntity.alive) break;
        for (const uid of cmd.unitIds) {
          const u = this.entities.find(e => e.id === uid);
          if (u && u.alive && u.faction === player.faction && !u.isBuilding) {
            u.attackTarget = cmd.targetId;
            u.target = { ...targetEntity.pos };
            u.gatherTarget = null;
            u.gathering = false;
            u.wallFollowing = false; u.wallSide = 0;
          }
        }
        break;
      }

      case 'gather': {
        const resource = this.entities.find(e => e.id === cmd.targetId && e.type === 'resource');
        if (!resource || !resource.alive) break;
        for (const uid of cmd.unitIds) {
          const u = this.entities.find(e => e.id === uid);
          if (u && u.alive && u.type === 'worker' && u.faction === player.faction) {
            u.gatherTarget = cmd.targetId;
            u.target = { ...resource.pos };
            u.attackTarget = null;
            u.wallFollowing = false; u.wallSide = 0;
          }
        }
        break;
      }

      case 'build_unit': {
        const def = UNIT_DEFS[cmd.unitType];
        if (!def || def.isBuilding) break;
        if ((def.minAge || 0) > player.age) {
          this.sendTo(playerId, { type: 'notify', msg: `Requires ${AGE_NAMES[def.minAge]}!` }); break;
        }
        if (player.minerals < (def.cost?.minerals || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Need more minerals!' }); break;
        }
        if (player.energy < (def.cost?.energy || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Need more energy!' }); break;
        }
        if (player.pop >= player.popCap) {
          this.sendTo(playerId, { type: 'notify', msg: 'Population cap reached!' }); break;
        }

        let spawnAnchor = null;
        if (def.spawnFromDock) {
          spawnAnchor = this.entities.find(e => e.type === 'dock' && e.faction === player.faction && e.alive);
          if (!spawnAnchor) {
            this.sendTo(playerId, { type: 'notify', msg: 'Build a Dock first!' }); break;
          }
        } else {
          spawnAnchor = this.entities.find(e => e.type === 'base' && e.faction === player.faction && e.alive);
        }
        if (!spawnAnchor) break;

        player.minerals -= def.cost.minerals || 0;
        player.energy  -= def.cost.energy  || 0;
        const offset = findValidSpawn(spawnAnchor.pos, def.isNaval || false, def.isAir || false);
        this.spawnEntity(cmd.unitType, offset, player.faction);
        this.sendTo(playerId, { type: 'notify', msg: `${def.name} deployed` });
        break;
      }

      case 'build_structure': {
        const def = UNIT_DEFS[cmd.structType];
        if (!def || !def.isBuilding) break;
        if ((def.minAge || 0) > player.age) {
          this.sendTo(playerId, { type: 'notify', msg: `Requires ${AGE_NAMES[def.minAge]}!` }); break;
        }
        if (player.minerals < (def.cost?.minerals || 0) || player.energy < (def.cost?.energy || 0)) {
          this.sendTo(playerId, { type: 'notify', msg: 'Insufficient resources!' }); break;
        }
        // Validate workers
        const workerIds = (cmd.workerIds || []).filter(wid => {
          const w = this.entities.find(e => e.id === wid && e.type === 'worker' && e.faction === player.faction && e.alive);
          return !!w;
        });
        if (workerIds.length === 0) {
          this.sendTo(playerId, { type: 'notify', msg: 'Select a Worker to build!' }); break;
        }
        player.minerals -= def.cost.minerals || 0;
        player.energy   -= def.cost.energy   || 0;
        const buildPos = normalize(cmd.pos);
        const site = {
          id: this.nextEntityId++, type: 'site',
          buildType: cmd.structType, buildProgress: 0,
          buildTime: BUILD_TIMES[cmd.structType] || 12,
          pos: buildPos, faction: player.faction,
          hp: def.hp, maxHp: def.hp,
          attack: 0, range: 0, speed: 0,
          isBuilding: true, isAir: false, isNaval: false, isNuke: false, nukeRadius: 0,
          popCost: 0, alive: true, name: `${def.name} (constructing)`,
        };
        this.entities.push(site);
        for (const wid of workerIds) {
          const w = this.entities.find(e => e.id === wid);
          if (w) {
            w.constructTarget = site.id;
            w.target = { ...buildPos };
            w.gatherTarget = null; w.attackTarget = null; w.gathering = false;
          }
        }
        this.sendTo(playerId, { type: 'notify', msg: `${def.name} construction started` });
        break;
      }

      case 'advance_age': {
        if (player.age >= AGE_NAMES.length - 1) {
          this.sendTo(playerId, { type: 'notify', msg: 'Already at maximum age!' }); break;
        }
        const nextAge = player.age + 1;
        const cost = AGE_ADVANCE_COST[nextAge];
        if (player.minerals < cost.minerals || player.energy < cost.energy) {
          this.sendTo(playerId, { type: 'notify', msg: `Need ${cost.minerals}M + ${cost.energy}E to advance!` }); break;
        }
        player.minerals -= cost.minerals;
        player.energy  -= cost.energy;
        player.age      = nextAge;
        player.popCap  += 5;
        this.sendTo(playerId, { type: 'notify', msg: `⚡ Advanced to ${AGE_NAMES[nextAge]}!` });
        break;
      }
    }
  }

  nukeDetonation(nuke) {
    if (!nuke.alive) return;
    const pos = nuke.pos;
    for (const e of this.entities) {
      if (!e.alive || e.id === nuke.id) continue;
      const dist = angleBetween(pos, e.pos) * GLOBE_RADIUS;
      if (dist <= nuke.nukeRadius) {
        const falloff = Math.max(0, 1 - dist / nuke.nukeRadius * 0.6);
        e.hp -= nuke.attack * falloff;
        if (e.hp <= 0) this.destroyEntity(e);
      }
    }
    this.events.push({ type: 'nuke_explosion', pos: { ...pos } });
    this.destroyEntity(nuke);
  }

  tick() {
    const dt = TICK_MS / 1000;
    this.events = [];

    // Passive income (scales with age)
    for (const p of Object.values(this.players)) {
      p.energy   += (1 + p.age * 0.5) * dt;
      p.minerals += p.age * 0.2 * dt;
    }

    for (const e of this.entities) {
      if (!e.alive || e.type === 'resource') continue;

      // ── Movement ──
      if (e.target && !e.isBuilding && e.speed) {
        const current = normalize(e.pos);
        const target  = normalize(e.target);
        const dist = angleBetween(current, target);

        if (dist > 0.015) {
          const ax = normalize(cross(current, target));
          if (ax.x === 0 && ax.y === 0 && ax.z === 0) continue;
          const step = Math.min(e.speed * dt * 0.1, dist);
          const newPos = normalize(applyAxisAngle(current, ax, step));
          if (canTraverse(newPos, e)) {
            // Direct path clear — go straight, reset wall-following
            e.pos = newPos;
            e.wallFollowing = false;
            e.wallSide = 0;
          } else {
            // Blocked — wall-follow on a committed side
            if (!e.wallFollowing) {
              // First contact: choose whichever side works first
              for (const side of [1, -1]) {
                const c = steerStep(current, target, e, side, step);
                if (c) { e.pos = c; e.wallFollowing = true; e.wallSide = side; break; }
              }
            } else {
              // Already wall-following: stay on committed side
              const c = steerStep(current, target, e, e.wallSide, step);
              if (c) {
                e.pos = c;
              } else {
                // Committed side is also stuck — flip and try other side
                const alt = steerStep(current, target, e, -e.wallSide, step);
                if (alt) { e.pos = alt; e.wallSide = -e.wallSide; }
                // else: completely surrounded, stay put and keep trying
              }
            }
          }
        } else {
          // Arrived
          if (e.isNuke) { this.nukeDetonation(e); continue; }
          if (e.gatherTarget) {
            const res = this.entities.find(r => r.id === e.gatherTarget);
            if (res && res.alive && res.amount > 0) e.gathering = true;
          }
          if (!e.attackTarget) e.target = null;
        }
      }

      if (!e.alive) continue;

      // ── Gathering ──
      if (e.gathering && e.gatherTarget && e.gatherRate) {
        e.gatherCooldown -= dt;
        if (e.gatherCooldown <= 0) {
          e.gatherCooldown = 1;
          const res = this.entities.find(r => r.id === e.gatherTarget);
          if (res && res.alive && res.amount > 0) {
            const amt = Math.min(e.gatherRate, res.amount);
            res.amount -= amt;
            const pl = Object.values(this.players).find(p => p.faction === e.faction);
            if (pl) {
              if (res.resourceType === 'minerals') pl.minerals += amt;
              else pl.energy += amt;
            }
            if (res.amount <= 0) { res.alive = false; e.gathering = false; e.gatherTarget = null; }
          } else { e.gathering = false; e.gatherTarget = null; }
        }
      }

      // ── Construction ──
      if (e.constructTarget != null && e.type === 'worker') {
        const site = this.entities.find(s => s.id === e.constructTarget && s.type === 'site' && s.alive);
        if (!site) {
          e.constructTarget = null;
        } else {
          const dist = angleBetween(e.pos, site.pos) * GLOBE_RADIUS;
          if (dist < 0.35) {
            e.target = null; // stop moving, start building
            site.buildProgress = (site.buildProgress || 0) + dt;
            if (site.buildProgress >= site.buildTime) {
              this.spawnEntity(site.buildType, site.pos, site.faction);
              site.alive = false;
              const siteId = site.id;
              for (const w of this.entities) {
                if (w.constructTarget === siteId) w.constructTarget = null;
              }
              this.events.push({ type: 'build_complete', pos: { ...site.pos } });
            }
          } else {
            e.target = { ...site.pos }; // keep walking toward site
          }
        }
      }

      // ── Cooldown ──
      if (e.attackCooldown > 0) e.attackCooldown -= dt;

      // ── Auto-target ──
      if (e.attack && !e.attackTarget) {
        let nearest = null, nearestDist = Infinity;
        for (const o of this.entities) {
          if (!o.alive || o.faction === e.faction || o.faction === 0) continue;
          const d = angleBetween(e.pos, o.pos) * GLOBE_RADIUS;
          if (d < e.range && d < nearestDist) { nearest = o; nearestDist = d; }
        }
        if (nearest) e.attackTarget = nearest.id;
      }

      // ── Attack ──
      if (e.attackTarget && e.attack) {
        const tgt = this.entities.find(t => t.id === e.attackTarget);
        if (!tgt || !tgt.alive) { e.attackTarget = null; e.target = null; continue; }

        const dist = angleBetween(e.pos, tgt.pos) * GLOBE_RADIUS;
        if (dist <= e.range) {
          if (e.attackCooldown <= 0) {
            e.attackCooldown = e.attackSpeed || 1;
            if (e.isNuke) { this.nukeDetonation(e); continue; }
            tgt.hp -= e.attack;
            this.events.push({ type: 'projectile', from: { ...e.pos }, to: { ...tgt.pos }, faction: e.faction, unitType: e.type });
            if (tgt.hp <= 0) { this.destroyEntity(tgt); e.attackTarget = null; e.target = null; }
          }
        } else if (!e.isBuilding) {
          // Only reset wall-following if the target has moved significantly
          const prevTarget = e.target;
          const newTarget = { ...tgt.pos };
          if (!prevTarget || angleBetween(normalize(prevTarget), normalize(newTarget)) > 0.05) {
            e.wallFollowing = false; e.wallSide = 0;
          }
          e.target = newTarget;
        }
      }
    }

    // Prune dead non-resource entities
    this.entities = this.entities.filter(e => e.alive || e.type === 'resource');

    this.broadcastState();
  }

  destroyEntity(entity) {
    entity.alive = false;
    this.events.push({ type: 'explosion', pos: { ...entity.pos } });
    const player = Object.values(this.players).find(p => p.faction === entity.faction);
    if (player && !entity.isBuilding && entity.popCost) player.pop -= entity.popCost;
    if (entity.type === 'base') {
      const winner = entity.faction === 1 ? 2 : 1;
      this.broadcast({ type: 'gameOver', winner, loser: entity.faction });
      setTimeout(() => this.stop(), 3000);
    }
    if (entity.type === 'site') {
      for (const w of this.entities) {
        if (w.constructTarget === entity.id) w.constructTarget = null;
      }
    }
  }

  broadcastState() {
    const entityStates = this.entities
      .filter(e => e.alive)
      .map(e => ({
        id: e.id, type: e.type, pos: e.pos, faction: e.faction,
        hp: e.hp, maxHp: e.maxHp,
        isBuilding: e.isBuilding, isAir: e.isAir, isNaval: e.isNaval,
        name: e.name,
        resourceType: e.resourceType, amount: e.amount, maxAmount: e.maxAmount,
        gathering: e.gathering, attack: e.attack, range: e.range, gatherRate: e.gatherRate,
        buildType: e.buildType, buildProgress: e.buildProgress, buildTime: e.buildTime,
      }));

    const playerStates = {};
    for (const [id, p] of Object.entries(this.players)) {
      playerStates[id] = {
        faction: p.faction,
        minerals: Math.floor(p.minerals),
        energy: Math.floor(p.energy),
        pop: p.pop, popCap: p.popCap,
        age: p.age,
      };
    }

    this.broadcast({ type: 'state', entities: entityStates, players: playerStates, events: this.events });
  }

  broadcast(data) {
    const msg = JSON.stringify(data);
    for (const p of Object.values(this.players))
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }

  sendTo(playerId, data) {
    const p = this.players[playerId];
    if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(data));
  }
}

// ── Server ──
let currentRoom = new GameRoom();

wss.on('connection', (ws) => {
  if (Object.keys(currentRoom.players).length >= 2 && currentRoom.started)
    currentRoom = new GameRoom();

  const playerId = currentRoom.addPlayer(ws);
  if (!playerId) return;
  const room = currentRoom;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'command') room.handleCommand(playerId, msg);
    } catch (err) { console.error('Bad message:', err); }
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
  console.log(`  ║   4 Ages · Nukes · Jets · Warships        ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
