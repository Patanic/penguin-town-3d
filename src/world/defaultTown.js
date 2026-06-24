// =====================================================================
//  Default town — the entire scene expressed as GameObject defs:
//  decorative props (trees, lamps, buildings, igloos, benches, snowmen,
//  piles, bushes, gifts) PLUS the environment (snow ground, mounds, lake,
//  hill, plaza, walkways, string lights, bunting, docks, toboggan rails,
//  the central snow-giant landmark, signs) and the functional gameplay
//  objects (weapon shop, Gunther the keeper, the pistol pickup).
//
//  Loaded when src/levels/town.json has no objects yet, so the editor
//  opens with the familiar town fully populated and editable. Nothing in
//  the world is hardcoded anymore — delete everything and you get an
//  empty scene.
// =====================================================================
import { CATALOG } from './catalog.js';

let seq = 0;
function mk(type, x, z, { id, name, y = 0, rotX = 0, rotY = 0, rotZ = 0, scale = 1, collide, params = {}, components = [] } = {}) {
  const meta = CATALOG[type];
  const s = typeof scale === 'number' ? { x: scale, y: scale, z: scale } : scale;
  return {
    id: id || `town_${type}_${seq++}`,
    type,
    name: name || meta?.label || type,
    position: { x, y, z },
    rotation: { x: rotX, y: rotY, z: rotZ },
    scale: { x: s.x, y: s.y, z: s.z },
    collide: collide ?? meta?.collide ?? false,
    params,
    components,
  };
}

// ---------------------------------------------------------------- props
const TREES = [
  [-45, -26, 1.3], [-40, -18, 0.95], [-48, -4, 1.45], [-41, 12, 1.1], [-33, 22, 1.2], [-18, 32, 0.95], [-12, 46, 1.2],
  [21, 47, 1.25], [37, 37, 1.2], [45, 21, 0.95], [50, 4, 1.45], [47, -20, 1.15], [25, -36, 0.95], [8, -36, 1.25], [-10, -36, 1.0],
  [-46, 34, 1.1], [-38, 40, 0.9], [42, -34, 1.0],
];
const LAMPS = [[-9, 9], [9, 9], [-9, -9], [9, -9], [0, 18], [-14, 11]];
const BUILDINGS = [
  { x: -30, z: -12, w: 11, d: 8, h: 6.6, wall: 0xf9a05c, roof: 0x8d3c4f, awning: 0xc0392b, name: 'Cocoa Café' },
  { x: -12, z: -22, w: 9, d: 8, h: 5.8, wall: 0xffd86a, roof: 0x47749a, awning: 0x2f7fe0, name: 'Hat Hut' },
  { x: 17, z: -14, w: 12, d: 9, h: 7.2, wall: 0x84cdee, roof: 0x356f93, awning: 0x9b5de5, name: 'Game Garage' },
  { x: 32, z: 5, w: 10, d: 8, h: 6.4, wall: 0x9ddb8a, roof: 0x4d756c, awning: 0x2fbf5e, name: 'Snow Lab' },
  { x: -24, z: 12, w: 12, d: 9, h: 6.8, wall: 0xe0a6da, roof: 0x5c5780, awning: 0xff7ec8, name: 'Pet Post' },
];
const IGLOOS = [[-32, 24, 0xeef7ff], [-24, 28, 0xe7f0ff], [-20, 18, 0xf3eaff]];
const GIFTS = [[2.6, 2.4, 0xe5384d], [-2.8, 2.2, 0x2f7fe0], [0.4, 3.2, 0x35c45f], [-1.6, -2.8, 0xffd23f], [2.4, -2.2, 0x9b5de5]];
const SNOWMEN = [[12, 6], [-12, 7], [10, -10], [-11, -9], [-6, 16], [16, 14]];
const BENCHES = [[11, 2, -0.5], [-11, 2, 0.5], [3, 12, Math.PI], [-4, -12, 0]];
const PILES = [[18, -4], [-18, 4], [6, -16], [-16, -14], [20, 8], [14, 18]];
const BUSHES = [[15, -2], [-15, -3], [4, 18], [-9, 14], [19, 2], [-19, 8], [9, -15], [-6, -16]];

export function propObjects() {
  const objects = [];
  TREES.forEach(([x, z, s]) => objects.push(mk('tree', x, z, { scale: s, params: { snow: true, festive: true } })));
  LAMPS.forEach(([x, z]) => objects.push(mk('lamp', x, z)));
  BUILDINGS.forEach((b) => objects.push(mk('building', b.x, b.z, {
    name: b.name, collide: true, params: { w: b.w, d: b.d, h: b.h, wall: b.wall, roof: b.roof, awning: b.awning },
  })));
  IGLOOS.forEach(([x, z, tint], i) => objects.push(mk('igloo', x, z, { name: `Igloo ${i + 1}`, collide: true, params: { tint } })));
  GIFTS.forEach(([x, z, color]) => objects.push(mk('gift', x, z, { params: { color } })));
  SNOWMEN.forEach(([x, z]) => objects.push(mk('snowman', x, z, { collide: true })));
  BENCHES.forEach(([x, z, r]) => objects.push(mk('bench', x, z, { rotY: r })));
  PILES.forEach(([x, z]) => objects.push(mk('snowpile', x, z)));
  BUSHES.forEach(([x, z]) => objects.push(mk('bush', x, z)));
  return objects;
}

