// =====================================================================
//  World object catalog — clean, side-effect-free builders used by the
//  level editor and the runtime level loader (loadLevel).
//
//  Each builder returns a THREE.Object3D centered at the local origin and
//  resting on y=0. The caller (loader/editor) owns placement: it sets
//  position / rotation / scale on the returned object and derives collision
//  from `objectFootprint`. Builders NEVER touch the scene, `solid`, or any
//  other global — they are pure factories, so objects can be freely added,
//  moved, and removed.
// =====================================================================
import * as THREE from 'three';

// ---------- tiny local helpers (kept independent of main.js) ----------
function mat(color, roughness = 0.85) {
  return new THREE.MeshStandardMaterial({ color, roughness });
}
function glowMat(color, intensity = 1.1, roughness = 0.35) {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness });
}
function mesh(geometry, material, cast = true, receive = true) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function stripeTexture(hexA, hexB, stripes = 7, vertical = false) {
  const c = document.createElement('canvas');
  const a = '#' + new THREE.Color(hexA).getHexString();
  const b = '#' + new THREE.Color(hexB).getHexString();
  if (vertical) { c.width = 32; c.height = stripes * 16; } else { c.width = stripes * 32; c.height = 32; }
  const ctx = c.getContext('2d');
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    if (vertical) ctx.fillRect(0, i * 16, 32, 16);
    else ctx.fillRect(i * 32, 0, 32, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BAUBLE_COLORS = [0xff6f61, 0xffd23f, 0x35c45f, 0x2f7fe0, 0x9b5de5, 0xff7ec8];

// =====================================================================
//  Builders — each takes a merged params object and returns Object3D.
//  They are deterministic (no Math.random) so a saved map looks identical
//  on every load and for every player.
// =====================================================================

function buildTree(p) {
  const g = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.32, 0.4, 2.4, 10), mat(0x7a4d2c));
  trunk.position.y = 1.2;
  g.add(trunk);
  for (let i = 0; i < 3; i++) {
    const cone = mesh(new THREE.ConeGeometry(1.6 - i * 0.3, 2.5, 10), mat(i === 1 ? 0x2f8a63 : 0x247a55, 0.9));
    cone.position.y = 1.7 + i * 1.05;
    g.add(cone);
    if (p.snow) {
      const cap = mesh(new THREE.ConeGeometry(1.62 - i * 0.3, 0.5, 10), mat(0xffffff));
      cap.position.y = 1.7 + i * 1.05 + 1.0;
      g.add(cap);
    }
  }
  if (p.festive) {
    // glowing baubles tucked into the branches (deterministic placement)
    for (let b = 0; b < 7; b++) {
      const ang = (b / 7) * Math.PI * 2 + 0.6;
      const ry = 2.1 + (b % 3) * 0.85;
      const rad = (1.5 - (ry - 2) * 0.35) * (0.78 + (b % 4) * 0.08);
      const c = BAUBLE_COLORS[b % BAUBLE_COLORS.length];
      const bauble = mesh(new THREE.SphereGeometry(0.14, 10, 10), glowMat(c, 1.1), false, false);
      bauble.position.set(Math.cos(ang) * rad, ry, Math.sin(ang) * rad);
      bauble.userData.twinkle = { base: 1.1, amp: 0.6 };
      g.add(bauble);
    }
    const star = mesh(new THREE.OctahedronGeometry(0.3), glowMat(0xffe06a, 1.4, 0.3), false, false);
    star.material.emissive = new THREE.Color(0xffcf3a);
    star.position.y = 4.9;
    star.userData.twinkle = { base: 1.4, amp: 0.5 };
    g.add(star);
  }
  return g;
}

function buildLamp() {
  const g = new THREE.Group();
  const pole = mesh(new THREE.CylinderGeometry(0.13, 0.15, 4.2, 12), new THREE.MeshStandardMaterial({ map: stripeTexture(0xe5384d, 0xffffff, 8, true), roughness: 0.6 }));
  pole.position.y = 2.1;
  g.add(pole);
  const cap = mesh(new THREE.ConeGeometry(0.55, 0.6, 8), mat(0x2c3e50));
  cap.position.y = 4.75;
  g.add(cap);
  const glass = mesh(new THREE.SphereGeometry(0.42, 16, 12), glowMat(0xfff0b8, 1.5, 0.4), false, false);
  glass.material.emissive = new THREE.Color(0xffd97a);
  glass.position.y = 4.25;
  glass.userData.twinkle = { base: 1.5, amp: 0.25 };
  g.add(glass);
  const snow = mesh(new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffffff));
  snow.position.y = 4.55;
  g.add(snow);
  return g;
}

