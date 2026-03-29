// ═══════════════════════════════════════════════════════════════
// HEGEMONY — Globe RTS — Multiplayer Server (Voxel Edition)
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
const VOXEL_SIZE = 0.012;
const WATER_H = -0.10;
const GRID_HALF = Math.ceil((GLOBE_RADIUS + 0.5) / VOXEL_SIZE); // 459

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

// ── Noise Functions (MUST match client exactly) ──
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

// ═══════════════════════════════════════════════════════════════
// VOXEL GLOBE GENERATION
// ═══════════════════════════════════════════════════════════════

function generateVoxelGlobe() {
  const VS = VOXEL_SIZE;
  const SHELL_DEPTH = 5; // only 5 voxels deep
  const voxels = new Map();    // key "ix,iy,iz" -> type (1=land, 2=water)
  const landSurface = new Set();
  const waterSurface = new Set();

  // Only iterate the thin shell around the globe surface (not the full cube)
  const minR = GLOBE_RADIUS - 1.0;  // well below lowest terrain
  const maxR = GLOBE_RADIUS + 1.0;  // well above highest terrain
  const iMin = Math.floor(minR / VS);
  const iMax = Math.ceil(maxR / VS);

  for (let ix = -iMax; ix <= iMax; ix++) {
    for (let iy = -iMax; iy <= iMax; iy++) {
      for (let iz = -iMax; iz <= iMax; iz++) {
        const cx = ix * VS, cy = iy * VS, cz = iz * VS;
        const d2 = cx * cx + cy * cy + cz * cz;
        // Quick bounding sphere check to skip most cells
        if (d2 < minR * minR || d2 > maxR * maxR) continue;
        const d = Math.sqrt(d2);
        if (d < 0.001) continue;

        const dir = normalize({ x: cx, y: cy, z: cz });
        const h = getTerrainH(dir);
        const landR = GLOBE_RADIUS + h;
        const seaR = GLOBE_RADIUS + WATER_H;

        if (d <= landR && d > landR - VS * SHELL_DEPTH) {
          voxels.set(`${ix},${iy},${iz}`, 1); // land
        } else if (d > landR && h < WATER_H && d <= seaR) {
          voxels.set(`${ix},${iy},${iz}`, 2); // water
        }
      }
    }
  }

  // Build surface caches
  buildSurfaceCaches(voxels, landSurface, waterSurface);

  console.log(`  Voxels generated: ${voxels.size} total, ${landSurface.size} land surface, ${waterSurface.size} water surface`);

  return { voxels, landSurface, waterSurface };
}

// 6 face neighbors for surface detection
const FACE_DIRS = [
  [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]
];

function buildSurfaceCaches(voxels, landSurface, waterSurface) {
  landSurface.clear();
  waterSurface.clear();

  for (const [key, type] of voxels) {
    const [ix, iy, iz] = key.split(',').map(Number);
    let exposed = false;
    for (const [dx, dy, dz] of FACE_DIRS) {
      const nk = `${ix+dx},${iy+dy},${iz+dz}`;
      if (!voxels.has(nk)) { exposed = true; break; }
    }
    if (exposed) {
      if (type === 1) landSurface.add(key);
      else if (type === 2) waterSurface.add(key);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// A* PATHFINDING ON VOXEL SURFACE
// ═══════════════════════════════════════════════════════════════

class MinHeap {
  constructor() { this.data = []; }

  push(item) {
    this.data.push(item);
    this._bubbleUp(this.data.length - 1);
  }

  pop() {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0) {
      this.data[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  get size() { return this.data.length; }

  _bubbleUp(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].f < this.data[parent].f) {
        [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
        i = parent;
      } else break;
    }
  }

  _sinkDown(i) {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l].f < this.data[smallest].f) smallest = l;
      if (r < n && this.data[r].f < this.data[smallest].f) smallest = r;
      if (smallest !== i) {
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      } else break;
    }
  }
}

// Precompute 26-neighbor offsets and their costs
const NEIGHBOR_OFFSETS = [];
for (let dx = -1; dx <= 1; dx++) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (dx === 0 && dy === 0 && dz === 0) continue;
      const cost = Math.sqrt(dx*dx + dy*dy + dz*dz);
      NEIGHBOR_OFFSETS.push({ dx, dy, dz, cost });
    }
  }
}

const MAX_ITERATIONS = 500000;

