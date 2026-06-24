// =====================================================================
//  In-game level editor (DEV ONLY).
//
//  A lightweight, Unity-lite editor for placing/transforming world objects
//  into an additive layer that is saved to a committed town.json. Activated
//  with the backtick (`) key. Never bundled into production: main.js only
//  imports this module behind `import.meta.env.DEV`.
//
//  initEditor(api) wires up:
//    - OrbitControls fly/orbit camera
//    - TransformControls gizmos (W/E/R = translate/rotate/scale) with grid snap
//    - raycast selection + click-to-place from the palette
//    - palette / hierarchy / properties UI panels
//    - Save (POST to dev middleware + localStorage), Export/Import JSON
// =====================================================================
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const DEG = Math.PI / 180;
const CACHE_KEY = 'penguin-town-level';
const round = (n, p = 1000) => Math.round(n * p) / p;
const hexStr = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);
const hexNum = (s) => parseInt(s.replace('#', ''), 16) >>> 0;

export function initEditor(api) {
  const {
    THREE, scene, camera, renderer, editorLayer, placedObjects,
    CATALOG, PALETTE, CATEGORIES, defaultDef, makeObject,
    COMPONENTS, COMPONENT_TYPES, defaultComponent,
    spawnDef, removeRecord, rebuildSolid, applyDefTransform, refreshObject, instantiateComponents,
    getLevelData, loadLevel, setEditorActive, isMultiplayer, toast,
  } = api;

  const dom = renderer.domElement;
  let active = false;
  let selected = null;       // placed record { id, def, obj }
  let pendingType = null;    // a type queued for click-to-place
  const savedCam = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() };

  // orbit pivot eases toward the selected object's origin (frames it on click,
  // so left-drag rotates around the selection until it's deselected)
  const DEFAULT_TARGET = new THREE.Vector3(0, 2, 0);
  const focusPivot = new THREE.Vector3(0, 2, 0);
  const lastPivot = new THREE.Vector3(0, 2, 0);
  let framing = false; // true while the camera is easing onto a new pivot

  // ---------- snap settings (Unity-style, adjustable + persisted) ----------
  const SNAP_KEY = 'penguin-town-snap';
  let snap = false, snapMove = 1, snapRotateDeg = 15, snapScale = 0.25;
  try {
    const s = JSON.parse(localStorage.getItem(SNAP_KEY) || '{}');
    if (typeof s.on === 'boolean') snap = s.on;
    if (s.move > 0) snapMove = s.move;
    if (s.rot > 0) snapRotateDeg = s.rot;
    if (s.scale > 0) snapScale = s.scale;
  } catch (e) { /* ignore */ }
  function persistSnap() {
    try { localStorage.setItem(SNAP_KEY, JSON.stringify({ on: snap, move: snapMove, rot: snapRotateDeg, scale: snapScale })); } catch (e) { /* ignore */ }
  }

  // ---------- undo / redo (snapshot-based history) ----------
  const undoStack = [];
  const redoStack = [];
  const HISTORY_MAX = 120;
  let restoring = false;

  function snapshot() { return JSON.stringify(getLevelData()); }
  // capture the pre-mutation state; call right before any edit
  function record() {
    if (restoring) return;
    const s = snapshot();
    if (undoStack.length && undoStack[undoStack.length - 1] === s) return; // dedupe
    undoStack.push(s);
    if (undoStack.length > HISTORY_MAX) undoStack.shift();
    redoStack.length = 0;
  }
  function applyState(json) {
    const keepId = selected ? selected.id : null;
    restoring = true;
    select(null);
    loadLevel(JSON.parse(json));
    restoring = false;
    refreshHierarchy();
    if (keepId) {
      const rec = placedObjects.find((r) => r.id === keepId);
      if (rec) select(rec);
    }
  }
  function undo() {
    if (!undoStack.length) { toast('↶ Nothing to undo'); return; }
    redoStack.push(snapshot());
    applyState(undoStack.pop());
  }
  function redo() {
    if (!redoStack.length) { toast('↷ Nothing to redo'); return; }
    undoStack.push(snapshot());
    applyState(redoStack.pop());
  }

  // ---------- controls ----------
  const orbit = new OrbitControls(camera, dom);
  orbit.enableDamping = true;
  orbit.dampingFactor = 0.08;
  orbit.maxPolarAngle = Math.PI * 0.495; // keep above the ground
  orbit.enabled = false;

  const gizmo = new TransformControls(camera, dom);
  gizmo.setMode('translate');
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = active && !e.value;
    if (e.value) record(); // checkpoint the state before a transform drag
  });
  gizmo.addEventListener('objectChange', onGizmoChange);
  scene.add(gizmo.getHelper());
  gizmo.enabled = false;

  const raycaster = new THREE.Raycaster();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const ndc = new THREE.Vector2();
  const hitPoint = new THREE.Vector3();

  // ---------- pick / place pointer handling ----------
  let down = null;        // { x, y }
  let downOnGizmo = false;

  function setNDC(e) {
    const r = dom.getBoundingClientRect();
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  }
  dom.addEventListener('pointerdown', (e) => {
    if (!active || e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
    downOnGizmo = !!gizmo.axis;
  });
  dom.addEventListener('pointerup', (e) => {
    if (!active || e.button !== 0 || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    const wasGizmo = downOnGizmo || gizmo.dragging;
    down = null; downOnGizmo = false;
    if (wasGizmo || moved > 5) return; // a drag (orbit or gizmo), not a click
    setNDC(e);
    raycaster.setFromCamera(ndc, camera);
    if (pendingType) {
      if (raycaster.ray.intersectPlane(groundPlane, hitPoint)) placeAt(hitPoint);
      return;
    }
    pickSelection();
  });

  function pickSelection() {
    const hits = raycaster.intersectObjects(editorLayer.children, true);
    if (!hits.length) { select(null); return; }
    let node = hits[0].object;
    while (node && node.parent !== editorLayer) node = node.parent;
    const rec = node ? placedObjects.find((r) => r.obj === node) : null;
    select(rec || null);
  }

  // ---------- placement / selection / mutation ----------
  function placeAt(point) {
    record();
    const def = defaultDef(pendingType);
    def.position = { x: round(point.x), y: 0, z: round(point.z) };
    const rec = spawnDef(def);
    rebuildSolid();
    setPending(null);
    select(rec);
    refreshHierarchy();
  }

  function select(rec) {
    selected = rec;
    if (rec) { gizmo.attach(rec.obj); gizmo.enabled = active; }
    else { gizmo.detach(); gizmo.enabled = false; }
    refreshProperties();
    highlightHierarchy();
  }

  function duplicateSelected() {
    if (!selected) return;
    record();
    const copy = JSON.parse(JSON.stringify(selected.def));
    copy.id = null;
    copy.position = { ...copy.position, x: (copy.position?.x ?? 0) + 2, z: (copy.position?.z ?? 0) + 2 };
    const rec = spawnDef(copy);
    rebuildSolid();
    select(rec);
    refreshHierarchy();
  }

  function deleteSelected() {
    if (!selected) return;
    record();
    const rec = selected;
    select(null);
    removeRecord(rec);
    rebuildSolid();
    refreshHierarchy();
  }

  function disposeObj(obj) {
    obj.traverse?.((m) => {
      if (!m.isMesh && !m.isSprite) return;
      m.geometry?.dispose?.();
      const mm = m.material;
      if (Array.isArray(mm)) mm.forEach((x) => { x.map?.dispose?.(); x.dispose?.(); });
      else if (mm) { mm.map?.dispose?.(); mm.dispose?.(); }
    });
  }

  // rebuild the visual + components for a placed object after its params change
  function rebuildObject(rec) {
    const wasSelected = selected === rec;
    if (wasSelected) gizmo.detach();
    refreshObject(rec); // engine-side: rebuilds visual, twinkles, and components
    if (wasSelected) { gizmo.attach(rec.obj); gizmo.enabled = active; }
  }

  function onGizmoChange() {
    if (!selected) return;
    const o = selected.obj, d = selected.def;
    d.position = { x: round(o.position.x), y: round(o.position.y), z: round(o.position.z) };
    d.rotation = { x: round(o.rotation.x, 1e4), y: round(o.rotation.y, 1e4), z: round(o.rotation.z, 1e4) };
    d.scale = { x: round(o.scale.x), y: round(o.scale.y), z: round(o.scale.z) };
    rebuildSolid();
    syncTransformInputs();
  }

  // ---------- snap ----------
  function applySnap() {
    if (snap) {
      gizmo.setTranslationSnap(snapMove > 0 ? snapMove : null);
      gizmo.setRotationSnap(snapRotateDeg > 0 ? snapRotateDeg * DEG : null);
      gizmo.setScaleSnap(snapScale > 0 ? snapScale : null);
    } else {
      gizmo.setTranslationSnap(null);
      gizmo.setRotationSnap(null);
      gizmo.setScaleSnap(null);
    }
    if (snapBtn) snapBtn.classList.toggle('on', snap);
  }
  function setSnap(on) { snap = on; applySnap(); persistSnap(); refreshSnapPanel(); }

  // ---------- activation ----------
  function activate() {
    if (isMultiplayer()) { toast('🚧 Editor is disabled during multiplayer.'); return; }
    if (active) return;
    active = true;
    setEditorActive(true);
    savedCam.pos.copy(camera.position);
    savedCam.quat.copy(camera.quaternion);
    camera.position.set(0, 48, 72);
    orbit.target.set(0, 2, 0);
    orbit.enabled = true;
    orbit.update();
    root.style.display = 'block';
    if (selected) { gizmo.attach(selected.obj); gizmo.enabled = true; }
    refreshHierarchy();
    refreshProperties();
    toast('🛠️ Editor on — ` to exit · W/E/R move/rotate/scale');
  }
  function deactivate() {
    if (!active) return;
    active = false;
    setEditorActive(false);
    setPending(null);
    gizmo.detach();
    gizmo.enabled = false;
    orbit.enabled = false;
    camera.position.copy(savedCam.pos);
    camera.quaternion.copy(savedCam.quat);
    root.style.display = 'none';
  }
  function toggle() { active ? deactivate() : activate(); }

  // ---------- keyboard ----------
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') { e.preventDefault(); toggle(); return; }
    if (!active) return;
    const typing = e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    // undo / redo — Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z (or Cmd/Ctrl+Y).
    // Skipped while typing so text fields keep their native undo.
    if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      if (typing) return;
      e.preventDefault();
      if (e.code === 'KeyY' || e.shiftKey) redo(); else undo();
      return;
    }
    if (typing) return;
    if (e.code === 'KeyW') { gizmo.setMode('translate'); refreshModeButtons(); }
    else if (e.code === 'KeyE') { gizmo.setMode('rotate'); refreshModeButtons(); }
    else if (e.code === 'KeyR') { gizmo.setMode('scale'); refreshModeButtons(); }
    else if (e.code === 'KeyG') { setSnap(!snap); }
    else if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.code === 'Escape') { if (pendingType) setPending(null); else select(null); }
    else if (e.code === 'KeyD' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); duplicateSelected(); }
  });

  // ---------- update loop (called from main's animate while active) ----------
  function update() {
    // Track where the camera should pivot: the selected object's origin, or the
    // default when nothing's selected. Re-frame on selection change or when the
    // object actually moves — but leave the pivot alone otherwise so panning works.
    if (!gizmo.dragging) {
      if (selected) selected.obj.getWorldPosition(focusPivot);
      else focusPivot.copy(DEFAULT_TARGET);
      if (focusPivot.distanceToSquared(lastPivot) > 1e-4) { framing = true; lastPivot.copy(focusPivot); }
      if (framing) {
        orbit.target.lerp(focusPivot, 0.2);
        if (orbit.target.distanceToSquared(focusPivot) < 1e-4) { orbit.target.copy(focusPivot); framing = false; }
      }
    }
    orbit.update();
  }

  // =====================================================================
  //  UI
  // =====================================================================
  const style = document.createElement('style');
  style.textContent = `
  #ed-root{position:fixed;inset:0;z-index:50;pointer-events:none;display:none;
    font:600 12px/1.3 "Baloo 2",system-ui,sans-serif;color:#eaf4ff}
  #ed-root .panel{position:absolute;pointer-events:auto;background:rgba(12,30,48,.92);
    border:1px solid rgba(120,180,230,.35);border-radius:12px;backdrop-filter:blur(8px);
    box-shadow:0 12px 40px rgba(0,0,0,.45);display:flex;flex-direction:column;overflow:hidden}
  #ed-root .panel h3{margin:0;padding:9px 12px;font-size:12px;letter-spacing:.4px;
    text-transform:uppercase;color:#9fd0ff;background:rgba(255,255,255,.05);
    border-bottom:1px solid rgba(120,180,230,.2)}
  #ed-palette{left:14px;top:14px;width:210px;max-height:46vh}
  #ed-hier{left:14px;bottom:14px;width:210px;max-height:40vh}
  #ed-props{right:14px;top:14px;width:248px;max-height:62vh}
  #ed-snap-panel{right:14px;bottom:14px;width:248px}
  #ed-root .scroll{overflow-y:auto;padding:8px}
  #ed-root .cat{color:#7fb0e0;font-size:10px;text-transform:uppercase;margin:6px 4px 3px;letter-spacing:.5px}
  #ed-root button{font:inherit;color:#eaf4ff;background:rgba(40,80,120,.6);
    border:1px solid rgba(120,180,230,.3);border-radius:8px;padding:6px 8px;cursor:pointer}
  #ed-root button:hover{background:rgba(60,110,160,.7)}
  #ed-root button.on{background:#3a7fc0;border-color:#9fd0ff}
  #ed-palette .grid{display:grid;grid-template-columns:1fr 1fr;gap:5px}
  #ed-palette button.sel{background:#c06a2a;border-color:#ffcf3a}
  #ed-hier .item{display:flex;justify-content:space-between;align-items:center;
    padding:5px 7px;border-radius:7px;cursor:pointer}
  #ed-hier .item:hover{background:rgba(255,255,255,.07)}
  #ed-hier .item.sel{background:rgba(192,106,42,.55)}
  #ed-hier .item small{color:#8fb6dc}
  #ed-props .row,#ed-snap-panel .row{display:flex;align-items:center;gap:6px;margin:5px 0}
  #ed-props label,#ed-snap-panel label{width:64px;color:#9fd0ff;flex:0 0 auto}
  #ed-props input[type=number],#ed-props input[type=text],
  #ed-snap-panel input[type=number]{width:100%;background:rgba(8,20,34,.8);
    border:1px solid rgba(120,180,230,.3);border-radius:6px;color:#eaf4ff;padding:4px 6px}
  #ed-snap-panel .hintline{color:#7fb0e0;font-size:10px;margin:2px 4px 0;text-align:center}
  #ed-props .vec{display:flex;gap:4px}
  #ed-props .vec input{width:33%}
  #ed-props input[type=color]{width:34px;height:24px;border:none;background:none;padding:0;cursor:pointer}
  #ed-props .empty{color:#8fb6dc;padding:6px;text-align:center}
  #ed-root .bar{display:flex;gap:5px;flex-wrap:wrap;padding:8px;border-top:1px solid rgba(120,180,230,.2)}
  #ed-root .bar button{flex:1 1 auto}
  #ed-hint{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);pointer-events:none;
    background:rgba(192,106,42,.92);color:#fff;padding:6px 14px;border-radius:999px;display:none}
  `;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = 'ed-root';
  root.innerHTML = `
    <div class="panel" id="ed-palette">
      <h3>Palette</h3>
      <div class="scroll" id="ed-palette-list"></div>
    </div>
    <div class="panel" id="ed-hier">
      <h3>Objects</h3>
      <div class="scroll" id="ed-hier-list"></div>
      <div class="bar">
        <button id="ed-undo" title="Undo (⌘Z)">↶</button>
        <button id="ed-redo" title="Redo (⌘⇧Z)">↷</button>
        <button id="ed-save">💾 Save</button>
        <button id="ed-export">Export</button>
        <button id="ed-import">Import</button>
      </div>
    </div>
    <div class="panel" id="ed-props">
      <h3>Properties</h3>
      <div class="scroll" id="ed-props-body"></div>
      <div class="bar">
        <button id="ed-mode-t" class="on">Move (W)</button>
        <button id="ed-mode-r">Rotate (E)</button>
        <button id="ed-mode-s">Scale (R)</button>
        <button id="ed-snap">Snap (G)</button>
      </div>
    </div>
    <div class="panel" id="ed-snap-panel">
      <h3>Snap</h3>
      <div class="scroll">
        <div class="row"><label>Snap (G)</label><input type="checkbox" id="ed-snap-on"></div>
        <div class="row"><label>Move</label><input type="number" id="ed-snap-move" step="0.25" min="0"></div>
        <div class="row"><label>Rotate°</label><input type="number" id="ed-snap-rot" step="1" min="0"></div>
        <div class="row"><label>Scale</label><input type="number" id="ed-snap-scale" step="0.05" min="0"></div>
        <div class="hintline">0 = no snap on that axis</div>
      </div>
    </div>
    <div id="ed-hint"></div>
    <input type="file" id="ed-file" accept="application/json" style="display:none">
  `;
  document.body.appendChild(root);

  const paletteList = root.querySelector('#ed-palette-list');
  const hierList = root.querySelector('#ed-hier-list');
  const propsBody = root.querySelector('#ed-props-body');
  const hint = root.querySelector('#ed-hint');
  const snapBtn = root.querySelector('#ed-snap');
  const modeT = root.querySelector('#ed-mode-t');
  const modeR = root.querySelector('#ed-mode-r');
  const modeS = root.querySelector('#ed-mode-s');
  const fileInput = root.querySelector('#ed-file');
  const undoBtn = root.querySelector('#ed-undo');
  const redoBtn = root.querySelector('#ed-redo');
  const snapOnInput = root.querySelector('#ed-snap-on');
  const snapMoveInput = root.querySelector('#ed-snap-move');
  const snapRotInput = root.querySelector('#ed-snap-rot');
  const snapScaleInput = root.querySelector('#ed-snap-scale');

  // ----- snap panel -----
  function refreshSnapPanel() {
    snapOnInput.checked = snap;
    snapMoveInput.value = snapMove;
    snapRotInput.value = snapRotateDeg;
    snapScaleInput.value = snapScale;
  }
  snapOnInput.addEventListener('change', () => setSnap(snapOnInput.checked));
  snapMoveInput.addEventListener('input', () => { snapMove = Math.max(0, parseFloat(snapMoveInput.value) || 0); applySnap(); persistSnap(); });
  snapRotInput.addEventListener('input', () => { snapRotateDeg = Math.max(0, parseFloat(snapRotInput.value) || 0); applySnap(); persistSnap(); });
  snapScaleInput.addEventListener('input', () => { snapScale = Math.max(0, parseFloat(snapScaleInput.value) || 0); applySnap(); persistSnap(); });
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  // checkpoint the state whenever the user starts editing a property field
  propsBody.addEventListener('focusin', () => record());
  refreshSnapPanel();
  applySnap();

  // ----- palette -----
  function buildPalette() {
    paletteList.innerHTML = '';
    for (const cat of CATEGORIES) {
      const label = document.createElement('div');
      label.className = 'cat';
      label.textContent = cat;
      paletteList.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const type of PALETTE) {
        if (CATALOG[type].category !== cat) continue;
        const b = document.createElement('button');
        b.textContent = CATALOG[type].label;
        b.dataset.type = type;
        b.addEventListener('click', () => setPending(pendingType === type ? null : type));
        grid.appendChild(b);
      }
      paletteList.appendChild(grid);
    }
  }
  function setPending(type) {
    pendingType = type;
    paletteList.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.type === type));
    if (type) { hint.textContent = `Click the ground to place: ${CATALOG[type].label} (Esc to cancel)`; hint.style.display = 'block'; }
    else hint.style.display = 'none';
  }

  // ----- hierarchy -----
  function refreshHierarchy() {
    hierList.innerHTML = '';
    if (!placedObjects.length) {
      hierList.innerHTML = '<div class="empty" style="color:#8fb6dc;text-align:center;padding:6px">No placed objects yet.</div>';
      return;
    }
    placedObjects.forEach((rec, i) => {
      const item = document.createElement('div');
      item.className = 'item' + (rec === selected ? ' sel' : '');
      const name = rec.def.name || CATALOG[rec.def.type]?.label || rec.def.type;
      const span = document.createElement('span');
      span.textContent = name;
      const tag = document.createElement('small');
      tag.textContent = CATALOG[rec.def.type]?.label || rec.def.type;
      item.appendChild(span); item.appendChild(tag);
      item.addEventListener('click', () => { select(rec); focusOn(rec); });
      hierList.appendChild(item);
    });
  }
  function highlightHierarchy() {
    [...hierList.children].forEach((c, i) => c.classList?.toggle('sel', placedObjects[i] === selected));
  }
  function focusOn(rec) {
    orbit.target.set(rec.obj.position.x, rec.obj.position.y + 1, rec.obj.position.z);
    orbit.update();
  }

  // ----- properties -----
  function refreshProperties() {
    propsBody.innerHTML = '';
    if (!selected) {
      propsBody.innerHTML = '<div class="empty">Select an object, or pick from the palette and click the ground.</div>';
      return;
    }
    const d = selected.def;
    const meta = CATALOG[d.type];
    const title = document.createElement('div');
    title.style.cssText = 'font-size:11px;color:#7fb0e0;text-transform:uppercase;letter-spacing:.4px;margin:2px 0 6px';
    title.textContent = meta?.label || d.type;
    propsBody.appendChild(title);

    // editable name
    const nameRow = document.createElement('div'); nameRow.className = 'row';
    const nameLabel = document.createElement('label'); nameLabel.textContent = 'Name';
    const nameInput = document.createElement('input'); nameInput.type = 'text';
    nameInput.value = d.name || '';
    nameInput.placeholder = meta?.label || d.type;
    nameInput.addEventListener('input', () => { d.name = nameInput.value; refreshHierarchy(); });
    nameRow.appendChild(nameLabel); nameRow.appendChild(nameInput);
    propsBody.appendChild(nameRow);

    propsBody.appendChild(vecRow('Position', 'position', ['x', 'y', 'z'], 0.5));
    propsBody.appendChild(vecRow('Rotation°', 'rotation', ['x', 'y', 'z'], 1, true));
    propsBody.appendChild(vecRow('Scale', 'scale', ['x', 'y', 'z'], 0.1));

    // collision toggle
    const cRow = document.createElement('div');
    cRow.className = 'row';
    const cLabel = document.createElement('label'); cLabel.textContent = 'Collision';
    const cBox = document.createElement('input'); cBox.type = 'checkbox';
    cBox.checked = d.collide ?? meta?.collide ?? false;
    cBox.addEventListener('change', () => { d.collide = cBox.checked; rebuildSolid(); });
    cRow.appendChild(cLabel); cRow.appendChild(cBox);
    propsBody.appendChild(cRow);

    // type-specific params
    for (const p of (meta?.schema || [])) propsBody.appendChild(paramRow(d, p));

    // actions
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;margin-top:10px';
    const dup = document.createElement('button'); dup.textContent = '⧉ Duplicate'; dup.style.flex = '1';
    dup.addEventListener('click', duplicateSelected);
    const del = document.createElement('button'); del.textContent = '🗑 Delete'; del.style.flex = '1';
    del.style.background = 'rgba(150,40,40,.6)';
    del.addEventListener('click', deleteSelected);
    actions.appendChild(dup); actions.appendChild(del);
    propsBody.appendChild(actions);

    buildComponentsSection(d);
  }

  // ----- components (scripts) -----
  function buildComponentsSection(d) {
    if (!d.components) d.components = [];
    const hdr = document.createElement('div');
    hdr.style.cssText = 'margin:14px 0 4px;font-size:11px;color:#7fb0e0;text-transform:uppercase;letter-spacing:.4px;border-top:1px solid rgba(120,180,230,.2);padding-top:10px';
    hdr.textContent = 'Scripts';
    propsBody.appendChild(hdr);

    d.components.forEach((comp, ci) => {
      const meta = COMPONENTS[comp.type];
      const card = document.createElement('div');
      card.style.cssText = 'background:rgba(255,255,255,.05);border:1px solid rgba(120,180,230,.2);border-radius:8px;padding:6px 8px;margin:6px 0';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
      const name = document.createElement('b'); name.textContent = meta?.label || comp.type; name.style.color = '#ffcf8a';
      const rm = document.createElement('button'); rm.textContent = '✕'; rm.style.cssText = 'padding:2px 7px;background:rgba(150,40,40,.5)';
      rm.addEventListener('click', () => {
        d.components.splice(ci, 1);
        instantiateComponents(selected);
        refreshProperties();
      });
      top.appendChild(name); top.appendChild(rm);
      card.appendChild(top);
      if (!comp.params) comp.params = {};
      for (const p of (meta?.schema || [])) card.appendChild(componentParamRow(comp, p));
      propsBody.appendChild(card);
    });

    // add-component dropdown
    const addRow = document.createElement('div'); addRow.style.cssText = 'display:flex;gap:6px;margin-top:6px';
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:1;background:rgba(8,20,34,.8);border:1px solid rgba(120,180,230,.3);border-radius:6px;color:#eaf4ff;padding:4px';
    const ph = document.createElement('option'); ph.value = ''; ph.textContent = '+ Add Script…'; sel.appendChild(ph);
    for (const type of COMPONENT_TYPES) {
      const o = document.createElement('option'); o.value = type; o.textContent = COMPONENTS[type].label; sel.appendChild(o);
    }
    sel.addEventListener('change', () => {
      if (!sel.value) return;
      d.components.push(defaultComponent(sel.value));
      instantiateComponents(selected);
      refreshProperties();
    });
    addRow.appendChild(sel);
    propsBody.appendChild(addRow);
  }

  function componentParamRow(comp, p) {
    const row = document.createElement('div'); row.className = 'row';
    const l = document.createElement('label'); l.textContent = p.label; row.appendChild(l);
    const cur = comp.params[p.key] ?? p.default;
    const commit = (v) => { comp.params[p.key] = v; instantiateComponents(selected); };
    if (p.type === 'color') {
      const inp = document.createElement('input'); inp.type = 'color'; inp.value = hexStr(cur);
      inp.addEventListener('input', () => commit(hexNum(inp.value)));
      row.appendChild(inp);
    } else if (p.type === 'number') {
      const inp = document.createElement('input'); inp.type = 'number'; inp.step = p.step ?? 0.1;
      if (p.min != null) inp.min = p.min; if (p.max != null) inp.max = p.max;
      inp.value = cur;
      inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!Number.isNaN(v)) commit(v); });
      row.appendChild(inp);
    } else if (p.type === 'bool') {
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!cur;
      inp.addEventListener('change', () => commit(inp.checked));
      row.appendChild(inp);
    } else if (p.type === 'select') {
      const inp = document.createElement('select');
      inp.style.cssText = 'flex:1;background:rgba(8,20,34,.8);border:1px solid rgba(120,180,230,.3);border-radius:6px;color:#eaf4ff;padding:3px';
      for (const o of p.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === cur) op.selected = true; inp.appendChild(op); }
      inp.addEventListener('change', () => commit(inp.value));
      row.appendChild(inp);
    } else {
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = cur;
      inp.addEventListener('change', () => commit(inp.value));
      row.appendChild(inp);
    }
    return row;
  }

  function vecRow(label, key, comps, step, isDeg = false) {
    const row = document.createElement('div'); row.className = 'row';
    const l = document.createElement('label'); l.textContent = label; row.appendChild(l);
    const wrap = document.createElement('div'); wrap.className = 'vec'; wrap.style.flex = '1';
    for (const c of comps) {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.step = step;
      inp.dataset.key = key; inp.dataset.comp = c;
      const raw = selected.def[key]?.[c] ?? (key === 'scale' ? 1 : 0);
      inp.value = isDeg ? round(raw / DEG, 10) : raw;
      inp.addEventListener('input', () => {
        let v = parseFloat(inp.value);
        if (Number.isNaN(v)) return;
        if (isDeg) v *= DEG;
        if (!selected.def[key]) selected.def[key] = {};
        selected.def[key][c] = v;
        applyDefTransform(selected.obj, selected.def);
        rebuildSolid();
      });
      wrap.appendChild(inp);
    }
    row.appendChild(wrap);
    return row;
  }

  function paramRow(d, p) {
    const row = document.createElement('div'); row.className = 'row';
    const l = document.createElement('label'); l.textContent = p.label; row.appendChild(l);
    if (!d.params) d.params = {};
    const cur = d.params[p.key] ?? p.default;
    if (p.type === 'color') {
      const inp = document.createElement('input'); inp.type = 'color';
      inp.value = hexStr(cur);
      inp.addEventListener('input', () => { d.params[p.key] = hexNum(inp.value); rebuildObject(selected); });
      row.appendChild(inp);
    } else if (p.type === 'number') {
      const inp = document.createElement('input'); inp.type = 'number';
      inp.step = p.step ?? 0.5; if (p.min != null) inp.min = p.min; if (p.max != null) inp.max = p.max;
      inp.value = cur;
      inp.addEventListener('change', () => {
        let v = parseFloat(inp.value); if (Number.isNaN(v)) return;
        d.params[p.key] = v; rebuildObject(selected); rebuildSolid();
      });
      row.appendChild(inp);
    } else if (p.type === 'bool') {
      const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!cur;
      inp.addEventListener('change', () => { d.params[p.key] = inp.checked; rebuildObject(selected); });
      row.appendChild(inp);
    } else { // text
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = cur;
      inp.addEventListener('change', () => { d.params[p.key] = inp.value; rebuildObject(selected); });
      row.appendChild(inp);
    }
    return row;
  }

  // update only the transform input values (during gizmo drag) without rebuilding DOM
  function syncTransformInputs() {
    if (!selected) return;
    propsBody.querySelectorAll('input[data-key]').forEach((inp) => {
      const key = inp.dataset.key, c = inp.dataset.comp;
      let v = selected.def[key]?.[c] ?? 0;
      if (key === 'rotation') v = round(v / DEG, 10);
      if (document.activeElement !== inp) inp.value = v;
    });
  }

  // ----- mode buttons -----
  function refreshModeButtons() {
    modeT.classList.toggle('on', gizmo.mode === 'translate');
    modeR.classList.toggle('on', gizmo.mode === 'rotate');
    modeS.classList.toggle('on', gizmo.mode === 'scale');
  }
  modeT.addEventListener('click', () => { gizmo.setMode('translate'); refreshModeButtons(); });
  modeR.addEventListener('click', () => { gizmo.setMode('rotate'); refreshModeButtons(); });
  modeS.addEventListener('click', () => { gizmo.setMode('scale'); refreshModeButtons(); });
  snapBtn.addEventListener('click', () => setSnap(!snap));

  // ----- persistence -----
  async function save() {
    const data = getLevelData();
    const json = JSON.stringify(data, null, 2);
    try { localStorage.setItem(CACHE_KEY, json); } catch (e) { /* quota */ }
    try {
      const res = await fetch('/__save-level', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      toast('💾 Saved to src/levels/town.json — commit & push to ship it.');
    } catch (e) {
      // Most often this means the dev-save middleware isn't running (stale dev
      // server). Fall back to a direct download so a save never gets lost.
      console.error('[editor] direct save failed; downloading instead', e);
      downloadJSON(json);
      toast('⚠️ Direct save failed (restart `npm run dev`). Downloaded town.json — drop it into src/levels/.');
    }
  }
  function downloadJSON(json) {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'town.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function exportJSON() {
    downloadJSON(JSON.stringify(getLevelData(), null, 2));
  }
  function importJSON(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        record();
        select(null);
        loadLevel(data);
        refreshHierarchy();
        toast('📂 Imported level.');
      } catch (e) { toast('⚠️ Invalid level JSON.'); console.error(e); }
    };
    reader.readAsText(file);
  }
  root.querySelector('#ed-save').addEventListener('click', save);
  root.querySelector('#ed-export').addEventListener('click', exportJSON);
  root.querySelector('#ed-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) importJSON(fileInput.files[0]); fileInput.value = ''; });

  // ----- init -----
  buildPalette();
  refreshHierarchy();
  refreshProperties();
  applySnap();

  return { update, get active() { return active; }, activate, deactivate, toggle };
}