function buildBuilding(p) {
  const w = p.w, d = p.d, h = p.h;
  const g = new THREE.Group();
  const front = d / 2;
  const body = mesh(new THREE.BoxGeometry(w, h, d), mat(p.wall));
  body.position.y = h / 2;
  g.add(body);
  const trim = mesh(new THREE.BoxGeometry(w + 0.3, 0.5, d + 0.3), mat(0xffffff));
  trim.position.y = 0.25;
  g.add(trim);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pil = mesh(new THREE.BoxGeometry(0.4, h, 0.4), mat(0xffffff));
    pil.position.set(sx * (w / 2), h / 2, sz * (d / 2));
    g.add(pil);
  }
  const roof = mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, h * 0.7, 4), mat(p.roof, 0.8));
  roof.position.y = h + h * 0.34;
  roof.rotation.y = Math.PI / 4;
  g.add(roof);
  const snowCap = mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.6, h * 0.28, 4), mat(0xffffff));
  snowCap.position.y = h + h * 0.62;
  snowCap.rotation.y = Math.PI / 4;
  g.add(snowCap);
  const door = mesh(new THREE.BoxGeometry(Math.min(2.2, w * 0.3), h * 0.5, 0.2), mat(0x5d4130));
  door.position.set(0, h * 0.25, front + 0.11);
  g.add(door);
  const awnW = Math.min(3.4, w * 0.46);
  const awn = mesh(new THREE.BoxGeometry(awnW, 0.18, 1.5), new THREE.MeshStandardMaterial({ map: stripeTexture(p.awning, 0xffffff), roughness: 0.7 }));
  awn.rotation.x = 0.42;
  awn.position.set(0, h * 0.56, front + 0.7);
  g.add(awn);
  const winMat = glowMat(0xfff2bd, 0.8, 0.3);
  winMat.emissive = new THREE.Color(0xffd06a);
  for (const dx of [-w * 0.3, w * 0.3]) {
    const win = mesh(new THREE.BoxGeometry(w * 0.17, h * 0.24, 0.14), winMat, false, false);
    win.position.set(dx, h * 0.6, front + 0.08);
    g.add(win);
  }
  return g;
}

function buildIgloo(p) {
  const tint = p.tint;
  const g = new THREE.Group();
  const dome = mesh(new THREE.SphereGeometry(3.1, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(tint, 0.92));
  g.add(dome);
  for (let r = 0; r < 3; r++) {
    const ring = mesh(new THREE.TorusGeometry(3.1 * Math.cos((r / 3.4) * Math.PI / 2), 0.07, 6, 30), mat(0xcfe4f0, 0.95), false, false);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.4 + r * 0.85;
    g.add(ring);
  }
  const ent = mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.8, 16, 1, false, 0, Math.PI), mat(tint, 0.92));
  ent.rotation.z = Math.PI / 2;
  ent.rotation.y = Math.PI / 2;
  ent.position.set(0, 0.9, 3.1);
  g.add(ent);
  const doorway = mesh(new THREE.CircleGeometry(0.95, 18), new THREE.MeshBasicMaterial({ color: 0x16384f }), false, false);
  doorway.position.set(0, 0.95, 4.02);
  g.add(doorway);
  return g;
}

function buildBench() {
  const g = new THREE.Group();
  const seat = mesh(new THREE.BoxGeometry(2.4, 0.18, 0.7), mat(0x9c6b3f, 0.7)); seat.position.y = 0.7; g.add(seat);
  const back = mesh(new THREE.BoxGeometry(2.4, 0.7, 0.16), mat(0x9c6b3f, 0.7)); back.position.set(0, 1.05, -0.32); g.add(back);
  for (const sx of [-1, 1]) {
    const leg = mesh(new THREE.BoxGeometry(0.18, 0.7, 0.6), mat(0x6b4a2c)); leg.position.set(sx * 1.0, 0.35, 0); g.add(leg);
  }
  const snow = mesh(new THREE.BoxGeometry(2.3, 0.12, 0.65), mat(0xffffff)); snow.position.set(0, 0.84, 0.02); g.add(snow);
  return g;
}