function normalToCell(n, surfaceSet) {
  // Convert normalized direction to nearest surface cell
  const dir = normalize(n);
  const h = getTerrainH(dir);

  // Determine expected radius based on surface type
  let expectedR;
  if (surfaceSet === null) {
    // For generic lookup, try land radius
    expectedR = GLOBE_RADIUS + h;
  } else {
    expectedR = GLOBE_RADIUS + h;
    // For water surface, use sea level radius
    // We check by looking for the closest cell regardless
  }

  // Compute expected world position
  const wx = dir.x * expectedR;
  const wy = dir.y * expectedR;
  const wz = dir.z * expectedR;

  // Round to grid
  const ix = Math.round(wx / VOXEL_SIZE);
  const iy = Math.round(wy / VOXEL_SIZE);
  const iz = Math.round(wz / VOXEL_SIZE);

  // Check exact cell first
  const exactKey = `${ix},${iy},${iz}`;
  if (surfaceSet.has(exactKey)) return { ix, iy, iz };

  // Search nearby (within 3 cells)
  let bestKey = null, bestDist = Infinity;
  for (let ddx = -3; ddx <= 3; ddx++) {
    for (let ddy = -3; ddy <= 3; ddy++) {
      for (let ddz = -3; ddz <= 3; ddz++) {
        const nx = ix + ddx, ny = iy + ddy, nz = iz + ddz;
        const key = `${nx},${ny},${nz}`;
        if (surfaceSet.has(key)) {
          const dist = ddx*ddx + ddy*ddy + ddz*ddz;
          if (dist < bestDist) { bestDist = dist; bestKey = key; }
        }
      }
    }
  }

  if (bestKey) {
    const [bx, by, bz] = bestKey.split(',').map(Number);
    return { ix: bx, iy: by, iz: bz };
  }

  return null; // nothing within 3 cells
}

function cellToNormal(ix, iy, iz) {
  return normalize({ x: ix * VOXEL_SIZE, y: iy * VOXEL_SIZE, z: iz * VOXEL_SIZE });
}

function findPath(startNormal, targetNormal, voxels, surfaceSet) {
  const startCell = normalToCell(startNormal, surfaceSet);
  const endCell = normalToCell(targetNormal, surfaceSet);

  if (!startCell || !endCell) return null;

  // Same cell: already there
  if (startCell.ix === endCell.ix && startCell.iy === endCell.iy && startCell.iz === endCell.iz) {
    return [cellToNormal(endCell.ix, endCell.iy, endCell.iz)];
  }

  const startKey = `${startCell.ix},${startCell.iy},${startCell.iz}`;
  const endKey = `${endCell.ix},${endCell.iy},${endCell.iz}`;

  const gScore = new Map();
  const cameFrom = new Map();
  const closed = new Set();

  gScore.set(startKey, 0);

  const heuristic = (ix, iy, iz) => {
    const dx = ix - endCell.ix, dy = iy - endCell.iy, dz = iz - endCell.iz;
    return Math.sqrt(dx*dx + dy*dy + dz*dz);
  };

  const open = new MinHeap();
  open.push({ key: startKey, ix: startCell.ix, iy: startCell.iy, iz: startCell.iz, f: heuristic(startCell.ix, startCell.iy, startCell.iz) });

  let iterations = 0;
  while (open.size > 0 && iterations < MAX_ITERATIONS) {
    iterations++;
    const current = open.pop();

    if (current.key === endKey) {
      // Reconstruct path
      const pathKeys = [];
      let k = endKey;
      while (k) {
        pathKeys.push(k);
        k = cameFrom.get(k) || null;
      }
      pathKeys.reverse();

      // Convert to normalized positions, skip every few for smoother paths
      const waypoints = [];
      const step = Math.max(1, Math.floor(pathKeys.length / 50)); // limit waypoint count
      for (let i = step; i < pathKeys.length; i += step) {
        const [px, py, pz] = pathKeys[i].split(',').map(Number);
        waypoints.push(cellToNormal(px, py, pz));
      }
      // Always include final destination
      const [fx, fy, fz] = pathKeys[pathKeys.length - 1].split(',').map(Number);
      const finalNorm = cellToNormal(fx, fy, fz);
      if (waypoints.length === 0 || waypoints[waypoints.length - 1] !== finalNorm) {
        waypoints.push(finalNorm);
      }
      return waypoints;
    }

    if (closed.has(current.key)) continue;
    closed.add(current.key);

    const cg = gScore.get(current.key);

    for (const { dx, dy, dz, cost } of NEIGHBOR_OFFSETS) {
      const nx = current.ix + dx, ny = current.iy + dy, nz = current.iz + dz;
      const nk = `${nx},${ny},${nz}`;

      if (closed.has(nk)) continue;
      if (!surfaceSet.has(nk)) continue;

      const ng = cg + cost;
      const prevG = gScore.get(nk);
      if (prevG !== undefined && ng >= prevG) continue;

      gScore.set(nk, ng);
      cameFrom.set(nk, current.key);
      open.push({ key: nk, ix: nx, iy: ny, iz: nz, f: ng + heuristic(nx, ny, nz) });
    }
  }

  return null; // no path found
}