// ------------------------------------------------------------ environment
function makeRng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }

function pathSegments(points, w) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    segs.push({ x: (ax + bx) / 2, z: (az + bz) / 2, rotY: Math.atan2(dx, dz), w, len: len + w * 0.4 });
  }
  return segs;
}

// square strands (string lights / bunting): align the builder's local +X with
// each edge direction → rotationY = atan2(-dz, dx).
function squareStrands(half, count) {
  const c = [[-half, half], [half, half], [half, -half], [-half, -half]];
  const out = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = c[i];
    const [bx, bz] = c[(i + 1) % 4];
    const dx = bx - ax, dz = bz - az;
    out.push({ x: (ax + bx) / 2, z: (az + bz) / 2, rotY: Math.atan2(-dz, dx), len: Math.hypot(dx, dz), count });
  }
  return out;
}

export function systemObjects() {
  const objects = [];

  // terrain + water + relief
  objects.push(mk('ground', 0, 0, { params: { radius: 120 } }));
  objects.push(mk('lake', 2, 38, { params: { radius: 16 }, components: [{ type: 'Shimmer', params: { amp: 0.06, speed: 1.5, base: 0.82 } }] }));
  objects.push(mk('hill', 34, -22));
  objects.push(mk('plazafloor', 0, 0, { params: { radius: 14 } }));

  // gentle snow mounds (deterministic so the map is identical for everyone)
  const rng = makeRng(1337);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const r = 30 + rng() * 75;
    const s = 2 + rng() * 5;
    objects.push(mk('snowmound', Math.cos(a) * r, Math.sin(a) * r, { scale: s }));
  }

  // walkways
  const paths = [
    pathSegments([[0, 6], [0, 26], [2, 36]], 5.4),
    pathSegments([[0, 3], [-18, -6], [-32, -11]], 4.8),
    pathSegments([[0, 2], [15, -7], [31, -15]], 4.8),
    pathSegments([[-3, 4], [-16, 12], [-28, 20]], 4.6),
  ].flat();
  paths.forEach((s) => objects.push(mk('path', s.x, s.z, { rotY: s.rotY, params: { w: s.w, len: s.len } })));

  // festive strands around the plaza
  squareStrands(9, 9).forEach((s) => objects.push(mk('lightstring', s.x, s.z, { y: 4.4, rotY: s.rotY, params: { len: s.len, count: s.count } })));
  squareStrands(7, 10).forEach((s) => objects.push(mk('bunting', s.x, s.z, { y: 5, rotY: s.rotY, params: { len: s.len, count: s.count } })));

  // docks (two side boardwalks + the cross planks)
  objects.push(mk('dock', -7.4, 36, { name: 'Dock (west)', params: { len: 24 } }));
  objects.push(mk('dock', 11.4, 36, { name: 'Dock (east)', params: { len: 24 } }));
  objects.push(mk('dock', 2, 48.6, { name: 'Dock (cross)', rotY: Math.PI / 2, params: { len: 18 } }));

  // toboggan ramp rails
  for (let i = 0; i < 6; i++) {
    objects.push(mk('tobogganrail', 22 + i * 3.0, -22 + i * 1.6, { y: 1.175 + i * 0.5 }));
  }

  // central landmark (keeps its gentle bob via a Bob component)
  objects.push(mk('snowgiant', 0, 0, { name: 'Snowy Giant', collide: true, components: [{ type: 'Bob', params: { amp: 0.04, speed: 1.2 } }] }));

  // ------------------------------------------------------------ gameplay
  const SX = 14, SZ = 20;
  objects.push(mk('shop', SX, SZ, { id: 'shop_main', name: 'Weapon Shop', collide: true }));
  objects.push(mk('keeper', SX, SZ + 0.8, { id: 'shop_keeper', name: 'Gunther', rotY: Math.PI }));
  objects.push(mk('gunpickup', SX, SZ - 2.4, {
    id: 'shop_gun', name: 'Pistol (pickup)', y: 1.6,
    components: [{ type: 'Spin', params: { speed: 1.3, axis: 'y' } }, { type: 'Bob', params: { amp: 0.08, speed: 2 } }],
  }));

  return objects;
}

export function defaultTown() {
  seq = 0;
  return { version: 1, objects: [...propObjects(), ...systemObjects()] };
}