function buildSnowman() {
  const g = new THREE.Group();
  const b1 = mesh(new THREE.SphereGeometry(0.6, 16, 12), mat(0xffffff, 0.9)); b1.position.y = 0.55; g.add(b1);
  const b2 = mesh(new THREE.SphereGeometry(0.42, 16, 12), mat(0xffffff, 0.9)); b2.position.y = 1.3; g.add(b2);
  for (const sx of [-0.15, 0.15]) {
    const e = mesh(new THREE.SphereGeometry(0.05, 8, 8), mat(0x2a2a2a), false, false); e.position.set(sx, 1.38, 0.36); g.add(e);
  }
  const n = mesh(new THREE.ConeGeometry(0.07, 0.32, 8), mat(0xff8c3b), false, false);
  n.rotation.x = Math.PI / 2; n.position.set(0, 1.28, 0.42); g.add(n);
  const scarf = mesh(new THREE.TorusGeometry(0.4, 0.09, 8, 16), mat(0xe5384d, 0.6), false, false);
  scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.0; g.add(scarf);
  return g;
}

function buildGift(p) {
  const s = 1;
  const g = new THREE.Group();
  const box = mesh(new THREE.BoxGeometry(s, s, s), mat(p.color, 0.6)); box.position.y = s / 2; g.add(box);
  const rib = mesh(new THREE.BoxGeometry(s * 0.16, s * 1.02, s * 1.02), mat(0xfff2bd, 0.5), false, false); rib.position.y = s / 2; g.add(rib);
  const rib2 = mesh(new THREE.BoxGeometry(s * 1.02, s * 1.02, s * 0.16), mat(0xfff2bd, 0.5), false, false); rib2.position.y = s / 2; g.add(rib2);
  const bow = mesh(new THREE.SphereGeometry(s * 0.18, 10, 10), mat(0xfff2bd, 0.5), false, false); bow.position.y = s + 0.02; g.add(bow);
  return g;
}

function buildSnowPile() {
  const g = new THREE.Group();
  const offs = [[-0.45, 0.5, 0.3], [0.4, 0.42, -0.4], [0.1, 0.55, 0.4], [-0.2, 0.45, -0.3]];
  for (const [ox, r, oz] of offs) {
    const ball = mesh(new THREE.SphereGeometry(r, 12, 10), mat(0xfdffff, 0.85));
    ball.position.set(ox, r * 0.7, oz);
    g.add(ball);
  }
  return g;
}

function buildBush() {
  const g = new THREE.Group();
  const offs = [[-0.35, 0.4, 0.45], [0.4, 0.35, -0.3], [0, 0.5, 0.1]];
  for (const [ox, r, oz] of offs) {
    const b = mesh(new THREE.SphereGeometry(r, 12, 10), mat(0x2f8a63, 0.9));
    b.position.set(ox, r * 0.8, oz); g.add(b);
    const cap = mesh(new THREE.SphereGeometry(r * 0.96, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffffff));
    cap.position.set(ox, r * 0.8 + r * 0.2, oz); g.add(cap);
  }
  return g;
}

function buildSign(p) {
  const g = new THREE.Group();
  const post = mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.6, 8), mat(0x6b4a2c));
  post.position.y = 1.3;
  g.add(post);
  // canvas label
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '900 96px "Baloo 2", system-ui, sans-serif';
  ctx.font = font;
  const text = p.text || 'Sign';
  const textW = ctx.measureText(text).width;
  canvas.width = Math.ceil(textW + 76);
  canvas.height = 170;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#' + new THREE.Color(p.bg ?? 0x0f4668).getHexString();
  roundRect(ctx, 6, 22, canvas.width - 12, canvas.height - 44, 48);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  roundRect(ctx, 6, 22, canvas.width - 12, canvas.height - 44, 48);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const aspect = canvas.width / canvas.height;
  const sh = 1.3;
  sprite.scale.set(sh * aspect, sh, 1);
  sprite.position.y = 3.0;
  g.add(sprite);
  return g;
}