// ═══════════════════════════════════════════════════════════════
// CRATER / DESTRUCTION SYSTEM
// ═══════════════════════════════════════════════════════════════

function createCrater(pos, radius, room) {
  const VS = VOXEL_SIZE;
  const cellRadius = Math.ceil(radius / VS);

  // Convert impact position to grid coords
  const cix = Math.round(pos.x / VS);
  const ciy = Math.round(pos.y / VS);
  const ciz = Math.round(pos.z / VS);

  const removed = [];

  for (let dx = -cellRadius; dx <= cellRadius; dx++) {
    for (let dy = -cellRadius; dy <= cellRadius; dy++) {
      for (let dz = -cellRadius; dz <= cellRadius; dz++) {
        const ix = cix + dx, iy = ciy + dy, iz = ciz + dz;
        const key = `${ix},${iy},${iz}`;
        if (!room.voxels.has(key)) continue;

        // Check world-space distance from impact point
        const wx = ix * VS - pos.x, wy = iy * VS - pos.y, wz = iz * VS - pos.z;
        const dist = Math.sqrt(wx*wx + wy*wy + wz*wz);
        if (dist <= radius) {
          room.voxels.delete(key);
          room.landSurface.delete(key);
          room.waterSurface.delete(key);
          room.destroyedVoxels.add(key);
          removed.push(key);
        }
      }
    }
  }

  if (removed.length > 0) {
    // Rebuild surface caches for neighbors of removed voxels
    // (newly exposed voxels need to become surface)
    for (const rkey of removed) {
      const [rx, ry, rz] = rkey.split(',').map(Number);
      for (const [fdx, fdy, fdz] of FACE_DIRS) {
        const nk = `${rx+fdx},${ry+fdy},${rz+fdz}`;
        if (!room.voxels.has(nk)) continue;
        const type = room.voxels.get(nk);
        // Check if this neighbor is now exposed
        let exposed = false;
        const [nx, ny, nz] = nk.split(',').map(Number);
        for (const [ddx, ddy, ddz] of FACE_DIRS) {
          const nnk = `${nx+ddx},${ny+ddy},${nz+ddz}`;
          if (!room.voxels.has(nnk)) { exposed = true; break; }
        }
        if (exposed) {
          if (type === 1) room.landSurface.add(nk);
          else if (type === 2) room.waterSurface.add(nk);
        }
      }
    }

    room.events.push({ type: 'crater', removed });
  }
}

// ── Spawn helpers ──
function findValidSpawn(anchorPos, isNaval, isAir, room) {
  if (isAir) return normalize(lerpVec(randomSurfacePoint(), anchorPos, 0.88 + Math.random() * 0.07));
  const surfaceSet = isNaval ? room.waterSurface : room.landSurface;
  for (let i = 0; i < 200; i++) {
    const blend = 0.75 + Math.random() * 0.22;
    const candidate = normalize(lerpVec(randomSurfacePoint(), anchorPos, blend));
    const cell = normalToCell(candidate, surfaceSet);
    if (cell) return cellToNormal(cell.ix, cell.iy, cell.iz);
  }
  return normalize(anchorPos);
}