// =====================================================================
//  Environment builders — terrain, water, plaza, walkways, festive
//  strands, docks, the central landmark and the weapon shop. These used
//  to be hardcoded in main.js; they now load through the level system so
//  every piece of the town is editable, movable and deletable.
// =====================================================================
const BULB_COLORS = [0xff6f61, 0xffd23f, 0x35c45f, 0x2f7fe0, 0x9b5de5, 0xff7ec8];

let _snowTex = null;
function snowGroundTexture() {
  if (_snowTex) return _snowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3fbff';
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(208,232,245,${0.05 + Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 512, Math.random() * 512, 8 + Math.random() * 40, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.6})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5);
  }
  _snowTex = new THREE.CanvasTexture(c);
  _snowTex.colorSpace = THREE.SRGBColorSpace;
  _snowTex.wrapS = _snowTex.wrapT = THREE.RepeatWrapping;
  _snowTex.repeat.set(8, 8);
  return _snowTex;
}

let _plazaTex = null;
function plazaTexture() {
  if (_plazaTex) return _plazaTex;
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d');
  const cx = 512, cy = 512;
  ctx.fillStyle = '#e3f1fa';
  ctx.fillRect(0, 0, 1024, 1024);
  for (let r = 460; r > 60; r -= 70) {
    ctx.strokeStyle = r % 140 === 460 % 140 ? 'rgba(150,190,215,0.6)' : 'rgba(180,210,230,0.55)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.strokeStyle = 'rgba(170,205,228,0.45)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 75, cy + Math.sin(a) * 75);
    ctx.lineTo(cx + Math.cos(a) * 470, cy + Math.sin(a) * 470);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(120,170,205,0.55)';
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const long = i % 2 === 0 ? 150 : 80;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - 0.16) * 40, cy + Math.sin(a - 0.16) * 40);
    ctx.lineTo(cx + Math.cos(a) * long, cy + Math.sin(a) * long);
    ctx.lineTo(cx + Math.cos(a + 0.16) * 40, cy + Math.sin(a + 0.16) * 40);
    ctx.closePath();
    ctx.fill();
  }
  _plazaTex = new THREE.CanvasTexture(c);
  _plazaTex.colorSpace = THREE.SRGBColorSpace;
  return _plazaTex;
}

function buildGround(p) {
  const g = mesh(new THREE.CircleGeometry(p.radius, 64), new THREE.MeshStandardMaterial({ map: snowGroundTexture(), roughness: 0.92 }), false, true);
  g.rotation.x = -Math.PI / 2;
  const wrap = new THREE.Group(); // wrap so the editor transform doesn't fight the -90° tilt
  wrap.add(g);
  return wrap;
}

function buildSnowMound() {
  const m = mesh(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xeaf7ff, 0.95), false, true);
  m.scale.y = 0.35;
  m.position.y = -0.2;
  const g = new THREE.Group(); g.add(m); return g;
}

function buildLake(p) {
  const m = mesh(
    new THREE.CircleGeometry(p.radius, 64),
    new THREE.MeshStandardMaterial({ color: 0x8fe1f6, metalness: 0.35, roughness: 0.12, transparent: true, opacity: 0.86 }),
    false, true
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.04;
  m.userData.shimmer = true; // tag for the Shimmer component
  const g = new THREE.Group(); g.add(m); return g;
}

function buildHill() {
  const m = mesh(new THREE.SphereGeometry(21, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xeaf8ff, 0.95), false, true);
  m.scale.set(1.4, 0.5, 1.05);
  m.position.y = -5;
  const g = new THREE.Group(); g.add(m); return g;
}

function buildPlazaFloor(p) {
  const floor = mesh(new THREE.CircleGeometry(p.radius, 64), new THREE.MeshStandardMaterial({ map: plazaTexture(), roughness: 0.85 }), false, true);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.06;
  const ring = mesh(new THREE.TorusGeometry(p.radius, 0.4, 10, 80), mat(0xcde0ec, 0.8));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.18;
  const g = new THREE.Group(); g.add(floor); g.add(ring); return g;
}

function buildPath(p) {
  // a single straight walkway slab, sized via params; placement by caller
  const slab = mesh(new THREE.BoxGeometry(p.w, 0.1, p.len), mat(0xdfeef6), false, true);
  slab.position.y = 0.05;
  const g = new THREE.Group(); g.add(slab); return g;
}

// a drooping strand of glowing bulbs centered at the origin, running along
// local +X for `len` units. Bulbs carry a twinkle tag so the runtime animates
// their glow automatically.
function buildLightString(p) {
  const g = new THREE.Group();
  const count = p.count;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = (t - 0.5) * p.len;
    const y = -Math.sin(t * Math.PI) * 1.1;
    const col = BULB_COLORS[i % BULB_COLORS.length];
    const bulb = mesh(new THREE.SphereGeometry(0.11, 8, 8), glowMat(col, 1.2, 0.35), false, false);
    bulb.position.set(x, y, 0);
    bulb.userData.twinkle = { base: 1.2, amp: 0.7 };
    g.add(bulb);
  }
  return g;
}

function buildBunting(p) {
  const g = new THREE.Group();
  const cols = [0xff6f61, 0xffd23f, 0x35c45f, 0x2f7fe0, 0x9b5de5];
  const count = p.count;
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const x = (t - 0.5) * p.len;
    const y = -Math.sin(t * Math.PI) * 0.9;
    const flag = mesh(new THREE.ConeGeometry(0.35, 0.7, 4), new THREE.MeshStandardMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, roughness: 0.6 }), false, false);
    flag.position.set(x, y, 0);
    flag.rotation.x = Math.PI;
    g.add(flag);
  }
  return g;
}

// a boardwalk: a row of planks running along local +Z for `len` units
function buildDock(p) {
  const g = new THREE.Group();
  const dockMat = mat(0xa8794f);
  const step = 3.1;
  const n = Math.max(1, Math.round(p.len / step));
  for (let i = 0; i < n; i++) {
    const z = (i - (n - 1) / 2) * step;
    const plank = mesh(new THREE.BoxGeometry(3.2, 0.25, 2.7), dockMat.clone());
    plank.position.set(0, 0.18, z);
    g.add(plank);
  }
  return g;
}

function buildTobogganRail() {
  const rail = mesh(new THREE.BoxGeometry(3.0, 0.25, 6.0), mat(0xf3cf55));
  rail.rotation.z = -0.13;
  rail.position.y = 0.125;
  const g = new THREE.Group(); g.add(rail); return g;
}

// the friendly snow-giant landmark in the central plaza (static decoration)
function buildSnowGiant() {
  const g = new THREE.Group();
  const sn1 = mesh(new THREE.SphereGeometry(2.4, 28, 20), mat(0xffffff, 0.9)); sn1.position.set(0, 2.2, 0); g.add(sn1);
  const sn2 = mesh(new THREE.SphereGeometry(1.7, 28, 20), mat(0xffffff, 0.9)); sn2.position.set(0, 5.3, 0); g.add(sn2);
  const snHead = mesh(new THREE.SphereGeometry(1.2, 28, 20), mat(0xffffff, 0.9)); snHead.position.set(0, 7.6, 0); g.add(snHead);
  for (const sx of [-0.45, 0.45]) {
    const e = mesh(new THREE.SphereGeometry(0.16, 12, 12), mat(0x2a2a2a), false, false); e.position.set(sx, 7.9, 1.05); g.add(e);
  }
  const nose = mesh(new THREE.ConeGeometry(0.22, 1.0, 12), mat(0xff8c3b)); nose.rotation.x = Math.PI / 2; nose.position.set(0, 7.55, 1.4); g.add(nose);
  for (let i = 0; i < 3; i++) {
    const btn = mesh(new THREE.SphereGeometry(0.18, 10, 10), mat(0x2a2a2a), false, false); btn.position.set(0, 5.6 - i * 0.7, 1.55 - i * 0.12); g.add(btn);
  }
  for (let i = 0; i < 5; i++) {
    const s = mesh(new THREE.SphereGeometry(0.1, 8, 8), mat(0x2a2a2a), false, false);
    const a = -0.7 + (i / 4) * 1.4;
    s.position.set(Math.sin(a) * 0.7, 7.15 + Math.cos(a) * 0.18 - 0.18, 1.08); g.add(s);
  }
  const brim = mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.12, 20), mat(0x2c3142)); brim.position.set(0, 8.55, 0); g.add(brim);
  const topHat = mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 20), mat(0x2c3142)); topHat.position.set(0, 9.2, 0); g.add(topHat);
  const hatBand = mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.28, 20), mat(0xe5384d)); hatBand.position.set(0, 8.78, 0); g.add(hatBand);
  for (const side of [-1, 1]) {
    const arm = mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 6), mat(0x6b4a2c));
    arm.position.set(side * 2.0, 5.5, 0); arm.rotation.z = side * 0.9; g.add(arm);
  }
  return g;
}