function findStartBase(approxPos, room) {
  const n = normalize(approxPos);
  for (let i = 0; i < 300; i++) {
    const blend = i < 150 ? (0.85 + Math.random() * 0.12) : (0.50 + Math.random() * 0.45);
    const candidate = normalize(lerpVec(randomSurfacePoint(), n, blend));
    const cell = normalToCell(candidate, room.landSurface);
    if (cell) return cellToNormal(cell.ix, cell.iy, cell.iz);
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

    // Voxel data (generated once per room)
    console.log('  Generating voxel globe...');
    const globe = generateVoxelGlobe();
    this.voxels = globe.voxels;
    this.landSurface = globe.landSurface;
    this.waterSurface = globe.waterSurface;
    this.destroyedVoxels = new Set();
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
    this.broadcast({
      type: 'gameStart',
      terrain: { globeRadius: GLOBE_RADIUS },
      destroyedVoxels: Array.from(this.destroyedVoxels),
    });
    this.tickInterval = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.started = false;
  }

  initEntities() {
    const p1Start = findStartBase({ x: 0, y: 0.3, z: 1 }, this);
    this.spawnEntity('base', p1Start, 1);
    for (let i = 0; i < 3; i++)
      this.spawnEntity('worker', findValidSpawn(p1Start, false, false, this), 1);

    const p2Start = findStartBase({ x: 0, y: -0.3, z: -1 }, this);
    this.spawnEntity('base', p2Start, 2);
    for (let i = 0; i < 3; i++)
      this.spawnEntity('worker', findValidSpawn(p2Start, false, false, this), 2);

    // Resource nodes
    for (let i = 0; i < 28; i++) {
      let pos;
      for (let tries = 0; tries < 50; tries++) {
        const candidate = randomSurfacePoint();
        const cell = normalToCell(candidate, this.landSurface);
        if (cell) { pos = cellToNormal(cell.ix, cell.iy, cell.iz); break; }
      }
      if (!pos) pos = randomSurfacePoint();
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
      path: null, pathIndex: 0,
      alive: true, name: def.name,
    };
    this.entities.push(entity);
    const player = Object.values(this.players).find(p => p.faction === entity.faction);
    if (player && !def.isBuilding && def.popCost) player.pop += def.popCost;
    if (def.popCapBonus && player) player.popCap += def.popCapBonus;
    return entity;
  }

  computePath(entity, targetNormal) {
    if (entity.isAir) {
      // Air units move directly, no pathfinding needed
      entity.path = [normalize(targetNormal)];
      entity.pathIndex = 0;
      return true;
    }

    const surfaceSet = entity.isNaval ? this.waterSurface : this.landSurface;
    const waypoints = findPath(entity.pos, targetNormal, this.voxels, surfaceSet);

    if (waypoints) {
      entity.path = waypoints;
      entity.pathIndex = 0;
      return true;
    }
    return false;
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
            if (!this.computePath(u, target)) {
              this.sendTo(playerId, { type: 'notify', msg: 'Cannot reach that location!' });
              continue;
            }
            u.target = target;
            u.attackTarget = null; u.gatherTarget = null;
            u.gathering = false; u.constructTarget = null;
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
            u.gatherTarget = null; u.gathering = false;
            if (!this.computePath(u, targetEntity.pos)) {
              this.sendTo(playerId, { type: 'notify', msg: 'Cannot reach that target!' });
              u.attackTarget = null; u.target = null;
              continue;
            }
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
            if (!this.computePath(u, resource.pos)) {
              this.sendTo(playerId, { type: 'notify', msg: 'Cannot reach that resource!' });
              u.gatherTarget = null; u.target = null;
              continue;
            }
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
        const offset = findValidSpawn(spawnAnchor.pos, def.isNaval || false, def.isAir || false, this);
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
            this.computePath(w, buildPos);
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
        this.sendTo(playerId, { type: 'notify', msg: `Advanced to ${AGE_NAMES[nextAge]}!` });
        break;
      }
    }
  }

  nukeDetonation(nuke) {
    if (!nuke.alive) return;
    const pos = nuke.pos;
    // Scale pos to world coords for crater
    const worldPos = { x: pos.x * GLOBE_RADIUS, y: pos.y * GLOBE_RADIUS, z: pos.z * GLOBE_RADIUS };

    for (const e of this.entities) {
      if (!e.alive || e.id === nuke.id) continue;
      const dist = angleBetween(pos, e.pos) * GLOBE_RADIUS;
      if (dist <= nuke.nukeRadius) {
        const falloff = Math.max(0, 1 - dist / nuke.nukeRadius * 0.6);
        e.hp -= nuke.attack * falloff;
        if (e.hp <= 0) this.destroyEntity(e);
      }
    }

    // Create crater
    createCrater(worldPos, 2.0, this);

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

      // ── Movement via A* path following ──
      if (e.path && e.pathIndex < e.path.length && !e.isBuilding && e.speed) {
        const current = normalize(e.pos);
        const waypoint = e.path[e.pathIndex];
        const distToWaypoint = angleBetween(current, waypoint);

        if (distToWaypoint > 0.02) {
          // Move toward current waypoint
          const ax = normalize(cross(current, waypoint));
          if (!(ax.x === 0 && ax.y === 0 && ax.z === 0)) {
            const step = Math.min(e.speed * dt * 0.1, distToWaypoint);
            e.pos = normalize(applyAxisAngle(current, ax, step));
          }
        } else {
          // Reached waypoint, advance to next
          e.pathIndex++;
          if (e.pathIndex >= e.path.length) {
            // Path exhausted - handle arrival
            e.path = null;
            e.pathIndex = 0;

            if (e.isNuke) { this.nukeDetonation(e); continue; }
            if (e.gatherTarget) {
              const res = this.entities.find(r => r.id === e.gatherTarget);
              if (res && res.alive && res.amount > 0) e.gathering = true;
            }
            if (!e.attackTarget) e.target = null;
          }
        }
      } else if (e.target && !e.isBuilding && e.speed && !e.path) {
        // Fallback: direct movement for units without a path (e.g., air units being updated to follow target)
        const current = normalize(e.pos);
        const target = normalize(e.target);
        const dist = angleBetween(current, target);
        if (dist > 0.015) {
          const ax = normalize(cross(current, target));
          if (!(ax.x === 0 && ax.y === 0 && ax.z === 0)) {
            const step = Math.min(e.speed * dt * 0.1, dist);
            e.pos = normalize(applyAxisAngle(current, ax, step));
          }
        } else {
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
            e.path = null; e.pathIndex = 0;
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
          } else if (!e.path || e.pathIndex >= (e.path ? e.path.length : 0)) {
            // Need to keep walking toward site
            e.target = { ...site.pos };
            this.computePath(e, site.pos);
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
        if (!tgt || !tgt.alive) { e.attackTarget = null; e.target = null; e.path = null; continue; }

        const dist = angleBetween(e.pos, tgt.pos) * GLOBE_RADIUS;
        if (dist <= e.range) {
          if (e.attackCooldown <= 0) {
            e.attackCooldown = e.attackSpeed || 1;
            if (e.isNuke) { this.nukeDetonation(e); continue; }
            tgt.hp -= e.attack;
            this.events.push({ type: 'projectile', from: { ...e.pos }, to: { ...tgt.pos }, faction: e.faction, unitType: e.type });

            // Crater from projectile impacts
            if (e.type === 'silo') {
              const worldHit = { x: tgt.pos.x * GLOBE_RADIUS, y: tgt.pos.y * GLOBE_RADIUS, z: tgt.pos.z * GLOBE_RADIUS };
              createCrater(worldHit, 0.8, this);
            } else if (e.type === 'tank' || e.type === 'turret' || e.type === 'boat') {
              const worldHit = { x: tgt.pos.x * GLOBE_RADIUS, y: tgt.pos.y * GLOBE_RADIUS, z: tgt.pos.z * GLOBE_RADIUS };
              createCrater(worldHit, 0.4, this);
            }
            // soldier/worker/small units: no crater

            if (tgt.hp <= 0) { this.destroyEntity(tgt); e.attackTarget = null; e.target = null; e.path = null; }
          }
        } else if (!e.isBuilding) {
          // Move toward target to get in range
          e.target = { ...tgt.pos };
          if (!e.path || e.pathIndex >= (e.path ? e.path.length : 0)) {
            this.computePath(e, tgt.pos);
          }
        }
      }
    }

    // ── Unit Separation (prevent overlap) ──
    const mobile = this.entities.filter(e => e.alive && !e.isBuilding && e.speed > 0);
    for (const e of mobile) {
      for (const other of mobile) {
        if (other.id === e.id) continue;
        const d = angleBetween(e.pos, other.pos);
        if (d < 0.055 && d > 0.001) {
          const force = (0.055 - d) * 1.5 * dt;
          const pv = normalize({ x: e.pos.x-other.pos.x, y: e.pos.y-other.pos.y, z: e.pos.z-other.pos.z });
          const cand = normalize({ x: e.pos.x+pv.x*force, y: e.pos.y+pv.y*force, z: e.pos.z+pv.z*force });
          e.pos = cand;
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
  console.log(`  ║   HEGEMONY — Globe RTS Server (Voxel)    ║`);
  console.log(`  ║   Running on http://localhost:${PORT}        ║`);
  console.log(`  ║   4 Ages · Nukes · Jets · Warships        ║`);
  console.log(`  ╚══════════════════════════════════════════╝\n`);
});