// the weapon shop stall (front counter the player chats across). The keeper
// (Gunther) and the pistol-on-display are separate GameObjects.
function buildShop() {
  const g = new THREE.Group();
  const woodDark = mat(0x7a5230, 0.9);
  const woodLight = mat(0x9c6b3f, 0.85);
  const sFloor = mesh(new THREE.BoxGeometry(9, 0.3, 6.6), woodLight.clone()); sFloor.position.y = 0.15; g.add(sFloor);
  const sBack = mesh(new THREE.BoxGeometry(9, 4.2, 0.4), woodDark.clone()); sBack.position.set(0, 2.25, 3.1); g.add(sBack);
  for (const sx of [-1, 1]) {
    const sWall = mesh(new THREE.BoxGeometry(0.4, 4.2, 6.6), woodDark.clone()); sWall.position.set(sx * 4.3, 2.25, 0); g.add(sWall);
    const post = mesh(new THREE.BoxGeometry(0.45, 4.6, 0.45), woodDark.clone()); post.position.set(sx * 4.3, 2.3, -3.0); g.add(post);
  }
  for (let s = 0; s < 9; s++) {
    const slat = mesh(new THREE.BoxGeometry(1.05, 0.4, 8), mat(s % 2 ? 0xb6303a : 0xefe6d6, 0.7));
    slat.position.set(-4 + s, 4.7, -0.2); g.add(slat);
  }
  const counter = mesh(new THREE.BoxGeometry(8.4, 1.35, 1.0), woodLight.clone()); counter.position.set(0, 0.78, -2.4); g.add(counter);
  const counterTop = mesh(new THREE.BoxGeometry(8.7, 0.18, 1.35), mat(0xc69a63, 0.6)); counterTop.position.set(0, 1.5, -2.4); g.add(counterTop);
  for (const cx of [-3, 3]) {
    const cr = mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), mat(0x8a6a44, 0.9)); cr.position.set(cx, 0.85, 2.3); g.add(cr);
  }
  g.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  return g;
}

// ---- raw primitives: unit-sized, sized via the transform scale gizmo ----
function buildBox(p) {
  return mesh(new THREE.BoxGeometry(1, 1, 1), mat(p.color, 0.8));
}
function buildCylinder(p) {
  const m = mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 20), mat(p.color, 0.8));
  return m;
}
function buildSphere(p) {
  return mesh(new THREE.SphereGeometry(0.5, 20, 16), mat(p.color, 0.8));
}

// =====================================================================
//  Catalog definitions: defaults, editable param schema, footprint.
//  `footprint(params)` returns LOCAL (unscaled) XZ half-extents for
//  collision, or null when the type has no default footprint. The loader
//  applies scale + rotation to produce the world-space AABB.
// =====================================================================
const num = (key, label, def, min, max, step = 0.5) => ({ key, label, type: 'number', default: def, min, max, step });
const col = (key, label, def) => ({ key, label, type: 'color', default: def });

export const CATALOG = {
  // --- themed props ---
  tree: {
    label: 'Pine Tree', category: 'Nature', build: buildTree, collide: false,
    params: { snow: true, festive: true },
    schema: [{ key: 'snow', label: 'Snowy', type: 'bool', default: true }, { key: 'festive', label: 'Star topper', type: 'bool', default: true }],
    footprint: () => ({ hx: 1.0, hz: 1.0 }),
  },
  bush: {
    label: 'Bush', category: 'Nature', build: buildBush, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 0.7, hz: 0.7 }),
  },
  snowman: {
    label: 'Snowman', category: 'Nature', build: buildSnowman, collide: false,
    params: {}, schema: [], footprint: () => ({ r: 0.7 }),
  },
  snowpile: {
    label: 'Snow Pile', category: 'Nature', build: buildSnowPile, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 0.9, hz: 0.9 }),
  },
  lamp: {
    label: 'Lamp Post', category: 'Props', build: buildLamp, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 0.4, hz: 0.4 }),
  },
  bench: {
    label: 'Bench', category: 'Props', build: buildBench, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 1.3, hz: 0.5 }),
  },
  gift: {
    label: 'Gift Box', category: 'Props', build: buildGift, collide: false,
    params: { color: 0xe5384d }, schema: [col('color', 'Color', 0xe5384d)], footprint: () => ({ hx: 0.6, hz: 0.6 }),
  },
  sign: {
    label: 'Sign', category: 'Props', build: buildSign, collide: false,
    params: { text: 'Sign', bg: 0x0f4668 },
    schema: [{ key: 'text', label: 'Text', type: 'text', default: 'Sign' }, col('bg', 'Background', 0x0f4668)],
    footprint: () => ({ hx: 0.3, hz: 0.3 }),
  },
  // --- structures (collide by default) ---
  building: {
    label: 'Building', category: 'Structures', build: buildBuilding, collide: true,
    params: { w: 10, d: 8, h: 6.5, wall: 0x84cdee, roof: 0x356f93, awning: 0x9b5de5 },
    schema: [
      num('w', 'Width', 10, 4, 30), num('d', 'Depth', 8, 4, 30), num('h', 'Height', 6.5, 3, 20),
      col('wall', 'Wall', 0x84cdee), col('roof', 'Roof', 0x356f93), col('awning', 'Awning', 0x9b5de5),
    ],
    footprint: (p) => ({ hx: p.w / 2 + 0.5, hz: p.d / 2 + 0.5 }),
  },
  igloo: {
    label: 'Igloo', category: 'Structures', build: buildIgloo, collide: true,
    params: { tint: 0xeef7ff }, schema: [col('tint', 'Tint', 0xeef7ff)], footprint: () => ({ hx: 3.4, hz: 3.4 }),
  },
  // --- environment (terrain, water, walkways, festive strands) ---
  // footprints are real so ticking "Collision" in the editor produces a
  // sized collision box; they're just collide:false by default.
  ground: {
    label: 'Snow Ground', category: 'Environment', build: buildGround, collide: false,
    params: { radius: 120 }, schema: [num('radius', 'Radius', 120, 10, 200, 5)], footprint: (p) => ({ hx: p.radius, hz: p.radius }),
  },
  snowmound: {
    label: 'Snow Mound', category: 'Environment', build: buildSnowMound, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 1.0, hz: 1.0 }),
  },
  lake: {
    label: 'Frozen Lake', category: 'Environment', build: buildLake, collide: false,
    params: { radius: 16 }, schema: [num('radius', 'Radius', 16, 2, 60, 1)], footprint: (p) => ({ hx: p.radius, hz: p.radius }),
  },
  hill: {
    label: 'Toboggan Hill', category: 'Environment', build: buildHill, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 29.4, hz: 22.05 }),
  },
  plazafloor: {
    label: 'Plaza Floor', category: 'Environment', build: buildPlazaFloor, collide: false,
    params: { radius: 14 }, schema: [num('radius', 'Radius', 14, 4, 40, 1)], footprint: (p) => ({ hx: p.radius, hz: p.radius }),
  },
  path: {
    label: 'Walkway', category: 'Environment', build: buildPath, collide: false,
    params: { w: 5, len: 12 }, schema: [num('w', 'Width', 5, 1, 14, 0.2), num('len', 'Length', 12, 1, 60, 0.5)], footprint: (p) => ({ hx: p.w / 2, hz: p.len / 2 }),
  },
  lightstring: {
    label: 'String Lights', category: 'Environment', build: buildLightString, collide: false,
    params: { len: 18, count: 9 }, schema: [num('len', 'Length', 18, 2, 60, 0.5), num('count', 'Bulbs', 9, 2, 30, 1)], footprint: (p) => ({ hx: p.len / 2, hz: 0.3 }),
  },
  bunting: {
    label: 'Bunting', category: 'Environment', build: buildBunting, collide: false,
    params: { len: 14, count: 10 }, schema: [num('len', 'Length', 14, 2, 60, 0.5), num('count', 'Flags', 10, 2, 30, 1)], footprint: (p) => ({ hx: p.len / 2, hz: 0.3 }),
  },
  dock: {
    label: 'Dock', category: 'Environment', build: buildDock, collide: false,
    params: { len: 24 }, schema: [num('len', 'Length', 24, 3, 80, 1)], footprint: (p) => ({ hx: 1.6, hz: p.len / 2 }),
  },
  tobogganrail: {
    label: 'Toboggan Rail', category: 'Environment', build: buildTobogganRail, collide: false,
    params: {}, schema: [], footprint: () => ({ hx: 1.5, hz: 3.0 }),
  },
  snowgiant: {
    label: 'Snow Giant', category: 'Environment', build: buildSnowGiant, collide: true,
    params: {}, schema: [], footprint: () => ({ r: 2.8 }),
  },
  // --- gameplay structures ---
  shop: {
    label: 'Weapon Shop', category: 'Gameplay', build: buildShop, collide: true,
    params: {}, schema: [], footprint: () => ({ hx: 4.5, hz: 3.3 }),
  },
  // --- raw primitives (sized via scale) ---
  box: {
    label: 'Box', category: 'Primitives', build: buildBox, collide: true,
    params: { color: 0xbfc7d2 }, schema: [col('color', 'Color', 0xbfc7d2)], footprint: () => ({ hx: 0.5, hz: 0.5 }),
  },
  cylinder: {
    label: 'Cylinder', category: 'Primitives', build: buildCylinder, collide: true,
    params: { color: 0xbfc7d2 }, schema: [col('color', 'Color', 0xbfc7d2)], footprint: () => ({ hx: 0.5, hz: 0.5 }),
  },
  sphere: {
    label: 'Sphere', category: 'Primitives', build: buildSphere, collide: false,
    params: { color: 0xbfc7d2 }, schema: [col('color', 'Color', 0xbfc7d2)], footprint: () => ({ hx: 0.5, hz: 0.5 }),
  },
};

// ordered list for the palette UI, grouped by category
export const PALETTE = Object.keys(CATALOG);
export const CATEGORIES = [...new Set(Object.values(CATALOG).map((c) => c.category))];

// Register a builder type at runtime. Used by main.js for types whose
// builders depend on factories that live in main.js (the keeper penguin,
// the pistol pickup) — keeps this module free of game-internal imports.
export function registerType(type, def) {
  CATALOG[type] = def;
  if (!PALETTE.includes(type)) PALETTE.push(type);
  if (!CATEGORIES.includes(def.category)) CATEGORIES.push(def.category);
}

// merge stored params over the type defaults so missing/legacy keys are safe
export function mergedParams(type, params = {}) {
  const def = CATALOG[type];
  return { ...(def ? def.params : {}), ...params };
}

// build the visual object for a definition (transform applied by caller)
export function makeObject(type, params = {}) {
  const def = CATALOG[type];
  if (!def) return null;
  const obj = def.build(mergedParams(type, params));
  obj.traverse?.((m) => { if (m.isMesh) { m.userData.editorPickable = true; } });
  obj.userData.editorPickable = true;
  return obj;
}

// world-space XZ collision half-extents for a placed definition, or null
export function objectFootprint(def) {
  const meta = CATALOG[def.type];
  if (!meta) return null;
  const collide = def.collide ?? meta.collide;
  if (!collide) return null;
  const fp = meta.footprint(mergedParams(def.type, def.params));
  if (!fp) return null;
  const sx = def.scale?.x ?? 1;
  const sz = def.scale?.z ?? 1;
  const ry = def.rotation?.y ?? 0;
  if (fp.r != null) {
    const r = fp.r * Math.max(Math.abs(sx), Math.abs(sz));
    return { x: def.position?.x ?? 0, z: def.position?.z ?? 0, r };
  }
  const localHx = fp.hx * sx;
  const localHz = fp.hz * sz;
  const c = Math.abs(Math.cos(ry)), s = Math.abs(Math.sin(ry));
  return {
    x: def.position?.x ?? 0,
    z: def.position?.z ?? 0,
    hx: localHx * c + localHz * s,
    hz: localHx * s + localHz * c,
  };
}

// default transform/params for a freshly placed object of a type
export function defaultDef(type) {
  const meta = CATALOG[type];
  return {
    type,
    name: meta ? meta.label : type,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    collide: meta ? meta.collide : false,
    params: { ...(meta ? meta.params : {}) },
  };
}
