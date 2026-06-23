import * as THREE from 'three';
import {
  startMultiplayer, mpActive, mpPlayerCount, setLocalState, eachRemote, onRemoteLeave,
  mpRoomCode, mpInviteUrl, mpIsHost, mpMyId, setGlobal, getGlobal, setMyState, eachRemoteState,
} from './multiplayer.js';

// =====================================================================
//  Penguin Town 3D — a cozy, original snowy social-world prototype.
//  (Inspired by classic browser hangouts. No Club Penguin assets used.)
// =====================================================================

// ---------- renderer / scene / camera ----------
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xbfe9ff, 60, 190);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.set(0, 5, 11);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
document.body.appendChild(renderer.domElement);

const clock = new THREE.Clock();
const world = new THREE.Group();
scene.add(world);

// =====================================================================
//  Sound effects — fully synthesized with the Web Audio API.
//  No external files/CDN needed, so it works offline & adds no deps.
// =====================================================================
const sfx = (() => {
  let ctx = null, master = null, sfxBus = null, musBus = null, ambBus = null, enabled = true;
  let ambNodes = null;
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.6; master.connect(ctx.destination);
      sfxBus = ctx.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
      musBus = ctx.createGain(); musBus.gain.value = 0.0; musBus.connect(master);
      ambBus = ctx.createGain(); ambBus.gain.value = 0.0; ambBus.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function noiseBuf(dur) {
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function env(g, t, a, peak, d) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  function tone(freq, t, dur, type = 'sine', peak = 0.3, slideTo = null, dest = null) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    env(g, t, 0.005, peak, dur);
    o.connect(g).connect(dest || sfxBus); o.start(t); o.stop(t + dur + 0.06);
  }
  function noise(dur, t, peak, type = 'lowpass', freq = 2000, q = 1, dest = null) {
    const src = ctx.createBufferSource(); src.buffer = noiseBuf(dur);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.003, peak, dur);
    src.connect(f).connect(g).connect(dest || sfxBus); src.start(t); src.stop(t + dur + 0.06);
    return { src, f, g };
  }
  function go(fn) { if (!enabled || !ensure()) return; fn(ctx.currentTime); }

  // ---- ambient wind/snow bed (continuous, gently modulated) ----
  function startAmbient() {
    if (!ensure() || ambNodes) return;
    const src = ctx.createBufferSource(); src.buffer = noiseBuf(2.5); src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 400; f.Q.value = 0.5;
    src.connect(f).connect(ambBus); src.start();
    const lfo = ctx.createOscillator(); const lg = ctx.createGain();
    lfo.frequency.value = 0.06; lg.gain.value = 200; lfo.connect(lg).connect(f.frequency); lfo.start();
    ambBus.gain.setTargetAtTime(0.16, ctx.currentTime, 2.5);
    ambNodes = { src, f, lfo };
  }
  function setTension(level) { // 0..1 thickens ambient bed during the horde
    if (ambBus) ambBus.gain.setTargetAtTime(0.16 + level * 0.16, ctx.currentTime, 1.5);
  }

  // ---- procedural music sequencer (cozy ↔ combat) ----
  const music = {
    timer: null, step: 0, mood: 'cozy',
    start(m) { if (!ensure()) return; this.mood = m || 'cozy'; musBus.gain.setTargetAtTime(0.32, ctx.currentTime, 1.5); if (!this.timer) this.loop(); },
    setMood(m) { this.mood = m; },
    loop() { this.playStep(); const ms = this.mood === 'combat' ? 150 : 320; this.timer = setTimeout(() => this.loop(), ms); },
    playStep() {
      if (!enabled || !ctx) { this.step++; return; }
      const t = ctx.currentTime + 0.02, s = this.step;
      if (this.mood === 'combat') {
        const bass = [55, 55, 82.41, 55, 49, 49, 73.42, 49];
        tone(bass[s % bass.length], t, 0.14, 'sawtooth', 0.5, null, musBus);
        if (s % 2 === 0) noise(0.04, t, 0.22, 'highpass', 7000, 1, musBus); // hi-hat
        if (s % 4 === 0) tone([220, 261.63, 329.63][Math.floor(Math.random() * 3)], t, 0.18, 'square', 0.16, null, musBus);
        if (s % 8 === 0) noise(0.12, t, 0.4, 'lowpass', 200, 1, musBus); // kick
      } else {
        const lead = [523.25, 659.25, 783.99, 659.25, 587.33, 493.88];
        if (s % 2 === 0) tone(lead[(s / 2) % lead.length], t, 0.55, 'triangle', 0.18, null, musBus);
        const bass = [130.81, 0, 196, 0, 174.61, 0, 220, 0];
        const bf = bass[s % bass.length]; if (bf) tone(bf, t, 0.5, 'sine', 0.26, null, musBus);
      }
      this.step++;
    },
  };

  return {
    resume() { ensure(); },
    startWorld() { ensure(); startAmbient(); music.start('cozy'); },
    combatMusic() { music.setMood('combat'); setTension(0.5); },
    calmMusic() { music.setMood('cozy'); setTension(0); },
    tension(l) { setTension(Math.min(1, l)); },
    toggle() { enabled = !enabled; if (ensure()) master.gain.setTargetAtTime(enabled ? 0.6 : 0, ctx.currentTime, 0.05); return enabled; },
    // ---- one-shots ----
    shot() { go((t) => { noise(0.12, t, 0.5, 'highpass', 950, 0.7); noise(0.18, t, 0.4, 'lowpass', 1500); tone(170, t, 0.12, 'square', 0.22, 60); }); },
    dryFire() { go((t) => tone(220, t, 0.04, 'square', 0.14)); },
    reload() { go((t) => { tone(300, t, 0.05, 'square', 0.2, 180); tone(420, t + 0.16, 0.05, 'square', 0.2, 260); tone(540, t + 0.38, 0.06, 'square', 0.22, 320); }); },
    explosion() { go((t) => { const N = noise(0.6, t, 0.75, 'lowpass', 1000); N.f.frequency.setValueAtTime(1200, t); N.f.frequency.exponentialRampToValueAtTime(120, t + 0.5); tone(68, t, 0.5, 'sine', 0.5, 38); }); },
    // dry mechanical "tick" — sharp, not musical
    hit() { go((t) => { noise(0.02, t, 0.6, 'bandpass', 2600, 7); tone(1100, t, 0.03, 'square', 0.24, 620); }); },
    // meaty downward "thunk" + deep body thump (satisfying, not happy)
    kill() { go((t) => { noise(0.05, t, 0.5, 'highpass', 2400); tone(430, t, 0.12, 'square', 0.34, 120); tone(88, t, 0.18, 'sine', 0.42, 52); }); },
    // headshot: harder hit — sharp metallic tink over a heavy boom
    headshotKill() { go((t) => { noise(0.06, t, 0.55, 'highpass', 3000); tone(2000, t, 0.04, 'square', 0.3, 900); tone(360, t, 0.15, 'square', 0.34, 100); tone(74, t, 0.24, 'sine', 0.48, 46); }); },
    bossDeath() { go((t) => { const N = noise(0.8, t, 0.7, 'lowpass', 900); N.f.frequency.exponentialRampToValueAtTime(90, t + 0.7); tone(150, t, 0.8, 'sawtooth', 0.4, 45); tone(90, t + 0.1, 0.7, 'sine', 0.4, 40); }); },
    hurt() { go((t) => { noise(0.18, t, 0.32, 'lowpass', 900); tone(200, t, 0.18, 'sawtooth', 0.16, 90); }); },
    cash() { go((t) => tone(880, t, 0.06, 'triangle', 0.16, 1320)); },
    med() { go((t) => { tone(660, t, 0.1, 'sine', 0.2); tone(990, t + 0.1, 0.14, 'sine', 0.2); }); },
    upgrade() { go((t) => [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.07, 0.12, 'triangle', 0.18))); },
    round() { go((t) => { tone(110, t, 0.7, 'sawtooth', 0.22, 78); tone(165, t, 0.7, 'sine', 0.16); }); },
    waveCleared() { go((t) => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.1, 0.2, 'triangle', 0.2))); },
    groan() { go((t) => { tone(80 + Math.random() * 45, t, 0.5, 'sawtooth', 0.1, 52); tone(120 + Math.random() * 40, t, 0.4, 'sine', 0.06, 70); }); },
    snowball() { go((t) => noise(0.1, t, 0.18, 'highpass', 1500)); },
    splat() { go((t) => { noise(0.16, t, 0.3, 'lowpass', 1200); tone(180, t, 0.1, 'sawtooth', 0.12, 80); }); },
    iceCrack() { go((t) => { noise(0.09, t, 0.4, 'highpass', 4200, 0.8); tone(1900, t, 0.06, 'triangle', 0.2, 2700); tone(950, t + 0.03, 0.1, 'triangle', 0.13, 1500); }); },
    freeze() { go((t) => { tone(1500, t, 0.55, 'sine', 0.2, 320); noise(0.45, t, 0.2, 'bandpass', 3000, 5); tone(720, t + 0.05, 0.45, 'triangle', 0.13, 220); }); },
    jump() { go((t) => tone(320, t, 0.12, 'sine', 0.16, 620)); },
    land() { go((t) => { noise(0.1, t, 0.22, 'lowpass', 600); tone(140, t, 0.08, 'sine', 0.12, 80); }); },
    step(alt) { go((t) => noise(0.05, t, 0.12, 'lowpass', alt ? 520 : 380, 0.8)); },
    emote() { go((t) => tone(720, t, 0.08, 'triangle', 0.14, 1080)); },
    pickup() { go((t) => { tone(440, t, 0.05, 'square', 0.18, 660); noise(0.05, t + 0.05, 0.18, 'highpass', 3000); tone(880, t + 0.1, 0.1, 'triangle', 0.16); }); },
    combo(n) { go((t) => { const base = Math.min(1300, 480 + n * 48); noise(0.03, t, 0.28, 'bandpass', base, 6); tone(base, t, 0.06, 'square', 0.2, base * 0.7); }); },
    death() { go((t) => { tone(440, t, 1.1, 'sawtooth', 0.3, 70); noise(0.8, t, 0.3, 'lowpass', 700); }); },
    uiClick() { go((t) => tone(660, t, 0.05, 'square', 0.12, 880)); },
  };
})();

// ---------- palette ----------
const PENGUIN_COLORS = [
  { name: 'Blueberry', hex: 0x2f7fe0 },
  { name: 'Cherry', hex: 0xe5384d },
  { name: 'Lime', hex: 0x35c45f },
  { name: 'Bubblegum', hex: 0xff7ec8 },
  { name: 'Sunshine', hex: 0xffcb2e },
  { name: 'Grape', hex: 0x9b5de5 },
  { name: 'Tangerine', hex: 0xff8c3b },
  { name: 'Mint', hex: 0x2ec9b8 },
  { name: 'Midnight', hex: 0x2c3142 },
  { name: 'Coral', hex: 0xff6f61 },
];
const EMOTES = ['😄', '❤️', '🎉', '🎵', '😎', '🐟', '😮', '👋'];

// ---------- UI refs ----------
const ui = {
  overlay: document.querySelector('#overlay'),
  startButton: document.querySelector('#start-button'),
  nameInput: document.querySelector('#penguin-name'),
  swatches: document.querySelector('#color-swatches'),
  crosshair: document.querySelector('#crosshair'),
  actionBar: document.querySelector('#action-bar'),
  online: document.querySelector('#online-count'),
  snowballCount: document.querySelector('#snowball-count'),
  toast: document.querySelector('#toast'),
};

// ---------- styles (CP-flavored, chunky + rounded) ----------
const style = document.createElement('style');
style.textContent = `
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow: hidden; width: 100%; height: 100%; background: #bfe9ff;
    font-family: "Baloo 2", "Nunito", ui-rounded, "Segoe UI", system-ui, sans-serif; }
  canvas { display: block; }

  #hud { position: fixed; top: 16px; left: 18px; z-index: 5; pointer-events: none; color: #fff;
    text-shadow: 0 2px 10px rgba(11,46,72,.5); }
  .brand { font-size: 22px; font-weight: 900; letter-spacing: .04em; }
  #location { margin-top: 10px; display: inline-block; padding: 7px 14px; border-radius: 999px;
    background: rgba(11,76,112,.45); border: 2px solid rgba(255,255,255,.55); font-weight: 800; font-size: 14px;
    backdrop-filter: blur(4px); }

  #status { position: fixed; top: 16px; right: 18px; z-index: 5; display: flex; gap: 8px; pointer-events: none; }
  .status-pill { display: flex; align-items: center; gap: 7px; padding: 7px 13px; border-radius: 999px;
    background: rgba(11,76,112,.45); border: 2px solid rgba(255,255,255,.5); color: #fff; font-weight: 800;
    font-size: 13px; text-shadow: 0 1px 6px rgba(0,0,0,.3); backdrop-filter: blur(4px); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #5dff9c; box-shadow: 0 0 8px #5dff9c; }

  #crosshair { position: fixed; left: 50%; top: 50%; width: 22px; height: 22px; transform: translate(-50%,-50%);
    border: 2px solid rgba(255,255,255,.9); border-radius: 50%; display: none; z-index: 6; pointer-events: none;
    box-shadow: 0 0 0 2px rgba(0,0,0,.15), inset 0 0 6px rgba(0,0,0,.2); }
  #crosshair::after { content: ""; position: absolute; left: 50%; top: 50%; width: 3px; height: 3px;
    transform: translate(-50%,-50%); background: #fff; border-radius: 50%; }

  #toast { position: fixed; top: 86px; left: 50%; transform: translateX(-50%) translateY(-12px); z-index: 7;
    display: flex; flex-direction: column; gap: 8px; align-items: center; pointer-events: none; }
  .toast-msg { padding: 9px 16px; border-radius: 999px; background: rgba(11,76,112,.82); color: #fff;
    font-weight: 800; font-size: 14px; border: 2px solid rgba(255,255,255,.4); box-shadow: 0 8px 22px rgba(8,46,72,.35);
    opacity: 0; transform: translateY(-8px); animation: toastIn .25s ease forwards; white-space: nowrap; }
  .toast-msg.out { animation: toastOut .35s ease forwards; }
  @keyframes toastIn { to { opacity: 1; transform: translateY(0); } }
  @keyframes toastOut { to { opacity: 0; transform: translateY(-10px); } }

  #action-bar { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 6;
    display: flex; gap: 8px; padding: 8px; border-radius: 18px; background: rgba(11,76,112,.4);
    border: 2px solid rgba(255,255,255,.4); backdrop-filter: blur(6px); opacity: 0; transition: opacity .3s; }
  #action-bar.show { opacity: 1; }
  .emote-btn { width: 46px; height: 46px; border: none; border-radius: 13px; cursor: pointer; font-size: 23px;
    background: rgba(255,255,255,.92); box-shadow: inset 0 -3px 0 rgba(0,0,0,.12), 0 4px 10px rgba(8,46,72,.25);
    transition: transform .08s; position: relative; }
  .emote-btn:hover { transform: translateY(-3px); }
  .emote-btn:active { transform: translateY(0); }
  .emote-btn .key { position: absolute; bottom: -2px; right: 2px; font-size: 9px; font-weight: 900; color: #0b4c70; opacity: .65; }

  #controls { position: fixed; bottom: 18px; left: 18px; z-index: 5; display: flex; flex-direction: column; gap: 3px;
    color: #fff; font-size: 12px; text-shadow: 0 1px 6px rgba(0,0,0,.4); pointer-events: none; opacity: .9; }
  #controls b { color: #ffe48a; }

  #overlay { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center;
    background: radial-gradient(120% 120% at 50% 0%, rgba(120,200,250,.35), rgba(40,90,140,.55));
    backdrop-filter: blur(3px); }
  #start-card { position: relative; width: min(440px, calc(100vw - 32px)); padding: 32px 30px 26px;
    text-align: center; color: #123a55; border-radius: 28px; overflow: hidden;
    background: linear-gradient(180deg, #ffffff, #eaf7ff);
    border: 3px solid #fff; box-shadow: 0 30px 80px rgba(13,58,89,.45); }
  .card-glow { position: absolute; top: -60px; left: 50%; transform: translateX(-50%); width: 260px; height: 160px;
    background: radial-gradient(closest-side, rgba(120,210,255,.6), transparent); filter: blur(8px); }
  .card-icon { font-size: 58px; line-height: 1; filter: drop-shadow(0 6px 10px rgba(13,58,89,.3)); animation: bob 2.4s ease-in-out infinite; }
  @keyframes bob { 0%,100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-8px) rotate(3deg); } }
  #start-card h1 { margin: 8px 0 8px; font-size: 30px; font-weight: 900; line-height: 1.05; }
  #start-card p { margin: 0 auto 18px; max-width: 340px; line-height: 1.45; color: #3a6178; font-weight: 600; }
  .field-label { text-align: left; font-weight: 800; font-size: 13px; color: #2c5872; margin: 4px 2px 7px; }
  #penguin-name { width: 100%; padding: 12px 14px; margin-bottom: 16px; border-radius: 13px; border: 2px solid #b9def0;
    background: #fff; font: inherit; font-weight: 700; color: #123a55; outline: none; transition: border-color .15s; }
  #penguin-name:focus { border-color: #2f9fd8; }
  #color-swatches { display: grid; grid-template-columns: repeat(5, 1fr); gap: 9px; margin-bottom: 22px; }
  .swatch { aspect-ratio: 1; border-radius: 50%; cursor: pointer; border: 3px solid transparent;
    box-shadow: inset 0 -4px 0 rgba(0,0,0,.18); transition: transform .1s, border-color .1s; }
  .swatch:hover { transform: scale(1.12); }
  .swatch.selected { border-color: #123a55; transform: scale(1.14); box-shadow: inset 0 -4px 0 rgba(0,0,0,.18), 0 0 0 3px rgba(47,159,216,.4); }
  #start-button { width: 100%; border: none; cursor: pointer; border-radius: 16px; padding: 15px;
    background: linear-gradient(180deg, #36b6f0, #1184c8); color: #fff; font-weight: 900; font-size: 17px;
    box-shadow: inset 0 -4px 0 rgba(0,0,0,.2), 0 10px 22px rgba(7,91,132,.35); transition: transform .1s, filter .1s; }
  #start-button:hover { transform: translateY(-2px); filter: brightness(1.05); }
  #start-button:active { transform: translateY(0); }
  #start-card small { display: block; margin-top: 14px; color: #6d8da0; font-size: 11px; line-height: 1.4; font-weight: 600; }
`;
document.head.appendChild(style);

// ---------- sky gradient ----------
const skyGeo = new THREE.SphereGeometry(400, 32, 16);
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  uniforms: {
    top: { value: new THREE.Color(0x2f7fd0) },
    mid: { value: new THREE.Color(0x7cc3f0) },
    bottom: { value: new THREE.Color(0xeaf7ff) },
  },
  vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vPos; uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
    void main(){
      float h = clamp((normalize(vPos).y + 0.18) / 0.95, 0.0, 1.0);
      vec3 col = h < 0.5 ? mix(bottom, mid, h * 2.0) : mix(mid, top, (h - 0.5) * 2.0);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
scene.add(new THREE.Mesh(skyGeo, skyMat));

// soft sun + halo
const sunDisc = new THREE.Mesh(
  new THREE.CircleGeometry(16, 32),
  new THREE.MeshBasicMaterial({ color: 0xfff7e3, transparent: true, opacity: 0.95 })
);
sunDisc.position.set(-130, 100, -180);
sunDisc.lookAt(0, 0, 0);
scene.add(sunDisc);
const sunHalo = new THREE.Mesh(
  new THREE.CircleGeometry(34, 32),
  new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0.28, depthWrite: false })
);
sunHalo.position.copy(sunDisc.position);
sunHalo.lookAt(0, 0, 0);
scene.add(sunHalo);

// ---------- aurora borealis ----------
const auroraMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  uniforms: { time: { value: 0 }, intensity: { value: 0.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `
    varying vec2 vUv; uniform float time; uniform float intensity;
    void main(){
      float x = vUv.x;
      // wavy curtains drifting sideways
      float wave = sin(x * 9.0 + time * 0.6) * 0.08 + sin(x * 22.0 - time * 0.9) * 0.04;
      float band = vUv.y - (0.5 + wave);
      float curtain = smoothstep(0.42, 0.0, abs(band));
      // vertical streaks
      float streak = 0.6 + 0.4 * sin(x * 60.0 + time * 1.3);
      // color shift across the sky
      vec3 green = vec3(0.25, 0.95, 0.6);
      vec3 teal = vec3(0.2, 0.75, 0.95);
      vec3 purple = vec3(0.65, 0.4, 0.95);
      vec3 col = mix(green, teal, sin(x * 4.0 + time * 0.3) * 0.5 + 0.5);
      col = mix(col, purple, smoothstep(0.6, 1.0, x));
      float alpha = curtain * streak * smoothstep(0.0, 0.25, vUv.y) * 0.55 * intensity;
      gl_FragColor = vec4(col, alpha);
    }`,
});
const aurora = new THREE.Mesh(new THREE.PlaneGeometry(420, 150, 1, 1), auroraMat);
aurora.position.set(0, 95, 175);
aurora.rotation.y = Math.PI;
aurora.rotation.x = -0.12;
scene.add(aurora);

// ---------- stars (fade in at night) ----------
const starGeo = new THREE.BufferGeometry();
const STAR_N = 700;
const starPos = new Float32Array(STAR_N * 3);
for (let i = 0; i < STAR_N; i++) {
  // scatter across the upper sky dome
  const u = Math.random() * Math.PI * 2;
  const v = Math.random() * 0.7 + 0.05;          // keep them up high
  const r = 380;
  starPos[i * 3] = Math.cos(u) * Math.cos(v * Math.PI / 2) * r;
  starPos[i * 3 + 1] = Math.sin(v * Math.PI / 2) * r;
  starPos[i * 3 + 2] = Math.sin(u) * Math.cos(v * Math.PI / 2) * r;
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: false });
const stars = new THREE.Points(starGeo, starMat);
scene.add(stars);

// ---------- drifting clouds ----------
const cloudTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 124);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const clouds = [];
for (let i = 0; i < 16; i++) {
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.55 + Math.random() * 0.25, depthWrite: false }));
  const s = 30 + Math.random() * 45;
  sprite.scale.set(s, s * 0.55, 1);
  sprite.position.set((Math.random() - 0.5) * 360, 55 + Math.random() * 40, (Math.random() - 0.5) * 360);
  scene.add(sprite);
  clouds.push({ sprite, speed: 1.5 + Math.random() * 2.5 });
}

// ---------- lighting ----------
const hemi = new THREE.HemisphereLight(0xeafaff, 0x6f8aa0, 2.1);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2cf, 2.7);
sun.position.set(-50, 70, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -90;
sun.shadow.camera.right = 90;
sun.shadow.camera.top = 90;
sun.shadow.camera.bottom = -90;
sun.shadow.bias = -0.0004;
scene.add(sun);

// ---------- helpers ----------
const solid = [];
const zones = [
  { name: 'Snowy Plaza', x: 0, z: 0, radius: 22 },
  { name: 'Cocoa Lane', x: -30, z: -12, radius: 17 },
  { name: 'Toboggan Hill', x: 31, z: -18, radius: 20 },
  { name: 'Aurora Docks', x: 2, z: 36, radius: 22 },
  { name: 'Igloo Village', x: -28, z: 22, radius: 18 },
];

function mat(color, roughness = 0.85, flat = false) {
  return new THREE.MeshStandardMaterial({ color, roughness, flatShading: flat });
}
function mesh(geometry, material, cast = true, receive = true) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}
function addBox(x, y, z, w, h, d, color, collision = false) {
  const m = mesh(new THREE.BoxGeometry(w, h, d), mat(color));
  m.position.set(x, y + h / 2, z);
  world.add(m);
  if (collision) solid.push({ x, z, hx: w / 2 + 0.5, hz: d / 2 + 0.5 });
  return m;
}
function addCylinder(x, y, z, rTop, rBot, h, color, seg = 18) {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, seg), mat(color));
  m.position.set(x, y + h / 2, z);
  world.add(m);
  return m;
}
function circleShadow(x, z, radius = 2) {
  const sh = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({ color: 0x6c93a8, transparent: true, opacity: 0.16, depthWrite: false })
  );
  sh.rotation.x = -Math.PI / 2;
  sh.position.set(x, 0.03, z);
  world.add(sh);
}

// rounded sign sprite for buildings / landmarks
function makeLabelSprite(text, { bg = 'rgba(15,70,104,.92)', fg = '#ffffff', pad = 38 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '900 96px "Baloo 2", system-ui, sans-serif';
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  canvas.width = Math.ceil(textW + pad * 2);
  canvas.height = 170;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const r = 48;
  ctx.fillStyle = bg;
  roundRect(ctx, 6, 22, canvas.width - 12, canvas.height - 44, r);
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255,255,255,.55)';
  roundRect(ctx, 6, 22, canvas.width - 12, canvas.height - 44, r);
  ctx.stroke();
  ctx.fillStyle = fg;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.userData.aspect = canvas.width / canvas.height;
  return sprite;
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
function addSign(text, x, y, z, height = 2.6, opts) {
  const s = makeLabelSprite(text, opts);
  s.scale.set(height * s.userData.aspect, height, 1);
  s.position.set(x, y, z);
  world.add(s);
  return s;
}

// ---------- terrain ----------
// sparkly snow texture
const snowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3fbff';
  ctx.fillRect(0, 0, 512, 512);
  // soft blue-grey blotches for subtle depth
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(208,232,245,${0.05 + Math.random() * 0.12})`;
    ctx.beginPath();
    ctx.arc(Math.random() * 512, Math.random() * 512, 8 + Math.random() * 40, 0, Math.PI * 2);
    ctx.fill();
  }
  // sparkles
  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.4 + Math.random() * 0.6})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(8, 8);
  return t;
})();
const snowGround = mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ map: snowTex, roughness: 0.92 }), false, true);
snowGround.rotation.x = -Math.PI / 2;
world.add(snowGround);

// gentle snow mounds for depth
for (let i = 0; i < 26; i++) {
  const a = Math.random() * Math.PI * 2;
  const r = 30 + Math.random() * 75;
  const s = 2 + Math.random() * 5;
  const mound = mesh(new THREE.SphereGeometry(s, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xeaf7ff, 0.95));
  mound.scale.y = 0.35;
  mound.position.set(Math.cos(a) * r, -0.2, Math.sin(a) * r);
  mound.receiveShadow = true;
  world.add(mound);
}

// frozen lake at the docks
const lake = mesh(
  new THREE.CircleGeometry(16, 64),
  new THREE.MeshStandardMaterial({ color: 0x8fe1f6, metalness: 0.35, roughness: 0.12, transparent: true, opacity: 0.86 }),
  false, true
);
lake.rotation.x = -Math.PI / 2;
lake.position.set(2, 0.04, 38);
world.add(lake);

// raised toboggan hill
const hill = mesh(new THREE.SphereGeometry(21, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xeaf8ff, 0.95));
hill.scale.set(1.4, 0.5, 1.05);
hill.position.set(34, -5, -22);
hill.receiveShadow = true;
world.add(hill);

// decorated central plaza floor (snow-tiled with a compass star)
const plazaTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const ctx = c.getContext('2d');
  const cx = 512, cy = 512;
  // base
  ctx.fillStyle = '#e3f1fa';
  ctx.fillRect(0, 0, 1024, 1024);
  // concentric tile rings
  for (let r = 460; r > 60; r -= 70) {
    ctx.strokeStyle = r % 140 === 460 % 140 ? 'rgba(150,190,215,0.6)' : 'rgba(180,210,230,0.55)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // radial spokes
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.strokeStyle = 'rgba(170,205,228,0.45)';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * 75, cy + Math.sin(a) * 75);
    ctx.lineTo(cx + Math.cos(a) * 470, cy + Math.sin(a) * 470);
    ctx.stroke();
  }
  // compass star in the middle
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
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
const plazaFloor = mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({ map: plazaTex, roughness: 0.85 }), false, true);
plazaFloor.rotation.x = -Math.PI / 2;
plazaFloor.position.y = 0.06;
world.add(plazaFloor);
// raised stone border ring around the plaza
const plazaRing = mesh(new THREE.TorusGeometry(14, 0.4, 10, 80), mat(0xcde0ec, 0.8));
plazaRing.rotation.x = Math.PI / 2;
plazaRing.position.y = 0.18;
world.add(plazaRing);

// ---------- pathways ----------
function path(points, width = 5) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = new THREE.Vector3(points[i][0], 0.05, points[i][1]);
    const b = new THREE.Vector3(points[i + 1][0], 0.05, points[i + 1][1]);
    const delta = b.clone().sub(a);
    const len = delta.length();
    const slab = mesh(new THREE.BoxGeometry(width, 0.1, len + width * 0.4), mat(0xdfeef6), false, true);
    slab.position.copy(a.clone().add(b).multiplyScalar(0.5));
    slab.rotation.y = Math.atan2(delta.x, delta.z);
    world.add(slab);
  }
}
path([[0, 6], [0, 26], [2, 36]], 5.4);
path([[0, 3], [-18, -6], [-32, -11]], 4.8);
path([[0, 2], [15, -7], [31, -15]], 4.8);
path([[-3, 4], [-16, 12], [-28, 20]], 4.6);

// animated twinkle lights + glints
const twinkles = [];
const BAUBLE_COLORS = [0xff6f61, 0xffd23f, 0x35c45f, 0x2f7fe0, 0x9b5de5, 0xff7ec8];

// ---------- pine trees ----------
function tree(x, z, size = 1) {
  const trunk = addCylinder(x, 0, z, 0.32 * size, 0.4 * size, 2.4 * size, 0x7a4d2c, 10);
  trunk.castShadow = true;
  const snowy = Math.random() > 0.35;
  const festive = Math.random() > 0.5;
  for (let i = 0; i < 3; i++) {
    const cone = mesh(new THREE.ConeGeometry((1.6 - i * 0.3) * size, 2.5 * size, 10), mat(i === 1 ? 0x2f8a63 : 0x247a55, 0.9));
    cone.position.set(x, 1.7 * size + i * 1.05 * size, z);
    cone.castShadow = true;
    world.add(cone);
    if (snowy) {
      const cap = mesh(new THREE.ConeGeometry((1.62 - i * 0.3) * size, 0.5 * size, 10), mat(0xffffff));
      cap.position.set(x, 1.7 * size + i * 1.05 * size + 1.0 * size, z);
      world.add(cap);
    }
  }
  if (festive) {
    // glowing baubles tucked into the branches
    for (let b = 0; b < 7; b++) {
      const ang = Math.random() * Math.PI * 2;
      const ry = 2.0 + Math.random() * 2.6;
      const rad = (1.5 - (ry - 2) * 0.35) * size * (0.7 + Math.random() * 0.4);
      const col = BAUBLE_COLORS[Math.floor(Math.random() * BAUBLE_COLORS.length)];
      const bauble = mesh(new THREE.SphereGeometry(0.14 * size, 10, 10), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.1, roughness: 0.35 }), false, false);
      bauble.position.set(x + Math.cos(ang) * rad, ry * size, z + Math.sin(ang) * rad);
      world.add(bauble);
      twinkles.push({ mat: bauble.material, base: 1.1, phase: Math.random() * 6 });
    }
    // star topper
    const star = mesh(new THREE.OctahedronGeometry(0.3 * size), new THREE.MeshStandardMaterial({ color: 0xffe06a, emissive: 0xffcf3a, emissiveIntensity: 1.4, roughness: 0.3 }), false, false);
    star.position.set(x, 4.9 * size, z);
    world.add(star);
    twinkles.push({ mat: star.material, base: 1.4, phase: Math.random() * 6 });
  }
  circleShadow(x, z, 1.2 * size);
}
[
  [-45,-26,1.3],[-40,-18,0.95],[-48,-4,1.45],[-41,12,1.1],[-33,22,1.2],[-18,32,0.95],[-12,46,1.2],
  [21,47,1.25],[37,37,1.2],[45,21,0.95],[50,4,1.45],[47,-20,1.15],[25,-36,0.95],[8,-36,1.25],[-10,-36,1.0],
  [-46,34,1.1],[-38,40,0.9],[42,-34,1.0],
].forEach((v) => tree(...v));

// ---------- candy-cane lamp posts ----------
const caneTex = stripeTextureV(0xe5384d, 0xffffff, 8);
function lamp(x, z) {
  const pole = mesh(new THREE.CylinderGeometry(0.13, 0.15, 4.2, 12), new THREE.MeshStandardMaterial({ map: caneTex, roughness: 0.6 }));
  pole.position.set(x, 2.1, z);
  pole.castShadow = true;
  world.add(pole);
  // lantern cage
  const cap = mesh(new THREE.ConeGeometry(0.55, 0.6, 8), mat(0x2c3e50));
  cap.position.set(x, 4.75, z);
  world.add(cap);
  const glass = mesh(new THREE.SphereGeometry(0.42, 16, 12), new THREE.MeshStandardMaterial({
    color: 0xfff0b8, emissive: 0xffd97a, emissiveIntensity: 1.5, roughness: 0.4,
  }), false, false);
  glass.position.set(x, 4.25, z);
  world.add(glass);
  twinkles.push({ mat: glass.material, base: 1.5, phase: Math.random() * 6, amp: 0.25 });
  // little snow cap on the lantern
  const snow = mesh(new THREE.SphereGeometry(0.45, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffffff));
  snow.position.set(x, 4.55, z);
  world.add(snow);
}
function stripeTextureV(hexA, hexB, stripes) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = stripes * 16;
  const ctx = c.getContext('2d');
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? '#' + new THREE.Color(hexB).getHexString() : '#' + new THREE.Color(hexA).getHexString();
    ctx.fillRect(0, i * 16, 32, 16);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const plazaLamps = [[-9, 9], [9, 9], [-9, -9], [9, -9], [0, 18], [-14, 11]];
plazaLamps.forEach(([x, z]) => lamp(x, z));

// ---------- string lights strung between the plaza lamps ----------
function stringLights(ax, az, bx, bz, count = 9) {
  const a = new THREE.Vector3(ax, 4.4, az);
  const b = new THREE.Vector3(bx, 4.4, bz);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const p = a.clone().lerp(b, t);
    p.y -= Math.sin(t * Math.PI) * 1.1; // droop
    const col = BAUBLE_COLORS[i % BAUBLE_COLORS.length];
    const bulb = mesh(new THREE.SphereGeometry(0.11, 8, 8), new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.2, roughness: 0.35 }), false, false);
    bulb.position.copy(p);
    world.add(bulb);
    twinkles.push({ mat: bulb.material, base: 1.2, phase: Math.random() * 6, amp: 0.7 });
  }
}
stringLights(-9, 9, 9, 9);
stringLights(9, 9, 9, -9);
stringLights(9, -9, -9, -9);
stringLights(-9, -9, -9, 9);

// ---------- buildings ----------
// striped awning texture
function stripeTexture(hexA, hexB, stripes = 7) {
  const c = document.createElement('canvas');
  c.width = stripes * 32; c.height = 32;
  const ctx = c.getContext('2d');
  const a = '#' + new THREE.Color(hexA).getHexString();
  const b = '#' + new THREE.Color(hexB).getHexString();
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? b : a;
    ctx.fillRect(i * 32, 0, 32, 32);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// chimney smoke emitters (animated in the loop)
const smokeEmitters = [];
const smokePuffs = [];

function building({ x, z, w, d, h, wall, roof, sign, awning = 0xe5384d }) {
  const front = z + d / 2;
  addBox(x, 0, z, w, h, d, wall, true);
  // base trim + corner pillars
  addBox(x, 0, z, w + 0.3, 0.5, d + 0.3, 0xffffff, false);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pil = mesh(new THREE.BoxGeometry(0.4, h, 0.4), mat(0xffffff));
    pil.position.set(x + sx * (w / 2), h / 2, z + sz * (d / 2));
    world.add(pil);
  }
  // pitched roof + snow cap
  const roofMesh = mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.82, h * 0.7, 4), mat(roof, 0.8));
  roofMesh.position.set(x, h + h * 0.34, z);
  roofMesh.rotation.y = Math.PI / 4;
  roofMesh.castShadow = true;
  world.add(roofMesh);
  const snowCap = mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.6, h * 0.28, 4), mat(0xffffff));
  snowCap.position.set(x, h + h * 0.62, z);
  snowCap.rotation.y = Math.PI / 4;
  world.add(snowCap);

  // chimney + smoke
  const chimX = x + w * 0.28;
  addBox(chimX, h + h * 0.1, z - d * 0.1, 0.7, h * 0.5, 0.7, 0x9c5b4b, false);
  const chimTop = h + h * 0.1 + h * 0.5;
  smokeEmitters.push({ x: chimX, y: chimTop, z: z - d * 0.1, timer: Math.random() });

  // door + rounded arch + knob
  const door = mesh(new THREE.BoxGeometry(Math.min(2.2, w * 0.3), h * 0.5, 0.2), mat(0x5d4130));
  door.position.set(x, h * 0.25, front + 0.11);
  world.add(door);
  const arch = mesh(new THREE.CylinderGeometry(Math.min(1.1, w * 0.15), Math.min(1.1, w * 0.15), 0.2, 16, 1, false, 0, Math.PI), mat(0x5d4130));
  arch.rotation.x = Math.PI / 2;
  arch.position.set(x, h * 0.5, front + 0.11);
  world.add(arch);
  const knob = mesh(new THREE.SphereGeometry(0.1, 10, 10), mat(0xf3d26e), false, false);
  knob.position.set(x + 0.6, h * 0.25, front + 0.24);
  world.add(knob);

  // striped awning over the door
  const awnW = Math.min(3.4, w * 0.46);
  const awn = mesh(new THREE.BoxGeometry(awnW, 0.18, 1.5), new THREE.MeshStandardMaterial({ map: stripeTexture(awning, 0xffffff), roughness: 0.7 }));
  awn.rotation.x = 0.42;
  awn.position.set(x, h * 0.56, front + 0.7);
  awn.castShadow = true;
  world.add(awn);
  // scalloped front edge
  for (let i = 0; i < 5; i++) {
    const scal = mesh(new THREE.CircleGeometry(awnW / 11, 8), new THREE.MeshStandardMaterial({ color: i % 2 ? 0xffffff : awning, side: THREE.DoubleSide, roughness: 0.7 }), false, false);
    scal.position.set(x - awnW / 2 + (i + 0.5) * (awnW / 5), h * 0.56 - 0.32, front + 1.18);
    world.add(scal);
  }

  // glowing windows with shutters + window boxes
  const winMat = new THREE.MeshStandardMaterial({ color: 0xfff2bd, emissive: 0xffd06a, emissiveIntensity: 0.8, roughness: 0.3 });
  for (const dx of [-w * 0.3, w * 0.3]) {
    const frame = mesh(new THREE.BoxGeometry(w * 0.2, h * 0.27, 0.1), mat(0xffffff), false, false);
    frame.position.set(x + dx, h * 0.6, front + 0.04);
    world.add(frame);
    const win = mesh(new THREE.BoxGeometry(w * 0.17, h * 0.24, 0.14), winMat, false, false);
    win.position.set(x + dx, h * 0.6, front + 0.08);
    world.add(win);
    // cross muntins
    const barV = mesh(new THREE.BoxGeometry(0.06, h * 0.24, 0.16), mat(0xffffff), false, false);
    barV.position.set(x + dx, h * 0.6, front + 0.09); world.add(barV);
    const barH = mesh(new THREE.BoxGeometry(w * 0.17, 0.06, 0.16), mat(0xffffff), false, false);
    barH.position.set(x + dx, h * 0.6, front + 0.09); world.add(barH);
    // shutters
    for (const sx of [-1, 1]) {
      const sh = mesh(new THREE.BoxGeometry(w * 0.05, h * 0.27, 0.08), mat(roof, 0.7), false, false);
      sh.position.set(x + dx + sx * w * 0.13, h * 0.6, front + 0.06);
      world.add(sh);
    }
    // window box with little plants
    const box = mesh(new THREE.BoxGeometry(w * 0.22, 0.22, 0.3), mat(0x7a4d2c), false, false);
    box.position.set(x + dx, h * 0.46, front + 0.18); world.add(box);
    for (let k = -1; k <= 1; k++) {
      const plant = mesh(new THREE.SphereGeometry(0.12, 8, 8), mat(0x2f8a63), false, false);
      plant.position.set(x + dx + k * w * 0.06, h * 0.46 + 0.16, front + 0.18); world.add(plant);
    }
  }
  circleShadow(x, z, Math.max(w, d) * 0.55);
}

building({ x: -30, z: -12, w: 11, d: 8, h: 6.6, wall: 0xf9a05c, roof: 0x8d3c4f, sign: 'Cocoa Café', awning: 0xc0392b });
building({ x: -12, z: -22, w: 9, d: 8, h: 5.8, wall: 0xffd86a, roof: 0x47749a, sign: 'Hat Hut', awning: 0x2f7fe0 });
building({ x: 17, z: -14, w: 12, d: 9, h: 7.2, wall: 0x84cdee, roof: 0x356f93, sign: 'Game Garage', awning: 0x9b5de5 });
building({ x: 32, z: 5, w: 10, d: 8, h: 6.4, wall: 0x9ddb8a, roof: 0x4d756c, sign: 'Snow Lab', awning: 0x2fbf5e });
building({ x: -24, z: 12, w: 12, d: 9, h: 6.8, wall: 0xe0a6da, roof: 0x5c5780, sign: 'Pet Post', awning: 0xff7ec8 });

// ---------- igloo village ----------
function igloo(x, z, tint = 0xeef7ff) {
  const dome = mesh(new THREE.SphereGeometry(3.1, 22, 14, 0, Math.PI * 2, 0, Math.PI / 2), mat(tint, 0.92));
  dome.position.set(x, 0, z);
  dome.castShadow = true;
  dome.receiveShadow = true;
  world.add(dome);
  // brick rings
  for (let r = 0; r < 3; r++) {
    const ring = mesh(new THREE.TorusGeometry(3.1 * Math.cos((r / 3.4) * Math.PI / 2), 0.07, 6, 30), mat(0xcfe4f0, 0.95), false, false);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(x, 0.4 + r * 0.85, z);
    world.add(ring);
  }
  // entrance tunnel
  const ent = mesh(new THREE.CylinderGeometry(1.1, 1.1, 1.8, 16, 1, false, 0, Math.PI), mat(tint, 0.92));
  ent.rotation.z = Math.PI / 2;
  ent.rotation.y = Math.PI / 2;
  ent.position.set(x, 0.9, z + 3.1);
  world.add(ent);
  const doorway = mesh(new THREE.CircleGeometry(0.95, 18), new THREE.MeshBasicMaterial({ color: 0x16384f }));
  doorway.position.set(x, 0.95, z + 4.02);
  world.add(doorway);
  solid.push({ x, z, hx: 3.4, hz: 3.4 });
  circleShadow(x, z, 3.4);
}
igloo(-32, 24, 0xeef7ff);
igloo(-24, 28, 0xe7f0ff);
igloo(-20, 18, 0xf3eaff);
addSign('Igloo Village', -27, 6.4, 23, 2.1, { bg: 'rgba(80,90,150,.92)' });

// ---------- central landmark: friendly snow giant + clock ----------
const plaza = new THREE.Group();
world.add(plaza);
// snowman body stack
const sn1 = mesh(new THREE.SphereGeometry(2.4, 28, 20), mat(0xffffff, 0.9));
sn1.position.set(0, 2.2, 0);
sn1.castShadow = true; plaza.add(sn1);
const sn2 = mesh(new THREE.SphereGeometry(1.7, 28, 20), mat(0xffffff, 0.9));
sn2.position.set(0, 5.3, 0);
sn2.castShadow = true; plaza.add(sn2);
const snHead = mesh(new THREE.SphereGeometry(1.2, 28, 20), mat(0xffffff, 0.9));
snHead.position.set(0, 7.6, 0);
snHead.castShadow = true; plaza.add(snHead);
// eyes + carrot nose + buttons + smile
for (const sx of [-0.45, 0.45]) {
  const e = mesh(new THREE.SphereGeometry(0.16, 12, 12), mat(0x2a2a2a), false, false);
  e.position.set(sx, 7.9, 1.05); plaza.add(e);
}
const nose = mesh(new THREE.ConeGeometry(0.22, 1.0, 12), mat(0xff8c3b));
nose.rotation.x = Math.PI / 2;
nose.position.set(0, 7.55, 1.4); plaza.add(nose);
for (let i = 0; i < 3; i++) {
  const btn = mesh(new THREE.SphereGeometry(0.18, 10, 10), mat(0x2a2a2a), false, false);
  btn.position.set(0, 5.6 - i * 0.7, 1.55 - i * 0.12); plaza.add(btn);
}
for (let i = 0; i < 5; i++) {
  const s = mesh(new THREE.SphereGeometry(0.1, 8, 8), mat(0x2a2a2a), false, false);
  const a = -0.7 + (i / 4) * 1.4;
  s.position.set(Math.sin(a) * 0.7, 7.15 + Math.cos(a) * 0.18 - 0.18, 1.08); plaza.add(s);
}
// little top hat
const brim = mesh(new THREE.CylinderGeometry(1.0, 1.0, 0.12, 20), mat(0x2c3142));
brim.position.set(0, 8.55, 0); plaza.add(brim);
const topHat = mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.2, 20), mat(0x2c3142));
topHat.position.set(0, 9.2, 0); topHat.castShadow = true; plaza.add(topHat);
const hatBand = mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.28, 20), mat(0xe5384d));
hatBand.position.set(0, 8.78, 0); plaza.add(hatBand);
// stick arms
for (const side of [-1, 1]) {
  const arm = mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.6, 6), mat(0x6b4a2c));
  arm.position.set(side * 2.0, 5.5, 0);
  arm.rotation.z = side * 0.9;
  plaza.add(arm);
}
solid.push({ x: 0, z: 0, hx: 2.8, hz: 2.8 });
circleShadow(0, 0, 3);
addSign('Snowy Plaza', 0, 11.2, 0, 2.4);

// ---------- docks ----------
const dockMat = mat(0xa8794f);
for (let z = 24; z <= 48; z += 3.1) {
  const a = mesh(new THREE.BoxGeometry(3.2, 0.25, 2.7), dockMat); a.position.set(-7.4, 0.18, z); world.add(a);
  const b = mesh(new THREE.BoxGeometry(3.2, 0.25, 2.7), dockMat); b.position.set(11.4, 0.18, z); world.add(b);
}
for (let x = -7; x <= 11; x += 3) {
  const c = mesh(new THREE.BoxGeometry(2.8, 0.25, 3.4), dockMat); c.position.set(x, 0.18, 48.6); world.add(c);
}
addSign('Aurora Docks', 2, 4.4, 47.6, 2.1, { bg: 'rgba(20,90,120,.92)' });

// ---------- toboggan hill ramp + flags ----------
for (let i = 0; i < 6; i++) {
  const x = 22 + i * 3.0;
  const z = -22 + i * 1.6;
  const rail = mesh(new THREE.BoxGeometry(3.0, 0.25, 6.0), mat(0xf3cf55));
  rail.rotation.z = -0.13;
  rail.position.set(x, 1.3 + i * 0.5, z);
  rail.castShadow = true;
  world.add(rail);
}
addSign('Toboggan Hill', 33, 9, -22, 2.2, { bg: 'rgba(120,70,40,.92)' });

// ---------- festive bunting between poles ----------
function bunting(x1, z1, x2, z2, count = 10) {
  const a = new THREE.Vector3(x1, 5, z1);
  const b = new THREE.Vector3(x2, 5, z2);
  const cols = [0xff6f61, 0xffd23f, 0x35c45f, 0x2f7fe0, 0x9b5de5];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const p = a.clone().lerp(b, t);
    p.y -= Math.sin(t * Math.PI) * 0.9; // sag
    const flag = mesh(new THREE.ConeGeometry(0.35, 0.7, 4), new THREE.MeshStandardMaterial({ color: cols[i % cols.length], side: THREE.DoubleSide, roughness: 0.6 }), false, false);
    flag.position.copy(p);
    flag.rotation.x = Math.PI;
    world.add(flag);
  }
}
bunting(-7, 7, 7, 7);
bunting(7, 7, 7, -7);
bunting(7, -7, -7, -7);
bunting(-7, -7, -7, 7);

// =====================================================================
//  Decorative props (gifts, mini snowmen, benches, snow piles, bushes)
// =====================================================================
function giftBox(x, z, col = 0xe5384d) {
  const s = 0.7 + Math.random() * 0.5;
  const box = mesh(new THREE.BoxGeometry(s, s, s), mat(col, 0.6));
  box.position.set(x, s / 2, z);
  box.rotation.y = Math.random() * Math.PI;
  box.castShadow = true;
  world.add(box);
  // ribbon
  const rib = mesh(new THREE.BoxGeometry(s * 0.16, s * 1.02, s * 1.02), mat(0xfff2bd, 0.5), false, false);
  rib.position.copy(box.position); rib.rotation.y = box.rotation.y; world.add(rib);
  const rib2 = mesh(new THREE.BoxGeometry(s * 1.02, s * 1.02, s * 0.16), mat(0xfff2bd, 0.5), false, false);
  rib2.position.copy(box.position); rib2.rotation.y = box.rotation.y; world.add(rib2);
  const bow = mesh(new THREE.SphereGeometry(s * 0.18, 10, 10), mat(0xfff2bd, 0.5), false, false);
  bow.position.set(x, s + 0.02, z); world.add(bow);
  circleShadow(x, z, s * 0.7);
}
function miniSnowman(x, z) {
  const g = new THREE.Group();
  const b1 = mesh(new THREE.SphereGeometry(0.6, 16, 12), mat(0xffffff, 0.9)); b1.position.y = 0.55; g.add(b1);
  const b2 = mesh(new THREE.SphereGeometry(0.42, 16, 12), mat(0xffffff, 0.9)); b2.position.y = 1.3; g.add(b2);
  for (const sx of [-0.15, 0.15]) {
    const e = mesh(new THREE.SphereGeometry(0.05, 8, 8), mat(0x2a2a2a), false, false); e.position.set(sx, 1.38, 0.36); g.add(e);
  }
  const n = mesh(new THREE.ConeGeometry(0.07, 0.32, 8), mat(0xff8c3b), false, false);
  n.rotation.x = Math.PI / 2; n.position.set(0, 1.28, 0.42); g.add(n);
  const scarfCol = BAUBLE_COLORS[Math.floor(Math.random() * BAUBLE_COLORS.length)];
  const scarf = mesh(new THREE.TorusGeometry(0.4, 0.09, 8, 16), mat(scarfCol, 0.6), false, false);
  scarf.rotation.x = Math.PI / 2; scarf.position.y = 1.0; g.add(scarf);
  g.position.set(x, 0, z);
  g.children.forEach((m) => (m.castShadow = true));
  world.add(g);
  circleShadow(x, z, 0.7);
  solid.push({ x, z, hx: 0.8, hz: 0.8 });
}
function bench(x, z, rot = 0) {
  const g = new THREE.Group();
  const seat = mesh(new THREE.BoxGeometry(2.4, 0.18, 0.7), mat(0x9c6b3f, 0.7)); seat.position.y = 0.7; g.add(seat);
  const back = mesh(new THREE.BoxGeometry(2.4, 0.7, 0.16), mat(0x9c6b3f, 0.7)); back.position.set(0, 1.05, -0.32); g.add(back);
  for (const sx of [-1, 1]) {
    const leg = mesh(new THREE.BoxGeometry(0.18, 0.7, 0.6), mat(0x6b4a2c)); leg.position.set(sx * 1.0, 0.35, 0); g.add(leg);
  }
  // snow on the seat
  const snow = mesh(new THREE.BoxGeometry(2.3, 0.12, 0.65), mat(0xffffff)); snow.position.set(0, 0.84, 0.02); g.add(snow);
  g.position.set(x, 0, z); g.rotation.y = rot;
  g.children.forEach((m) => { m.castShadow = true; m.receiveShadow = true; });
  world.add(g);
  circleShadow(x, z, 1.4);
}
function snowPile(x, z) {
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const r = 0.4 + Math.random() * 0.35;
    const ball = mesh(new THREE.SphereGeometry(r, 12, 10), mat(0xfdffff, 0.85));
    ball.position.set(x + (Math.random() - 0.5) * 1.4, r * 0.7, z + (Math.random() - 0.5) * 1.4);
    ball.castShadow = true;
    world.add(ball);
  }
  circleShadow(x, z, 1.3);
}
function bush(x, z) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const r = 0.5 + Math.random() * 0.3;
    const b = mesh(new THREE.SphereGeometry(r, 12, 10), mat(0x2f8a63, 0.9));
    b.position.set((Math.random() - 0.5) * 1.0, r * 0.8, (Math.random() - 0.5) * 1.0);
    b.castShadow = true; g.add(b);
    const cap = mesh(new THREE.SphereGeometry(r * 0.96, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffffff));
    cap.position.copy(b.position); cap.position.y += r * 0.2; g.add(cap);
  }
  g.position.set(x, 0, z); world.add(g);
  circleShadow(x, z, 1);
}

// gifts clustered at the plaza base
[[2.6, 2.4, 0xe5384d], [-2.8, 2.2, 0x2f7fe0], [0.4, 3.2, 0x35c45f], [-1.6, -2.8, 0xffd23f], [2.4, -2.2, 0x9b5de5]]
  .forEach(([gx, gz, col]) => giftBox(gx, gz, col));
// mini snowmen + benches + piles + bushes around the plaza & paths
[[12, 6], [-12, 7], [10, -10], [-11, -9], [-6, 16], [16, 14]].forEach(([x, z]) => miniSnowman(x, z));
[[11, 2, -0.5], [-11, 2, 0.5], [3, 12, Math.PI], [-4, -12, 0]].forEach(([x, z, r]) => bench(x, z, r));
[[18, -4], [-18, 4], [6, -16], [-16, -14], [20, 8], [14, 18]].forEach(([x, z]) => snowPile(x, z));
[[15, -2], [-15, -3], [4, 18], [-9, 14], [19, 2], [-19, 8], [9, -15], [-6, -16]].forEach(([x, z]) => bush(x, z));

// =====================================================================
//  Penguin factory (reused for player + NPCs)
// =====================================================================
function darken(hex, f = 0.78) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(f);
  return c.getHex();
}
function makePenguin({ color = 0x2f7fe0, hat = null, scale = 1 } = {}) {
  const g = new THREE.Group();
  const skin = darken(color, 0.85);

  const body = mesh(new THREE.SphereGeometry(0.8, 26, 20), mat(color, 0.7));
  body.scale.set(1, 1.22, 0.86);
  body.position.y = 1.0;
  g.add(body);

  const belly = mesh(new THREE.SphereGeometry(0.62, 24, 18), mat(0xfbfdff, 0.6), false, false);
  belly.scale.set(0.86, 1.12, 0.5);
  belly.position.set(0, 0.95, 0.5);
  g.add(belly);

  const head = mesh(new THREE.SphereGeometry(0.66, 26, 20), mat(skin, 0.7));
  head.position.y = 2.05;
  g.add(head);

  // big cute eyes (white + pupil)
  for (const sx of [-0.24, 0.24]) {
    const white = mesh(new THREE.SphereGeometry(0.17, 14, 14), mat(0xffffff, 0.4), false, false);
    white.scale.set(0.8, 1, 0.6);
    white.position.set(sx, 2.18, 0.5);
    g.add(white);
    const pupil = mesh(new THREE.SphereGeometry(0.08, 12, 12), mat(0x14171f, 0.3), false, false);
    pupil.position.set(sx, 2.16, 0.62);
    g.add(pupil);
  }

  const beak = mesh(new THREE.ConeGeometry(0.2, 0.42, 14), mat(0xff9b2e, 0.6));
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 1.92, 0.68);
  g.add(beak);

  // flippers (animated)
  const flippers = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.78, 1.2, 0);
    const fl = mesh(new THREE.SphereGeometry(0.5, 14, 12), mat(color, 0.7));
    fl.scale.set(0.22, 0.85, 0.5);
    fl.position.set(side * 0.12, -0.3, 0);
    pivot.add(fl);
    pivot.userData.side = side;
    g.add(pivot);
    flippers.push(pivot);
  }

  // feet (animated)
  const feet = [];
  for (const side of [-1, 1]) {
    const foot = mesh(new THREE.SphereGeometry(0.26, 14, 10), mat(0xff9b2e, 0.6));
    foot.scale.set(1.1, 0.4, 1.5);
    foot.position.set(side * 0.32, 0.18, 0.12);
    g.add(foot);
    feet.push(foot);
  }

  if (hat) addHat(g, hat);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 22),
    new THREE.MeshBasicMaterial({ color: 0x4f7689, transparent: true, opacity: 0.22, depthWrite: false })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  g.add(shadow);

  g.scale.setScalar(scale);
  return { group: g, parts: { body, head, flippers, feet, shadow }, baseBodyY: 1.0, baseHeadY: 2.05 };
}

function addHat(g, kind) {
  if (kind === 'tuque') {
    const col = [0xe5384d, 0x2f7fe0, 0x35c45f, 0x9b5de5, 0xff8c3b][Math.floor(Math.random() * 5)];
    const cap = mesh(new THREE.SphereGeometry(0.6, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat(col, 0.7));
    cap.position.set(0, 2.45, 0);
    g.add(cap);
    const band = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.22, 16), mat(0xffffff, 0.6));
    band.position.set(0, 2.45, 0);
    g.add(band);
    const pom = mesh(new THREE.SphereGeometry(0.16, 12, 12), mat(0xffffff, 0.6));
    pom.position.set(0, 3.0, 0);
    g.add(pom);
  } else if (kind === 'cap') {
    const col = [0xe5384d, 0x2f7fe0, 0x35c45f][Math.floor(Math.random() * 3)];
    const dome = mesh(new THREE.SphereGeometry(0.6, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2.2), mat(col, 0.7));
    dome.position.set(0, 2.4, 0);
    g.add(dome);
    const brim = mesh(new THREE.CircleGeometry(0.5, 18, 0, Math.PI), mat(col, 0.7), false, false);
    brim.rotation.x = -Math.PI / 2;
    brim.position.set(0, 2.42, 0.55);
    g.add(brim);
  } else if (kind === 'beanie') {
    const col = [0xffd23f, 0xff7ec8, 0x2ec9b8][Math.floor(Math.random() * 3)];
    const cap = mesh(new THREE.SphereGeometry(0.58, 16, 12, 0, Math.PI * 2, 0, Math.PI / 1.8), mat(col, 0.7));
    cap.position.set(0, 2.4, 0);
    g.add(cap);
  }
}

// ---------- name tag sprites ----------
function makeNameTag(name, colorHex) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '800 56px "Baloo 2", system-ui, sans-serif';
  ctx.font = font;
  const tw = ctx.measureText(name).width;
  canvas.width = Math.ceil(tw + 110);
  canvas.height = 96;
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(15,52,79,.9)';
  roundRect(ctx, 4, 18, canvas.width - 8, 60, 30);
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(255,255,255,.5)';
  roundRect(ctx, 4, 18, canvas.width - 8, 60, 30);
  ctx.stroke();
  // color dot
  ctx.fillStyle = '#' + new THREE.Color(colorHex).getHexString();
  ctx.beginPath();
  ctx.arc(40, 48, 17, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(name, 68, 50);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(1.0 * aspect, 1.0, 1);
  return sprite;
}

// ---------- emote bubble sprites (pooled) ----------
function makeEmoteSprite(emoji) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(15,52,79,.25)';
  ctx.lineWidth = 8;
  roundRect(ctx, 24, 18, 208, 180, 60);
  ctx.fill();
  ctx.stroke();
  // little tail
  ctx.beginPath();
  ctx.moveTo(108, 196);
  ctx.lineTo(148, 196);
  ctx.lineTo(118, 238);
  ctx.closePath();
  ctx.fill();
  ctx.font = '120px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(emoji, 128, 104);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(2.2, 2.2, 1);
  sprite.visible = false;
  return sprite;
}
const emoteCache = {};
function showEmote(targetGroup, emoji, headY = 3.0) {
  if (!emoteCache[emoji]) {
    emoteCache[emoji] = makeEmoteSprite(emoji);
    world.add(emoteCache[emoji]);
  }
  // clone material so multiple can show simultaneously
  const base = emoteCache[emoji];
  const sprite = new THREE.Sprite(base.material.clone());
  sprite.scale.copy(base.scale);
  world.add(sprite);
  activeEmotes.push({ sprite, target: targetGroup, headY, life: 0, ttl: 2.2 });
}
const activeEmotes = [];

// ---- zombie trash-talk speech bubbles (rated R) ----
const ZOMBIE_TAUNTS = [
  'GET BACK HERE!',
  "YOU'RE FUCKING DEAD!",
  "I'LL RIP YOUR HEAD OFF!",
  'COME HERE YOU LITTLE SHIT!',
  'GIVE ME YOUR FLESH!',
  'RUN, COWARD!',
  "YOU CAN'T HIDE, BITCH!",
  'FRESH MEAT!',
  "I'M GONNA EAT YOU ALIVE!",
  'DIE ALREADY!',
  'STOP RUNNING, PUSSY!',
  'YOU SMELL DELICIOUS!',
  'NO ESCAPE, ASSHOLE!',
  'WADDLE TO YOUR DEATH!',
  'GONNA GUT YOU LIKE A FISH!',
  "I SEE YOU, MOTHERFLAPPER!",
];

function makeChatSprite(text) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = '800 46px "Baloo 2", system-ui, sans-serif';
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  const padX = 46;
  const w = Math.ceil(textW + padX * 2);
  const h = 150;
  canvas.width = w; canvas.height = h;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(190,30,30,.6)';
  ctx.lineWidth = 7;
  roundRect(ctx, 8, 12, w - 16, 96, 40);
  ctx.fill(); ctx.stroke();
  // tail
  ctx.beginPath();
  ctx.moveTo(w / 2 - 22, 104);
  ctx.lineTo(w / 2 + 22, 104);
  ctx.lineTo(w / 2 - 10, 142);
  ctx.closePath();
  ctx.fillStyle = '#ffffff'; ctx.fill();
  ctx.fillStyle = '#c0271f';
  ctx.fillText(text, w / 2, 58);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.userData.aspect = w / h;
  return sprite;
}
const activeChats = [];
function showChat(targetGroup, text, headY = 3.4) {
  const sprite = makeChatSprite(text);
  world.add(sprite);
  activeChats.push({ sprite, target: targetGroup, headY, life: 0, ttl: 2.6, aspect: sprite.userData.aspect, baseH: 1.45 });
}
function updateChats(dt) {
  for (let i = activeChats.length - 1; i >= 0; i--) {
    const c = activeChats[i];
    c.life += dt;
    const pos = c.target.position;
    const pop = Math.min(1, c.life / 0.16);
    const rise = Math.min(1, c.life / c.ttl);
    c.sprite.position.set(pos.x, pos.y + c.headY + rise * 0.6, pos.z);
    const s = 0.55 + pop * 0.45;
    c.sprite.scale.set(c.baseH * c.aspect * s, c.baseH * s, 1);
    c.sprite.material.opacity = c.life > c.ttl - 0.5 ? Math.max(0, (c.ttl - c.life) / 0.5) : 1;
    if (c.life >= c.ttl) { world.remove(c.sprite); activeChats.splice(i, 1); }
  }
}

// =====================================================================
//  Player
// =====================================================================
let playerColor = PENGUIN_COLORS[0].hex;
let playerName = 'Waddles';
const player = makePenguin({ color: playerColor });
world.add(player.group);
player.group.position.set(0, 0, 9);

// ---------- NPCs ----------
const FIRST = ['Waddles', 'Pip', 'Bloop', 'Frosty', 'Sir', 'Bubbles', 'Sardine', 'Tux', 'Chilly', 'Mochi', 'Skipper', 'Nibbles', 'Pebble', 'Snowy', 'Captain'];
const LAST = ['McFlap', 'Flipper', 'Snowfeet', 'the Brave', 'Beaks', 'Iceberg', 'Wobble', 'Frostbeak', '', '', ''];
function randomName() {
  const f = FIRST[Math.floor(Math.random() * FIRST.length)];
  const l = LAST[Math.floor(Math.random() * LAST.length)];
  return (f + ' ' + l).trim();
}

const npcs = [];
let nextNetId = 1;        // host-assigned id so clients can match entities
const NPC_COUNT = 11;
const hats = [null, 'tuque', 'cap', 'beanie', null];
const ZOMBIE_COLORS = [0x6b8f4e, 0x7a9b6a, 0x8a9a8f, 0x5f7d5a, 0x9aa86f, 0x6f7d6b, 0x86a07e];

// floating health bar (canvas sprite)
function makeHealthBar() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 28;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(1.7, 0.37, 1);
  sprite.visible = false;
  function set(frac) {
    frac = clamp(frac, 0, 1);
    ctx.clearRect(0, 0, 128, 28);
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    roundRect(ctx, 2, 6, 124, 16, 8); ctx.fill();
    ctx.fillStyle = frac > 0.5 ? '#46d65f' : frac > 0.25 ? '#ffd23f' : '#ff3b3b';
    roundRect(ctx, 4, 8, Math.max(0.001, 120 * frac), 12, 6); ctx.fill();
    tex.needsUpdate = true;
  }
  set(1);
  return { sprite, set };
}

function pickHp() { const r = Math.random(); return r < 0.45 ? 1 : r < 0.78 ? 2 : 3; }

// distinct markers so dangerous types read at a glance (shared by NPCs + ghosts)
function addTypeMarkers(group, type) {
  if (type === 'bomber') {
    const orb = mesh(new THREE.SphereGeometry(0.32, 12, 12), new THREE.MeshStandardMaterial({ color: 0xffcf3a, emissive: 0xff5a1a, emissiveIntensity: 1.6 }), false, false);
    orb.position.set(0, 2.7, 0);
    orb.userData.bomberOrb = true;
    group.add(orb);
  } else if (type === 'spitter') {
    const sac = mesh(new THREE.SphereGeometry(0.42, 12, 12), new THREE.MeshStandardMaterial({ color: 0x9be060, emissive: 0x4a8a2a, emissiveIntensity: 0.7, roughness: 0.4 }), false, false);
    sac.position.set(0, 1.1, 0.55);
    group.add(sac);
  }
}

function addNPC({ color, hat = null, x, z, zombie = false, hp = null, speedBonus = 0, scale = 1, type = 'shambler', cashReward = 10, contactDmg = 7 }) {
  const pen = makePenguin({ color, hat, scale });
  pen.group.position.set(x, 0, z);
  world.add(pen.group);
  const tag = makeNameTag(randomName(), color);
  tag.visible = !zombie;
  world.add(tag);
  const hb = makeHealthBar();
  hb.sprite.visible = zombie;
  if (type === 'boss') hb.sprite.scale.set(3.2, 0.7, 1);
  world.add(hb.sprite);
  addTypeMarkers(pen.group, type);
  const maxHp = hp != null ? hp : pickHp();
  const npc = {
    ...pen, netId: nextNetId++, color, tag, hb, scale, type, cashReward, contactDmg,
    hp: maxHp, maxHp,
    isZombie: zombie,
    state: zombie ? 'chase' : 'wander',
    moving: false,
    target: pickWanderTarget(),
    waitTimer: 1 + Math.random() * 3,
    emoteTimer: 4 + Math.random() * 8,
    speed: (zombie ? 1.4 + Math.random() * 3.0 : 2.2 + Math.random() * 1.2) + speedBonus,
    sway: 0.4 + Math.random() * 1.6,
    swayPhase: Math.random() * 6,
    swayFreq: 1.5 + Math.random() * 3,
    lungeTimer: 2 + Math.random() * 4,
    lunge: 0,
    attackCD: 0,
    chatTimer: 2 + Math.random() * 7,
    stuck: 0,
    heading: 0,
    phase: Math.random() * 6,
    dead: false,
  };
  if (zombie) hb.set(npc.hp / npc.maxHp);
  npcs.push(npc);
  return npc;
}

for (let i = 0; i < NPC_COUNT; i++) {
  const color = PENGUIN_COLORS[i % PENGUIN_COLORS.length].hex;
  // find an open spot so townsfolk never spawn stuck inside a building
  let x = 0, z = 0, tries = 0;
  do {
    const angle = Math.random() * Math.PI * 2;
    const radius = 6 + Math.random() * 30;
    x = Math.cos(angle) * radius;
    z = Math.sin(angle) * radius;
    tries++;
  } while (collides({ x, z }) && tries < 24);
  addNPC({ color, hat: hats[Math.floor(Math.random() * hats.length)], x, z });
}
function pickWanderTarget() {
  const a = Math.random() * Math.PI * 2;
  const r = Math.random() * 32;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

// =====================================================================
//  Horde / zombie survival mode
// =====================================================================
let hordeMode = false;
let gameOver = false;
const HORDE_CAP = 28;

// round / wave state (COD-zombies style)
let round = 0;
let zTarget = 0;        // total zombies to clear this round
let zSpawned = 0;       // spawned so far this round
let zKilled = 0;        // killed so far this round
let spawnTimer = 0.5;
let intermission = 0;   // break between rounds

// player survival stats (NO passive regen — only med packs heal)
const PLAYER_MAX_HP = 100;
let playerHP = PLAYER_MAX_HP;
let damageFlash = 0;

// --- player HP HUD + damage vignette ---
const hpBar = document.createElement('div');
hpBar.style.cssText = 'position:fixed;bottom:74px;left:50%;transform:translateX(-50%);z-index:6;width:280px;height:22px;border-radius:999px;background:rgba(11,76,112,.4);border:2px solid rgba(255,255,255,.45);overflow:hidden;display:none;box-shadow:0 6px 18px rgba(8,46,72,.3)';
const hpFill = document.createElement('div');
hpFill.style.cssText = 'height:100%;width:100%;background:#46d65f;transition:width .15s,background .15s';
hpBar.appendChild(hpFill);
const hpLabel = document.createElement('div');
hpLabel.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 12px "Baloo 2",system-ui;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.5)';
hpBar.appendChild(hpLabel);
document.body.appendChild(hpBar);

const vignette = document.createElement('div');
vignette.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;background:radial-gradient(120% 120% at 50% 50%, transparent 45%, rgba(170,0,0,.8));transition:opacity .08s';
document.body.appendChild(vignette);

// round pill in the top-right status bar
const roundPill = document.createElement('div');
roundPill.className = 'status-pill';
roundPill.style.display = 'none';
roundPill.style.background = 'rgba(150,20,20,.55)';
const statusBarEl = document.querySelector('#status');
statusBarEl.insertBefore(roundPill, statusBarEl.firstChild);

// big round announcement
const roundBanner = document.createElement('div');
roundBanner.style.cssText = 'position:fixed;top:38%;left:50%;transform:translate(-50%,-50%);z-index:9;pointer-events:none;font:900 64px "Baloo 2",system-ui;color:#ff4747;text-shadow:0 4px 18px rgba(0,0,0,.6);opacity:0;transition:opacity .4s;letter-spacing:.04em';
document.body.appendChild(roundBanner);

// --- death / game over overlay ---
const deathOverlay = document.createElement('div');
deathOverlay.style.cssText = 'position:fixed;inset:0;z-index:20;display:none;align-items:center;justify-content:center;background:radial-gradient(120% 120% at 50% 30%, rgba(60,0,0,.6), rgba(10,0,0,.9));backdrop-filter:blur(4px)';
deathOverlay.innerHTML = `
  <div style="text-align:center;color:#fff;font-family:'Baloo 2',system-ui;max-width:460px;padding:30px">
    <div style="font-size:70px">💀</div>
    <h1 style="font-size:46px;margin:6px 0;color:#ff5151">YOU DIED</h1>
    <p id="death-stats" style="font-size:18px;opacity:.9;margin:8px 0 24px"></p>
    <button id="restart-btn" style="border:none;cursor:pointer;border-radius:16px;padding:15px 28px;background:linear-gradient(180deg,#ff5a5a,#c0392b);color:#fff;font-weight:900;font-size:18px;box-shadow:inset 0 -4px 0 rgba(0,0,0,.25),0 10px 22px rgba(120,0,0,.4)">Try Again</button>
  </div>`;
document.body.appendChild(deathOverlay);
deathOverlay.querySelector('#restart-btn').addEventListener('click', () => location.reload());

// =====================================================================
//  Cash economy + weapon upgrades
// =====================================================================
let cash = 0;
let gunLevel = 1;
let gunDamage = 1;
let upgradeCost = 500;
const GUN_MAX_LEVEL = 6;

const cashPill = document.createElement('div');
cashPill.className = 'status-pill';
cashPill.style.cssText += ';background:rgba(40,110,40,.55)';
cashPill.style.display = 'none';
statusBarEl.insertBefore(cashPill, statusBarEl.firstChild);
function updateCashHUD() { cashPill.innerHTML = `💵 <span>$${cash}</span>`; }

// floating "+$" popup at a world point (the dopamine hit)
function popCash(amount, point) {
  const v = point.clone().project(camera);
  if (v.z > 1) return;
  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const el = document.createElement('div');
  el.textContent = '+$' + amount;
  el.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:9;pointer-events:none;font:900 24px "Baloo 2",system-ui;color:#ffe23a;text-shadow:0 2px 7px rgba(0,0,0,.7);transform:translate(-50%,-50%) scale(.6);transition:transform .9s cubic-bezier(.2,.8,.3,1),top .9s ease-out,opacity .9s ease-out;opacity:1`;
  document.body.appendChild(el);
  requestAnimationFrame(() => {
    el.style.top = (y - 70) + 'px';
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,-50%) scale(1.2)';
  });
  setTimeout(() => el.remove(), 900);
}
function earnCash(amount, point) {
  cash += amount;
  updateCashHUD();
  if (point) popCash(amount, point);
}

// generic floating label at a world point (e.g. "HEADSHOT!")
function floatText(text, point, color = '#ff5a5a', size = 22) {
  const v = point.clone().project(camera);
  if (v.z > 1) return;
  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-v.y * 0.5 + 0.5) * window.innerHeight;
  const el = document.createElement('div');
  el.textContent = text;
  el.style.cssText = `position:fixed;left:${x}px;top:${y - 26}px;z-index:9;pointer-events:none;font:900 ${size}px "Baloo 2",system-ui;color:${color};text-shadow:0 2px 7px rgba(0,0,0,.8);transform:translate(-50%,-50%) scale(.7);transition:transform .8s cubic-bezier(.2,.8,.3,1),top .8s ease-out,opacity .8s ease-out;opacity:1`;
  document.body.appendChild(el);
  requestAnimationFrame(() => { el.style.top = (y - 96) + 'px'; el.style.opacity = '0'; el.style.transform = 'translate(-50%,-50%) scale(1.25)'; });
  setTimeout(() => el.remove(), 800);
}

// --- kill-streak combo multiplier (the dopamine engine) ---
let combo = 0;
let comboTimer = 0;
const COMBO_WINDOW = 3.4;
const comboHUD = document.createElement('div');
comboHUD.style.cssText = 'position:fixed;top:120px;left:50%;transform:translateX(-50%);z-index:8;pointer-events:none;text-align:center;font-family:"Baloo 2",system-ui;opacity:0;transition:opacity .2s';
comboHUD.innerHTML = '<div id="combo-mult" style="font-weight:900;font-size:34px;color:#ffd23f;text-shadow:0 2px 10px rgba(0,0,0,.6)"></div><div id="combo-streak" style="font-weight:800;font-size:15px;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,.6)"></div><div style="margin:4px auto 0;width:120px;height:6px;border-radius:999px;background:rgba(255,255,255,.25);overflow:hidden"><div id="combo-bar" style="height:100%;width:100%;background:#ffd23f"></div></div>';
document.body.appendChild(comboHUD);
const comboMultEl = comboHUD.querySelector('#combo-mult');
const comboStreakEl = comboHUD.querySelector('#combo-streak');
const comboBarEl = comboHUD.querySelector('#combo-bar');
function comboMultiplier() { return Math.min(5, 1 + Math.floor(combo / 3) * 0.5); }
function registerKillCombo() {
  combo++;
  comboTimer = COMBO_WINDOW;
  sfx.combo(combo);
  const m = comboMultiplier();
  comboMultEl.textContent = 'x' + m.toFixed(1);
  comboStreakEl.textContent = combo + ' KILL STREAK';
  comboHUD.style.opacity = combo >= 2 ? '1' : '0';
  return m;
}
function updateCombo(dt) {
  if (combo <= 0) return;
  comboTimer -= dt;
  comboBarEl.style.width = Math.max(0, comboTimer / COMBO_WINDOW) * 100 + '%';
  if (comboTimer <= 0) { combo = 0; comboHUD.style.opacity = '0'; }
}

// --- hit marker feedback near the crosshair ---
const hitMarker = document.createElement('div');
hitMarker.textContent = '✕';
hitMarker.style.cssText = 'position:fixed;left:50%;top:50%;z-index:7;pointer-events:none;transform:translate(-50%,-50%) scale(.6);font:900 26px system-ui;color:#fff;opacity:0;transition:opacity .12s,transform .12s';
document.body.appendChild(hitMarker);
let hitMarkerT = 0;
function showHitMarker(kill) {
  hitMarker.style.color = kill ? '#ff4242' : '#ffffff';
  hitMarker.style.fontSize = kill ? '40px' : '26px';
  hitMarker.style.opacity = '1';
  hitMarker.style.transform = 'translate(-50%,-50%) scale(1)';
  hitMarkerT = 0.12;
}
function updateHitMarker(dt) {
  if (hitMarkerT > 0) {
    hitMarkerT -= dt;
    if (hitMarkerT <= 0) { hitMarker.style.opacity = '0'; hitMarker.style.transform = 'translate(-50%,-50%) scale(.6)'; }
  }
}

// --- boss health bar (top center) ---
const bossBar = document.createElement('div');
bossBar.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);z-index:7;width:min(560px,80vw);height:26px;border-radius:8px;background:rgba(20,0,0,.6);border:2px solid rgba(255,90,90,.7);overflow:hidden;display:none;box-shadow:0 6px 20px rgba(80,0,0,.5)';
const bossFill = document.createElement('div');
bossFill.style.cssText = 'height:100%;width:100%;background:linear-gradient(180deg,#ff5a5a,#b01818);transition:width .12s';
bossBar.appendChild(bossFill);
const bossLabel = document.createElement('div');
bossLabel.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:900 13px "Baloo 2",system-ui;color:#fff;letter-spacing:.08em;text-shadow:0 1px 3px rgba(0,0,0,.7)';
bossLabel.textContent = '👑 BOSS PENGUIN';
bossBar.appendChild(bossLabel);
document.body.appendChild(bossBar);
let bossRef = null;
function showBossBar(npc) { bossRef = npc; bossBar.style.display = 'block'; bossFill.style.width = '100%'; }
function updateBossBar() {
  if (!bossRef) return;
  if (bossRef.dead) { bossBar.style.display = 'none'; bossRef = null; return; }
  bossFill.style.width = (Math.max(0, bossRef.hp) / bossRef.maxHp * 100) + '%';
}

// =====================================================================
//  Weapon shop — buy the pistol & upgrade it by talking to the keeper
// =====================================================================
const SHOP_POS = { x: 14, z: 20 };
const SHOP_R = 5.2;
const shop = new THREE.Group();
const woodDark = mat(0x7a5230, 0.9);
const woodLight = mat(0x9c6b3f, 0.85);
// floor pad
const sFloor = mesh(new THREE.BoxGeometry(9, 0.3, 6.6), woodLight); sFloor.position.y = 0.15; shop.add(sFloor);
// back + side walls
const sBack = mesh(new THREE.BoxGeometry(9, 4.2, 0.4), woodDark); sBack.position.set(0, 2.25, 3.1); shop.add(sBack);
for (const sx of [-1, 1]) {
  const sWall = mesh(new THREE.BoxGeometry(0.4, 4.2, 6.6), woodDark); sWall.position.set(sx * 4.3, 2.25, 0); shop.add(sWall);
  const post = mesh(new THREE.BoxGeometry(0.45, 4.6, 0.45), woodDark); post.position.set(sx * 4.3, 2.3, -3.0); shop.add(post);
}
// striped awning roof
for (let s = 0; s < 9; s++) {
  const slat = mesh(new THREE.BoxGeometry(1.05, 0.4, 8), mat(s % 2 ? 0xb6303a : 0xefe6d6, 0.7));
  slat.position.set(-4 + s, 4.7, -0.2); shop.add(slat);
}
// counter the player talks across
const counter = mesh(new THREE.BoxGeometry(8.4, 1.35, 1.0), woodLight); counter.position.set(0, 0.78, -2.4); shop.add(counter);
const counterTop = mesh(new THREE.BoxGeometry(8.7, 0.18, 1.35), mat(0xc69a63, 0.6)); counterTop.position.set(0, 1.5, -2.4); shop.add(counterTop);
// a couple of crates on the back wall
for (const cx of [-3, 3]) {
  const cr = mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), mat(0x8a6a44, 0.9)); cr.position.set(cx, 0.85, 2.3); shop.add(cr);
}
shop.position.set(SHOP_POS.x, 0, SHOP_POS.z);
shop.traverse((m) => { if (m.isMesh) m.castShadow = true; });
world.add(shop);
// colliders: counter (front) + back wall, so the player chats across the counter
solid.push({ x: SHOP_POS.x, z: SHOP_POS.z - 2.4, hx: 4.3, hz: 0.7 });
solid.push({ x: SHOP_POS.x, z: SHOP_POS.z + 3.1, hx: 4.6, hz: 0.4 });

// the shopkeeper penguin behind the counter
const keeper = makePenguin({ color: 0x39304a, hat: 'cap', scale: 1.1 });
keeper.group.position.set(SHOP_POS.x, 0, SHOP_POS.z + 0.8);
keeper.group.rotation.y = Math.PI; // face the customer
world.add(keeper.group);
const keeperTag = makeNameTag('🔫 Gunther', 0xffcf5a);
keeperTag.position.set(SHOP_POS.x, 3.0, SHOP_POS.z + 0.8);
world.add(keeperTag);

// pistol on display on the counter (hidden once bought)
const shopGun = makePistol(1.2);
shopGun.position.set(SHOP_POS.x, 1.85, SHOP_POS.z - 2.4);
shopGun.rotation.set(0, 0.5, 0.2);
world.add(shopGun);
const shopGunGlow = mesh(new THREE.TorusGeometry(0.7, 0.05, 8, 24), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc21a, emissiveIntensity: 1.3 }), false, false);
shopGunGlow.rotation.x = Math.PI / 2; shopGunGlow.position.set(SHOP_POS.x, 1.6, SHOP_POS.z - 2.4); world.add(shopGunGlow);

// hanging shop sign (smaller now)
const shopSign = makeLabelSprite('WEAPON SHOP', { bg: 'rgba(150,20,20,.92)' });
shopSign.scale.set(1.5 * shopSign.userData.aspect, 1.5, 1);
shopSign.position.set(SHOP_POS.x, 5.7, SHOP_POS.z - 0.2);
world.add(shopSign);

const upgradePrompt = document.createElement('div');
upgradePrompt.style.cssText = 'position:fixed;bottom:104px;left:50%;transform:translateX(-50%);z-index:6;padding:9px 16px;border-radius:12px;background:rgba(20,90,140,.85);border:2px solid rgba(255,255,255,.4);color:#fff;font:800 14px "Baloo 2",system-ui;display:none;text-shadow:0 1px 3px rgba(0,0,0,.4);white-space:nowrap';
document.body.appendChild(upgradePrompt);

function nearShop() {
  return Math.hypot(player.group.position.x - SHOP_POS.x, player.group.position.z - SHOP_POS.z) < SHOP_R;
}

function buyPistol() {
  if (hasGun || !started || gameOver) return;
  if (!nearShop()) return;
  pickupGunNow();
}

function tryBuyUpgrade() {
  if (!hasGun || !started || gameOver) return;
  if (!nearShop()) return;
  if (gunLevel >= GUN_MAX_LEVEL) { toast('Gunther: "She\'s maxed out, pal."'); return; }
  if (cash < upgradeCost) { toast(`Gunther: "Come back with $${upgradeCost}."`); return; }
  cash -= upgradeCost;
  gunLevel++;
  // weighted-random gains: usually a small bump, occasionally a jackpot.
  // pow() squashes the roll toward 0 so big upgrades are rare.
  const roll = Math.pow(Math.random(), 2.4);
  const dmgGain = Math.round((0.5 + roll * 5.5) * 10) / 10; // +0.5 .. +6.0 dmg
  const magGain = Math.round(2 + roll * 16);                // +2 .. +18 mag
  gunDamage = Math.round((gunDamage + dmgGain) * 10) / 10;
  MAG_SIZE += magGain;
  RESERVE_MAX += magGain * 3;     // bigger guns carry more spare ammo
  ammo = MAG_SIZE;
  ammoReserve = RESERVE_MAX;      // upgrading fully restocks your ammo
  upgradeCost = Math.round(upgradeCost * 1.8);
  updateCashHUD();
  updateWeaponHUD();
  sfx.upgrade();
  const tier = roll > 0.65 ? '💥 JACKPOT UPGRADE!' : roll > 0.3 ? '✨ Solid upgrade' : '⚙️ Upgraded';
  toast(`${tier} Mk.${gunLevel} — +${dmgGain} dmg, +${magGain} mag • ammo refilled`);
}

function updateUpgrader() {
  if (!started || gameOver || !nearShop()) { upgradePrompt.style.display = 'none'; return; }
  upgradePrompt.style.display = 'block';
  if (!hasGun) {
    upgradePrompt.textContent = '🔫 Press E to grab the PISTOL (free)';
  } else if (gunLevel >= GUN_MAX_LEVEL) {
    upgradePrompt.textContent = '⚙️ Weapon maxed (Mk.' + gunLevel + ')';
  } else {
    upgradePrompt.textContent = `⚙️ Press F to upgrade weapon — $${upgradeCost}`;
  }
}

function updatePlayerHP() {
  const f = playerHP / PLAYER_MAX_HP;
  hpFill.style.width = (f * 100) + '%';
  hpFill.style.background = f > 0.5 ? '#46d65f' : f > 0.25 ? '#ffd23f' : '#ff3b3b';
  hpLabel.textContent = `${Math.ceil(playerHP)} HP`;
}
function updateRoundHUD() { roundPill.innerHTML = `🌊 <span>Round ${round}</span>`; }
function announceRound() {
  roundBanner.textContent = 'ROUND ' + round;
  roundBanner.style.opacity = '1';
  bannerSeq++; bannerText = 'ROUND ' + round; // mirrored to clients via the snapshot
  setTimeout(() => { roundBanner.style.opacity = '0'; }, 1800);
}

function zombieHpForRound(r) {
  // ramps a touch faster so ammo conservation & headshots matter
  return 2 + Math.floor(r * 0.7) + (Math.random() < 0.45 ? 1 : 0);
}

function beginRound(r) {
  round = r;
  zTarget = 5 + r * 3;            // more zombies each round
  zSpawned = aliveZombies();      // already-present zombies count toward the wave
  zKilled = 0;
  spawnTimer = 0.6;
  updateRoundHUD();
  announceRound();
  sfx.round();
  sfx.tension(round * 0.06);
  // boss every 5th round
  if (r % 5 === 0) {
    spawnBoss();
    toast(`🌊 Round ${round} — 👑 BOSS ROUND!`);
  } else {
    toast(`🌊 Round ${round} — ${zTarget} of them are coming…`);
  }
}

function startHorde() {
  if (hordeMode) return;
  hordeMode = true;
  hpBar.style.display = 'block';
  roundPill.style.display = '';
  cashPill.style.display = '';
  updateCashHUD();
  updatePlayerHP();
  // the whole town turns
  for (const n of npcs) {
    if (n.dead) continue;
    n.isZombie = true;
    n.state = 'chase';
    n.tag.visible = false;
    n.hb.sprite.visible = true;
    n.hb.set(n.hp / n.maxHp);
    n.speed = 1.6 + Math.random() * 3.2;
  }
  toast('🧟 THE HORDE HAS AWOKEN — survive as long as you can!');
  sfx.combatMusic();
  beginRound(1);
}

function aliveZombies() {
  let c = 0;
  for (const n of npcs) if (!n.dead) c++;
  return c;
}

// pick a valid edge spawn that isn't inside a building
function edgeSpawnPoint() {
  // spawn just OUTSIDE the player's wall (r=105), around the rim of the snow
  // circle (ground radius 120) — zombies then shamble in through the wall.
  let x = 0, z = 0, tries = 0;
  do {
    const a = Math.random() * Math.PI * 2;
    const r = 108 + Math.random() * 9;
    x = Math.cos(a) * r;
    z = Math.sin(a) * r;
    tries++;
  } while (collides({ x, z }, true) && tries < 16);
  return { x, z };
}

function pickZombieType() {
  const r = Math.random();
  const brute = round >= 3 ? Math.min(0.22, 0.04 + round * 0.012) : 0;
  const runner = Math.min(0.34, 0.10 + round * 0.018);
  const bomber = round >= 4 ? Math.min(0.16, 0.03 + round * 0.010) : 0;
  const spitter = round >= 5 ? Math.min(0.16, 0.03 + round * 0.010) : 0;
  let acc = 0;
  if (r < (acc += brute)) return 'brute';
  if (r < (acc += runner)) return 'runner';
  if (r < (acc += bomber)) return 'bomber';
  if (r < (acc += spitter)) return 'spitter';
  return 'shambler';
}

function spawnZombie() {
  if (aliveZombies() >= HORDE_CAP) return;
  const { x, z } = edgeSpawnPoint();
  const baseHp = zombieHpForRound(round);
  const type = pickZombieType();
  let cfg;
  if (type === 'runner') {
    cfg = { color: 0xc2d27a, scale: 0.78, hp: Math.max(1, baseHp - 1), speedBonus: 2.6 + Math.min(2, round * 0.06), cashReward: 15, contactDmg: 5 };
  } else if (type === 'brute') {
    cfg = { color: 0x3f5236, scale: 1.7, hp: baseHp * 2 + 3, speedBonus: -0.6, cashReward: 25, contactDmg: 14 };
  } else if (type === 'bomber') {
    cfg = { color: 0xe8702a, scale: 0.95, hp: Math.max(1, baseHp - 1), speedBonus: 1.0 + Math.min(1.5, round * 0.05), cashReward: 22, contactDmg: 0 };
  } else if (type === 'spitter') {
    cfg = { color: 0x6cc24a, scale: 1.0, hp: baseHp + 1, speedBonus: -0.2, cashReward: 20, contactDmg: 6 };
  } else {
    cfg = { color: ZOMBIE_COLORS[Math.floor(Math.random() * ZOMBIE_COLORS.length)], scale: 1, hp: baseHp, speedBonus: Math.min(2.2, round * 0.1), cashReward: 10, contactDmg: 7 };
  }
  addNPC({ ...cfg, x, z, zombie: true, type });
  zSpawned++;
  setOnline();
}

function spawnBoss() {
  const { x, z } = edgeSpawnPoint();
  const hp = 28 + round * 8;
  const boss = addNPC({ color: 0x6a2233, x, z, zombie: true, type: 'boss', scale: 2.5, hp, speedBonus: -0.7, cashReward: 300, contactDmg: 22 });
  boss.hb.sprite.visible = false; // uses the big top bar instead
  zSpawned++;
  zTarget++;
  showBossBar(boss);
  sfx.groan();
  setOnline();
}

let groanTimer = 3;
function updateHorde(dt) {
  if (damageFlash > 0) {
    damageFlash = Math.max(0, damageFlash - dt * 1.6);
    vignette.style.opacity = String(damageFlash);
  }
  if (!hordeMode) return;
  // a dead solo player stops the sim; a dead host keeps it alive for clients
  if (gameOver && !(mpActive() && mpIsHost())) return;

  // occasional ambient groans from the horde
  groanTimer -= dt;
  if (groanTimer <= 0) {
    groanTimer = 1.8 + Math.random() * 3.5;
    if (aliveZombies() > 0) sfx.groan();
  }

  if (intermission > 0) {
    intermission -= dt;
    if (intermission <= 0) beginRound(round + 1);
    return;
  }

  // spawn the wave from the edges, ramping with the round
  if (zSpawned < zTarget) {
    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = Math.max(0.35, 1.7 - round * 0.06);
      const burst = 1 + Math.floor(round / 4);
      for (let i = 0; i < burst && zSpawned < zTarget; i++) spawnZombie();
    }
  } else if (aliveZombies() === 0) {
    // wave cleared → short breather, then next (harder) round
    toast(`✅ Round ${round} survived!`);
    sfx.waveCleared();
    intermission = 5;
  }
}

function damagePlayer(amount) {
  if (gameOver || spectating) return;
  playerHP = Math.max(0, playerHP - amount);
  sfx.hurt();
  damageFlash = 0.85;
  vignette.style.opacity = '0.85';
  updatePlayerHP();
  // in co-op a death only downs you — you respawn next round if a teammate lives
  if (playerHP <= 0) { if (mpActive() && anyTeammateAlive()) downPlayer(); else endGame(); }
}

function endGame() {
  gameOver = true;
  started = false;
  frozenTimer = 0; playerIce.visible = false; frostOverlay.style.opacity = '0';
  sfx.death();
  sfx.calmMusic();
  document.exitPointerLock?.();
  renderer.domElement.style.cursor = 'default';
  ui.crosshair.style.display = 'none';
  deathOverlay.querySelector('#death-stats').textContent =
    `You reached Round ${round} and eliminated ${eliminations} penguins.`;
  deathOverlay.style.display = 'flex';
}

function damageNPC(npc, dmg, point, headshot = false, attackerId = mpMyId()) {
  if (npc.dead) return;
  if (!hordeMode) startHorde();
  const mine = attackerId === mpMyId();
  npc.hp -= dmg;
  npc.hitFlash = 0.2;
  if (npc.type !== 'boss') {
    npc.hb.sprite.visible = true;
    npc.hb.set(Math.max(0, npc.hp) / npc.maxHp);
  } else {
    updateBossBar();
  }
  spawnBloodBurst(point);
  if (npc.hp <= 0) { if (mine) showHitMarker(true); killNPC(npc, point, headshot, attackerId); }
  else if (mine) { showHitMarker(false); sfx.hit(); if (headshot) floatText('HEADSHOT', point, '#ffd23f', 18); earnCash(headshot ? 3 : 1); }
}

function killNPC(npc, point, headshot = false, attackerId = mpMyId()) {
  if (npc.dead) return;
  npc.dead = true;
  npc.deathT = 0;
  npc.tag.visible = false;
  npc.hb.sprite.visible = false;
  dismissMpStatus();
  const mine = attackerId === mpMyId();
  if (hordeMode && intermission <= 0) zKilled++;
  // bombers detonate when they die — shoot them from a safe distance!
  if (npc.type === 'bomber') explodeAt(npc.group.position);
  // award the kill to whoever landed it (locally if it was us, else via the feed)
  const base = Math.round((npc.cashReward || 10) * (headshot ? 1.5 : 1));
  if (mine) {
    eliminations++;
    if (npc.type === 'boss') sfx.bossDeath();
    else if (headshot) { sfx.headshotKill(); floatText('HEADSHOT KILL!', point, '#ffd23f', 22); }
    else if (npc.type !== 'bomber') sfx.kill();
    const mult = registerKillCombo();
    earnCash(Math.round(base * mult), point);
  } else {
    if (npc.type === 'boss') sfx.bossDeath(); // everyone hears the boss fall
    pushKill(attackerId, base, headshot, point);
  }
  if (npc === bossRef) { bossBar.style.display = 'none'; bossRef = null; }
  // random ammo drop — scarce; bigger threats are a bit more generous
  const dropChance = npc.type === 'boss' ? 1 : npc.type === 'brute' ? 0.45 : 0.24;
  if (hordeMode && Math.random() < dropChance) {
    const amt = npc.type === 'boss' ? 40 : npc.type === 'brute' ? 16 : 6 + Math.floor(Math.random() * 6);
    spawnAmmoDrop(npc.group.position.x, npc.group.position.z, amt);
  }
  setOnline();
  updateWeaponHUD();
  spawnBloodPool(npc.group.position.x, npc.group.position.z);
  spawnBloodBurst(point);
}

// =====================================================================
//  Med packs — the only way to heal
// =====================================================================
const medpacks = [];
let medTimer = 38;
const MED_HEAL = 24;

function makeMedpack() {
  const g = new THREE.Group();
  const box = mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), mat(0xffffff, 0.5));
  box.position.y = 0.45; box.castShadow = true; g.add(box);
  // red cross on the sides
  const crossMat = mat(0xe5384d, 0.5);
  for (const ry of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const v = mesh(new THREE.BoxGeometry(0.16, 0.5, 0.02), crossMat, false, false);
    const h = mesh(new THREE.BoxGeometry(0.5, 0.16, 0.02), crossMat, false, false);
    for (const m of [v, h]) {
      m.position.set(Math.sin(ry) * 0.41, 0.45, Math.cos(ry) * 0.41);
      m.rotation.y = ry; g.add(m);
    }
  }
  const glow = mesh(new THREE.TorusGeometry(0.7, 0.05, 8, 24), new THREE.MeshStandardMaterial({ color: 0x46d65f, emissive: 0x2fbf5e, emissiveIntensity: 1.4 }), false, false);
  glow.rotation.x = Math.PI / 2; glow.position.y = 0.1; g.add(glow);
  const beam = mesh(new THREE.CylinderGeometry(0.05, 0.05, 5, 8), new THREE.MeshBasicMaterial({ color: 0x46d65f, transparent: true, opacity: 0.22, depthWrite: false }), false, false);
  beam.position.y = 2.6; g.add(beam);
  return g;
}

function spawnMedpack() {
  if (medpacks.length >= 2) return;
  let x = 0, z = 0, tries = 0;
  do {
    const a = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 38;
    x = Math.cos(a) * r; z = Math.sin(a) * r; tries++;
  } while (collides({ x, z }) && tries < 12);
  const g = makeMedpack();
  g.position.set(x, 0, z);
  world.add(g);
  medpacks.push({ id: nextNetId++, group: g, x, z, bob: Math.random() * 6 });
}

function updateMedpacks(dt, t) {
  if (hordeMode && !gameOver) {
    medTimer -= dt;
    if (medTimer <= 0) { medTimer = 42 + Math.random() * 22; spawnMedpack(); }
  }
  for (let i = medpacks.length - 1; i >= 0; i--) {
    const m = medpacks[i];
    m.group.rotation.y += dt * 1.5;
    m.group.position.y = Math.sin(t * 2 + m.bob) * 0.18 + 0.1;
    if (started && !gameOver && Math.hypot(player.group.position.x - m.x, player.group.position.z - m.z) < 1.9) {
      if (playerHP < PLAYER_MAX_HP) {
        playerHP = Math.min(PLAYER_MAX_HP, playerHP + MED_HEAL);
        updatePlayerHP();
        damageFlash = 0; vignette.style.opacity = '0';
        sfx.med();
        toast(`➕ Med pack — +${MED_HEAL} HP`);
        world.remove(m.group);
        medpacks.splice(i, 1);
      }
    }
  }
}

// =====================================================================
//  Ammo drops — enemies randomly drop spare rounds on death
// =====================================================================
const ammoDrops = [];
const MAP_AMMO_CAP = 54;   // max spare rounds allowed lying on the ground at once
function groundAmmoTotal() {
  let s = 0;
  for (const a of ammoDrops) s += a.amount;
  return s;
}
function makeAmmoBox() {
  const g = new THREE.Group();
  const box = mesh(new THREE.BoxGeometry(0.7, 0.45, 0.5), mat(0x4a5a2e, 0.7));
  box.position.y = 0.32; box.castShadow = true; g.add(box);
  const lid = mesh(new THREE.BoxGeometry(0.74, 0.12, 0.54), mat(0x3a471f, 0.7));
  lid.position.y = 0.56; g.add(lid);
  // little brass rounds poking out the top
  for (const dx of [-0.18, 0, 0.18]) {
    const r = mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 8), mat(0xffc94a, 0.3), false, false);
    r.position.set(dx, 0.7, 0); g.add(r);
  }
  const glow = mesh(new THREE.TorusGeometry(0.55, 0.045, 8, 22), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb01a, emissiveIntensity: 1.3 }), false, false);
  glow.rotation.x = Math.PI / 2; glow.position.y = 0.1; g.add(glow);
  const beam = mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.5, 8), new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.2, depthWrite: false }), false, false);
  beam.position.y = 2.4; g.add(beam);
  return g;
}
function spawnAmmoDrop(x, z, amount) {
  // hard cap on how much ammo can sit uncollected on the map — keeps it scarce
  if (groundAmmoTotal() >= MAP_AMMO_CAP) return;
  amount = Math.min(amount, MAP_AMMO_CAP - groundAmmoTotal());
  if (amount <= 0) return;
  // pull edge/out-of-bounds kills back inside the wall so the drop is reachable
  const r = Math.hypot(x, z);
  if (r > 100) { const k = 100 / r; x *= k; z *= k; }
  const g = makeAmmoBox();
  g.position.set(x, 0, z);
  world.add(g);
  ammoDrops.push({ id: nextNetId++, group: g, x, z, amount, bob: Math.random() * 6, age: 0 });
}
const AMMO_TTL = 120;  // seconds before an uncollected ammo box despawns
function updateAmmoDrops(dt, t) {
  for (let i = ammoDrops.length - 1; i >= 0; i--) {
    const a = ammoDrops[i];
    a.age += dt;
    // clean up: expired, or out of bounds (beyond the wall, unreachable)
    if (a.age > AMMO_TTL || Math.hypot(a.x, a.z) > 104) {
      world.remove(a.group);
      ammoDrops.splice(i, 1);
      continue;
    }
    a.group.rotation.y += dt * 1.8;
    a.group.position.y = Math.sin(t * 2.4 + a.bob) * 0.14 + 0.06;
    // blink in the final few seconds so it's clear it's about to vanish
    a.group.visible = a.age < AMMO_TTL - 6 || Math.sin(a.age * 14) > 0;
    if (started && !gameOver && hasGun && Math.hypot(player.group.position.x - a.x, player.group.position.z - a.z) < 1.9) {
      if (ammoReserve < RESERVE_MAX) {
        ammoReserve = Math.min(RESERVE_MAX, ammoReserve + a.amount);
        updateWeaponHUD();
        sfx.pickup();
        floatText(`+${a.amount} AMMO`, new THREE.Vector3(a.x, 1.2, a.z), '#ffd23f', 18);
        world.remove(a.group);
        ammoDrops.splice(i, 1);
      }
    }
  }
}

// =====================================================================
//  Snow particles
// =====================================================================
const snowCount = 1100;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(snowCount * 3);
const snowSpeed = new Float32Array(snowCount);
for (let i = 0; i < snowCount; i++) {
  snowPos[i * 3] = (Math.random() - 0.5) * 140;
  snowPos[i * 3 + 1] = Math.random() * 50 + 2;
  snowPos[i * 3 + 2] = (Math.random() - 0.5) * 140;
  snowSpeed[i] = 0.6 + Math.random() * 1.3;
}
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowPoints = new THREE.Points(snowGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.18, transparent: true, opacity: 0.85, depthWrite: false,
}));
scene.add(snowPoints);

// =====================================================================
//  Snowballs
// =====================================================================
const snowballs = [];
const snowballGeo = new THREE.SphereGeometry(0.28, 12, 10);
const snowballMat = mat(0xffffff, 0.6);
let snowballsThrown = 0;
const poofs = [];

function throwSnowball() {
  if (!started) return;
  const origin = player.group.position.clone().add(new THREE.Vector3(0, 2.1, 0));
  // throw toward where the cursor is pointing
  const dir = aimRay().direction.clone();
  const ball = mesh(snowballGeo, snowballMat, true, false);
  ball.position.copy(origin);
  world.add(ball);
  const vel = dir.multiplyScalar(26).add(new THREE.Vector3(0, 3.5, 0));
  snowballs.push({ mesh: ball, vel, life: 0 });
  snowballsThrown++;
  ui.snowballCount.textContent = snowballsThrown;
  sfx.snowball();
}

function spawnPoof(pos) {
  const group = new THREE.Group();
  group.position.copy(pos);
  const bits = [];
  for (let i = 0; i < 8; i++) {
    const b = mesh(new THREE.SphereGeometry(0.12, 6, 6), mat(0xffffff, 0.6), false, false);
    const v = new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3 + 1, (Math.random() - 0.5) * 4);
    group.add(b);
    bits.push({ mesh: b, vel: v });
  }
  world.add(group);
  poofs.push({ group, bits, life: 0 });
}

function updateSnowballs(dt) {
  for (let i = snowballs.length - 1; i >= 0; i--) {
    const s = snowballs[i];
    s.life += dt;
    s.vel.y -= 22 * dt;
    s.mesh.position.addScaledVector(s.vel, dt);
    let hit = s.mesh.position.y <= 0.28;
    // check NPC hits
    if (!hit) {
      for (const npc of npcs) {
        if (npc.dead) continue;
        const hp = npc.group.position;
        if (s.mesh.position.distanceTo(new THREE.Vector3(hp.x, hp.y + 1.4, hp.z)) < 1.2) {
          hit = true;
          showEmote(npc.group, ['😮', '😄', '🎉'][Math.floor(Math.random() * 3)]);
          npc.hitFlash = 0.4;
          break;
        }
      }
    }
    if (hit || s.life > 4) {
      spawnPoof(s.mesh.position.clone());
      world.remove(s.mesh);
      snowballs.splice(i, 1);
    }
  }
  for (let i = poofs.length - 1; i >= 0; i--) {
    const p = poofs[i];
    p.life += dt;
    for (const b of p.bits) {
      b.vel.y -= 12 * dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.material.opacity = Math.max(0, 1 - p.life / 0.6);
      b.mesh.material.transparent = true;
    }
    if (p.life > 0.6) {
      world.remove(p.group);
      poofs.splice(i, 1);
    }
  }
}

// =====================================================================
//  Weapons: pistol pickup, shooting, blood & eliminations
//  (cartoon NPC violence — "rated R" mode)
// =====================================================================
let hasGun = false;
let ammo = 12;
let MAG_SIZE = 12;
let ammoReserve = 36;       // spare rounds outside the magazine
let RESERVE_MAX = 96;       // cap on carried reserve
let reloading = false;
let eliminations = 0;

// --- weapon HUD pills ---
const statusBar = document.querySelector('#status');
const ammoPill = document.createElement('div');
ammoPill.className = 'status-pill';
ammoPill.style.display = 'none';
const elimPill = document.createElement('div');
elimPill.className = 'status-pill';
elimPill.style.display = 'none';
statusBar.appendChild(elimPill);
statusBar.appendChild(ammoPill);
function updateWeaponHUD() {
  const mag = reloading ? '· · ·' : ammo;
  const low = ammoReserve === 0 && ammo === 0;
  ammoPill.innerHTML = `🔫 <span>${mag}</span> <span style="opacity:.6">| ${ammoReserve}</span>`;
  ammoPill.style.color = low ? '#ff6b6b' : '';
  elimPill.innerHTML = `💀 <span>${eliminations}</span>`;
}
function setOnline() { ui.online.textContent = aliveZombies() + 1; }

// --- pistol model ---
function makePistol(scale = 1) {
  const g = new THREE.Group();
  const metal = mat(0x23262b, 0.4);
  const dark = mat(0x14161a, 0.5);
  const slide = mesh(new THREE.BoxGeometry(0.16, 0.26, 0.95), metal); slide.position.set(0, 0.1, 0.1); g.add(slide);
  const barrel = mesh(new THREE.BoxGeometry(0.12, 0.16, 1.05), dark); barrel.position.set(0, 0.1, 0.15); g.add(barrel);
  const grip = mesh(new THREE.BoxGeometry(0.15, 0.5, 0.28), dark); grip.position.set(0, -0.2, -0.28); grip.rotation.x = 0.32; g.add(grip);
  const trigger = mesh(new THREE.BoxGeometry(0.1, 0.16, 0.1), dark); trigger.position.set(0, -0.05, -0.12); g.add(trigger);
  g.scale.setScalar(scale);
  g.children.forEach((m) => (m.castShadow = true));
  return g;
}

// (the pistol now lives on the weapon-shop counter — see the shop block above)

// --- gun held by the player (hidden until picked up) ---
const playerGun = makePistol(0.85);
playerGun.position.set(0.55, 1.25, 0.5);
playerGun.visible = false;
player.group.add(playerGun);
const muzzlePoint = new THREE.Object3D();
muzzlePoint.position.set(0, 0.1, 0.75);
playerGun.add(muzzlePoint);

// --- first-person viewmodel: a flipper-arm holding the pistol (COD style) ---
scene.add(camera); // so camera-attached viewmodel renders
const fpViewmodel = new THREE.Group();
fpViewmodel.visible = false;
camera.add(fpViewmodel);
// arm (a chunky penguin flipper coming up from bottom-right)
const fpArmMat = mat(playerColor, 0.6);
const fpArm = mesh(new THREE.BoxGeometry(0.16, 0.16, 0.62), fpArmMat, false, false);
fpArm.position.set(0.05, -0.05, -0.34);
const fpHand = mesh(new THREE.BoxGeometry(0.2, 0.2, 0.22), fpArmMat, false, false);
fpHand.position.set(0, -0.02, -0.62);
// the gun itself
const fpGun = makePistol(0.95);
fpGun.position.set(0, 0, -0.55);
fpGun.rotation.y = Math.PI; // point it forward (away from camera)
const fpMuzzle = new THREE.Object3D();
fpMuzzle.position.set(0, 0.1, -0.95);
fpViewmodel.add(fpArm, fpHand, fpGun, fpMuzzle);
// rest pose in the lower-right of the view
const FP_REST = new THREE.Vector3(0.28, -0.26, -0.5);
fpViewmodel.position.copy(FP_REST);
fpViewmodel.traverse((m) => { if (m.isMesh) { m.renderOrder = 999; m.material.depthTest = true; } });
let fpBob = 0;

// --- muzzle flash sprite ---
const flashTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,210,1)');
  g.addColorStop(0.4, 'rgba(255,180,60,0.8)');
  g.addColorStop(1, 'rgba(255,120,20,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();
const muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
muzzleFlash.scale.set(1.1, 1.1, 1);
muzzleFlash.visible = false;
world.add(muzzleFlash);
let muzzleTimer = 0;
let recoil = 0;

// --- blood splat decal texture ---
const bloodTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const ctx = c.getContext('2d');
  function blob(cx, cy, r, a) {
    ctx.fillStyle = `rgba(${120 + Math.random() * 40 | 0},0,0,${a})`;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  }
  blob(128, 128, 70, 0.92);
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 50 + Math.random() * 95;
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 6 + Math.random() * 26, 0.6 + Math.random() * 0.35);
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
})();

const tracers = [];
const bloodBits = [];
const bloodPools = [];

function pickupGunNow() {
  hasGun = true;
  playerGun.visible = true;
  shopGun.visible = false;
  shopGunGlow.visible = false;
  ammo = MAG_SIZE;
  ammoPill.style.display = '';
  elimPill.style.display = '';
  updateWeaponHUD();
  // make the crosshair an aggressive red reticle
  ui.crosshair.style.borderColor = 'rgba(255,70,70,.95)';
  ui.crosshair.style.boxShadow = '0 0 0 2px rgba(0,0,0,.2), 0 0 10px rgba(255,40,40,.6)';
  sfx.pickup();
  toast('🔫 Picked up the PISTOL — Click to fire, R to reload');
}

const _ray = new THREE.Ray();
const _tmp = new THREE.Vector3();
// pistol damage drop-off: full power up close, tapering to a floor at range
const DMG_NEAR = 16;     // full damage within this many units
const DMG_FAR = 60;      // minimum damage beyond this range
const DMG_MIN = 0.4;     // floor multiplier at long range
function damageFalloff(dist) {
  if (dist <= DMG_NEAR) return 1;
  if (dist >= DMG_FAR) return DMG_MIN;
  const f = (dist - DMG_NEAR) / (DMG_FAR - DMG_NEAR); // 0→1 across the band
  return 1 - (1 - DMG_MIN) * f;
}

function fire() {
  if (reloading) return;
  if (ammo <= 0) {
    if (ammoReserve > 0) reloadGun();
    else sfx.dryFire(); // out of ammo entirely — find some drops!
    return;
  }
  ammo--;
  localFireSeq++;
  updateWeaponHUD();
  sfx.shot();
  if (ammo === 0 && ammoReserve > 0) reloadGun(); // auto-reload when the mag runs dry
  recoil = 0.5;
  muzzleTimer = 0.05;

  const ar = aimRay();
  _ray.origin.copy(ar.origin);
  _ray.direction.copy(ar.direction);

  // hitscan against whichever entities this machine owns: the host/solo client
  // tests real NPCs; a network client tests the host's ghost zombies.
  const isClient = netRole() === 'client';
  let best = null, bestAlong = Infinity, bestCenter = null, bestScale = 1, bestType = '', bestNid = 0;
  if (isClient) {
    for (const [nid, g] of ghosts) {
      if (g.dead) continue;
      const p = g.pen.group.position;
      const center = _tmp.set(p.x, p.y + 1.2, p.z);
      const along = _ray.direction.dot(center.clone().sub(_ray.origin));
      if (along < 0.5 || along > 120) continue;
      const onRay = _ray.at(along, new THREE.Vector3());
      if (onRay.distanceTo(center) < 1.45 && along < bestAlong) {
        best = g; bestAlong = along; bestCenter = center.clone(); bestScale = g.scale; bestType = g.type; bestNid = nid;
      }
    }
  } else {
    for (const npc of npcs) {
      if (npc.dead) continue;
      const center = _tmp.set(npc.group.position.x, npc.group.position.y + 1.2, npc.group.position.z);
      const along = _ray.direction.dot(center.clone().sub(_ray.origin));
      if (along < 0.5 || along > 120) continue;
      const onRay = _ray.at(along, new THREE.Vector3());
      if (onRay.distanceTo(center) < 1.45 && along < bestAlong) {
        best = npc; bestAlong = along; bestCenter = center.clone(); bestScale = npc.scale; bestType = npc.type; bestNid = npc.netId;
      }
    }
  }

  const muzzleWorld = new THREE.Vector3();
  (firstPerson ? fpMuzzle : muzzlePoint).getWorldPosition(muzzleWorld);
  muzzleFlash.position.copy(muzzleWorld);
  muzzleFlash.visible = true;

  let endPoint;
  if (best) {
    endPoint = bestCenter;
    const onRay = _ray.at(bestAlong, new THREE.Vector3());
    const groupY = best.group ? best.group.position.y : best.pen.group.position.y;
    const headshot = bestType !== 'boss' && onRay.y >= groupY + 1.7 * bestScale;
    const dmg = gunDamage * (headshot ? 2 : 1) * damageFalloff(bestAlong);
    if (isClient) {
      // report to the host; show local feedback immediately
      hitOut.push({ nid: bestNid, dmg, hs: headshot });
      spawnBloodBurst(bestCenter.clone());
      showHitMarker(false);
      sfx.hit();
      if (headshot) floatText('HEADSHOT', bestCenter.clone(), '#ffd23f', 18);
    } else {
      damageNPC(best, dmg, bestCenter.clone(), headshot);
    }
  } else {
    endPoint = _ray.at(80, new THREE.Vector3());
  }
  spawnTracer(muzzleWorld, endPoint);
}

function reloadGun() {
  if (reloading || ammo === MAG_SIZE) return;
  if (ammoReserve <= 0) { sfx.dryFire(); toast('Out of ammo! Grab some from the fallen.'); return; }
  reloading = true;
  updateWeaponHUD();
  sfx.reload();
  toast('Reloading…');
  setTimeout(() => {
    const need = MAG_SIZE - ammo;
    const take = Math.min(need, ammoReserve);
    ammo += take;
    ammoReserve -= take;
    reloading = false;
    updateWeaponHUD();
  }, 900);
}

function spawnTracer(a, b) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.9 }));
  world.add(line);
  tracers.push({ line, life: 0 });
}

function spawnBloodBurst(point) {
  for (let i = 0; i < 22; i++) {
    const r = 0.05 + Math.random() * 0.1;
    const b = mesh(new THREE.SphereGeometry(r, 6, 6), new THREE.MeshStandardMaterial({ color: 0x9e0606, roughness: 0.6 }), false, false);
    b.position.copy(point);
    const v = new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 6 + 1, (Math.random() - 0.5) * 7);
    world.add(b);
    bloodBits.push({ mesh: b, vel: v, life: 0 });
  }
}

function spawnBloodPool(x, z) {
  const size = 1.4 + Math.random() * 1.2;
  const pool = mesh(new THREE.CircleGeometry(size, 20), new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, opacity: 0, depthWrite: false }), false, false);
  pool.rotation.x = -Math.PI / 2;
  pool.rotation.z = Math.random() * Math.PI * 2;
  pool.position.set(x, 0.05, z);
  world.add(pool);
  bloodPools.push({ mesh: pool, grow: 0 });
  // cap the number of pools to keep things performant
  if (bloodPools.length > 36) {
    const old = bloodPools.shift();
    world.remove(old.mesh);
  }
}

// --- bomber explosions ---
const blasts = [];
function explodeAt(pos) {
  sfx.explosion();
  const d = Math.hypot(player.group.position.x - pos.x, player.group.position.z - pos.z);
  if (d < 4.5 && !gameOver && started) damagePlayer(Math.round(8 + 22 * (1 - d / 4.5)));
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, color: 0xff8a2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  spr.position.set(pos.x, 1.0, pos.z);
  world.add(spr);
  blasts.push({ spr, life: 0 });
  spawnBloodPool(pos.x, pos.z);
}
function updateBlasts(dt) {
  for (let i = blasts.length - 1; i >= 0; i--) {
    const b = blasts[i];
    b.life += dt;
    const s = 2 + b.life * 26;
    b.spr.scale.set(s, s, 1);
    b.spr.material.opacity = Math.max(0, 1 - b.life / 0.45);
    if (b.life > 0.45) { world.remove(b.spr); blasts.splice(i, 1); }
  }
}

// --- spitter projectiles ---
const spits = [];
function spawnSpit(from, target) {
  const m = mesh(new THREE.SphereGeometry(0.24, 10, 10), new THREE.MeshStandardMaterial({ color: 0x9be060, emissive: 0x4a8a2a, emissiveIntensity: 0.7 }), false, false);
  m.position.copy(from);
  world.add(m);
  const dir = new THREE.Vector3(target.x - from.x, 0, target.z - from.z);
  const dist = dir.length();
  dir.normalize();
  const vel = dir.multiplyScalar(16);
  vel.y = dist * 0.05 + 2.4; // gentle arc
  spits.push({ m, vel, life: 0 });
}
function updateSpits(dt) {
  for (let i = spits.length - 1; i >= 0; i--) {
    const s = spits[i];
    s.life += dt;
    s.vel.y -= 14 * dt;
    s.m.position.addScaledVector(s.vel, dt);
    const hit = Math.hypot(player.group.position.x - s.m.position.x, player.group.position.z - s.m.position.z);
    if (!gameOver && started && hit < 1.3 && s.m.position.y < 2.4) {
      sfx.splat(); damagePlayer(9); world.remove(s.m); spits.splice(i, 1); continue;
    }
    if (s.m.position.y < 0.1 || s.life > 4) { world.remove(s.m); spits.splice(i, 1); }
  }
}

// =====================================================================
//  Boss abilities — freezing ice bombardment + hurling fast penguins
// =====================================================================
const ICE_GRAV = 16;
const CRATER_R = 2.4;       // freeze radius
const CRATER_ARM = 0.45;    // brief telegraph before it can freeze you
const CRATER_LIFE = 7;      // total lifetime on the ground
const FREEZE_TIME = 2.4;    // seconds locked in place
let frozenTimer = 0;
let nextCraterId = 1;

// translucent ice block that encases the local penguin while frozen
const playerIce = mesh(
  new THREE.BoxGeometry(1.7, 2.3, 1.7),
  new THREE.MeshStandardMaterial({ color: 0xbfeaff, transparent: true, opacity: 0.42, roughness: 0.1, metalness: 0.1, emissive: 0x5fb0e6, emissiveIntensity: 0.35 }),
  false, false
);
playerIce.position.y = 1.05;
playerIce.visible = false;
player.group.add(playerIce);

// frosty screen overlay shown while frozen
const frostOverlay = document.createElement('div');
frostOverlay.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;background:radial-gradient(120% 120% at 50% 50%, transparent 28%, rgba(150,220,255,.5) 78%, rgba(205,240,255,.85));transition:opacity .15s';
document.body.appendChild(frostOverlay);

function freezePlayer() {
  if (frozenTimer > 0 || gameOver || spectating || !started) return;
  frozenTimer = FREEZE_TIME;
  velocity.set(0, 0, 0);
  playerIce.visible = true;
  frostOverlay.style.opacity = '1';
  sfx.freeze();
  toast('🧊 Frozen solid! Mash WASD to break free!');
}
// freeze the local player if they're standing on an armed crater at (x,z)
function tryFreezeAt(x, z) {
  if (frozenTimer > 0 || gameOver || spectating || !started) return;
  const p = player.group.position;
  if (Math.hypot(p.x - x, p.z - z) < CRATER_R - 0.3) freezePlayer();
}

// --- ice balls (the boss lobs these to seed craters near the player) ---
const iceBalls = [];
function spawnIceBall(from, tx, tz) {
  const m = mesh(
    new THREE.IcosahedronGeometry(0.42, 0),
    new THREE.MeshStandardMaterial({ color: 0xcdeeff, emissive: 0x4fa6e0, emissiveIntensity: 0.7, roughness: 0.25, metalness: 0.1 }),
    false, false
  );
  m.position.copy(from);
  world.add(m);
  const dx = tx - from.x, dz = tz - from.z;
  const dist = Math.hypot(dx, dz) || 1;
  const T = clamp(dist / 18, 0.6, 1.7);             // flight time
  const vel = new THREE.Vector3(dx / T, 0, dz / T);
  vel.y = 0.5 * ICE_GRAV * T - from.y / T;          // arc that returns to the ground
  iceBalls.push({ m, vel, tx, tz, life: 0, spin: 4 + Math.random() * 5 });
}
function updateIceBalls(dt) {
  for (let i = iceBalls.length - 1; i >= 0; i--) {
    const b = iceBalls[i];
    b.life += dt;
    b.vel.y -= ICE_GRAV * dt;
    b.m.position.addScaledVector(b.vel, dt);
    b.m.rotation.x += b.spin * dt; b.m.rotation.y += b.spin * 0.7 * dt;
    if (b.m.position.y <= 0.12 || b.life > 4) {
      spawnIceCrater(b.tx, b.tz);
      world.remove(b.m); iceBalls.splice(i, 1);
    }
  }
}

// --- ice craters (the actual freeze hazard) ---
const iceCraters = [];
function makeCraterMesh() {
  const g = new THREE.Group();
  const disc = mesh(new THREE.CircleGeometry(CRATER_R, 26), new THREE.MeshStandardMaterial({ color: 0xa9e4ff, emissive: 0x3f8fd0, emissiveIntensity: 0.4, transparent: true, opacity: 0.8, roughness: 0.2 }), false, false);
  disc.rotation.x = -Math.PI / 2; disc.position.y = 0.07; g.add(disc);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.random();
    const r = CRATER_R * (0.35 + Math.random() * 0.55);
    const shard = mesh(new THREE.ConeGeometry(0.16, 0.5 + Math.random() * 0.6, 5), new THREE.MeshStandardMaterial({ color: 0xe2f5ff, emissive: 0x6fb6e6, emissiveIntensity: 0.45, transparent: true, opacity: 0.9 }), false, false);
    shard.position.set(Math.cos(a) * r, 0.25, Math.sin(a) * r);
    shard.rotation.z = (Math.random() - 0.5) * 0.6;
    g.add(shard);
  }
  return g;
}
function setCraterOpacity(group, o) {
  group.traverse((c) => { if (c.material) c.material.opacity = (c.geometry && c.geometry.type === 'ConeGeometry' ? 0.9 : 0.8) * o; });
}
function spawnIceCrater(x, z) {
  const group = makeCraterMesh();
  group.position.set(x, 0, z);
  world.add(group);
  iceCraters.push({ id: nextCraterId++, x, z, group, life: 0 });
  sfx.iceCrack();
}
function craterArmed(life) { return life > CRATER_ARM && life < CRATER_LIFE - 0.8; }
function updateIceCraters(dt) {
  for (let i = iceCraters.length - 1; i >= 0; i--) {
    const c = iceCraters[i];
    c.life += dt;
    const fade = c.life < CRATER_ARM ? c.life / CRATER_ARM
      : c.life > CRATER_LIFE - 1 ? Math.max(0, CRATER_LIFE - c.life) : 1;
    setCraterOpacity(c.group, fade);
    if (c.life >= CRATER_LIFE) { world.remove(c.group); iceCraters.splice(i, 1); continue; }
    if (craterArmed(c.life)) tryFreezeAt(c.x, c.z);
  }
}

// the boss hurls a fast penguin on a ballistic arc at the player
function throwPenguin(from, tgt) {
  const hp = Math.max(1, zombieHpForRound(round) - 1);
  const p = addNPC({ color: 0xc2d27a, x: from.x, z: from.z, zombie: true, type: 'runner', scale: 0.78, hp, speedBonus: 3.0, cashReward: 12, contactDmg: 5 });
  const y0 = (from.y || 3) + 1.4;
  p.group.position.y = y0;
  const dx = tgt.x - from.x, dz = tgt.z - from.z;
  const dist = Math.hypot(dx, dz) || 1;
  const T = clamp(dist / 15, 0.5, 1.4);
  p.flying = true;
  p.fvx = dx / T; p.fvz = dz / T;
  p.fvy = 0.5 * ICE_GRAV * T + 3;
  sfx.groan();
}

// client mirror: render the host's craters and freeze ourselves if we step in one
const ghostCraters = new Map(); // id -> { group }
function clientCraters() {
  const arr = getGlobal('craters') || [];
  const seen = new Set();
  for (const e of arr) {
    const [id, x, z, armed] = e;
    seen.add(id);
    let gc = ghostCraters.get(id);
    if (!gc) {
      const group = makeCraterMesh();
      group.position.set(x, 0, z);
      world.add(group);
      gc = { group };
      ghostCraters.set(id, gc);
    }
    if (armed) tryFreezeAt(x, z);
  }
  for (const [id, gc] of ghostCraters) {
    if (!seen.has(id)) { world.remove(gc.group); ghostCraters.delete(id); }
  }
}

function updateWeapons(dt) {
  // pickup proximity
  if (!hasGun && shopGun.visible) {
    shopGun.rotation.y += dt * 1.3;
    shopGun.position.y = 1.85 + Math.sin(clock.elapsedTime * 2) * 0.08;
    shopGunGlow.rotation.z += dt * 2;
  }
  // recoil + muzzle flash
  recoil = Math.max(0, recoil - dt * 4);
  playerGun.rotation.x = -recoil;

  // first-person viewmodel: show only when zoomed in & armed (never while spectating)
  fpViewmodel.visible = firstPerson && hasGun && !spectating;
  if (fpViewmodel.visible) {
    const bobAmt = moving && onGround ? 1 : 0;
    fpBob += dt * (moving ? 10 : 4);
    const bx = Math.cos(fpBob) * 0.012 * bobAmt;
    const by = Math.abs(Math.sin(fpBob)) * 0.02 * bobAmt;
    fpViewmodel.position.set(FP_REST.x + bx, FP_REST.y + by - recoil * 0.05, FP_REST.z + recoil * 0.12);
    fpViewmodel.rotation.x = recoil * 0.5;
  }
  if (muzzleTimer > 0) {
    muzzleTimer -= dt;
    muzzleFlash.material.rotation = Math.random() * Math.PI;
    if (muzzleTimer <= 0) muzzleFlash.visible = false;
  }
  // tracers fade fast
  for (let i = tracers.length - 1; i >= 0; i--) {
    const tr = tracers[i];
    tr.life += dt;
    tr.line.material.opacity = Math.max(0, 0.9 - tr.life / 0.08);
    if (tr.life > 0.08) { world.remove(tr.line); tr.line.geometry.dispose(); tracers.splice(i, 1); }
  }
  // blood droplets with gravity, stick on the ground
  for (let i = bloodBits.length - 1; i >= 0; i--) {
    const b = bloodBits[i];
    b.life += dt;
    b.vel.y -= 20 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    if (b.mesh.position.y < 0.05) {
      b.mesh.position.y = 0.05;
      b.vel.set(0, 0, 0);
    }
    if (b.life > 2.5) { world.remove(b.mesh); bloodBits.splice(i, 1); }
  }
  // blood pools fade in
  for (const bp of bloodPools) {
    if (bp.grow < 1) { bp.grow = Math.min(1, bp.grow + dt * 3); bp.mesh.material.opacity = bp.grow * 0.92; }
  }
}

// =====================================================================
//  Toasts
// =====================================================================
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast-msg';
  el.textContent = msg;
  ui.toast.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, 2200);
}

// =====================================================================
//  Input + camera
// =====================================================================
const keys = new Set();
// Orbit camera: yaw = free horizontal angle, pitch = elevation angle.
let yaw = Math.PI;
let pitch = 0.42;
const PITCH_MIN = -0.45;  // allows looking slightly upward (esp. in first-person)
const PITCH_MAX = 1.45;   // near top-down
let camDist = 9;          // adjustable with the mouse wheel
const CAM_MIN_DIST = 0;   // scroll all the way in for first-person
const CAM_MAX_DIST = 20;
const FP_DIST = 1.8;      // below this distance we snap into first-person
// Roblox-style control state
let started = false;     // game has begun (free cursor + WASD)
let dragging = false;    // holding right mouse to orbit the camera
let firstPerson = false; // fully zoomed in — mouse-look + center aim
let moving = false;
const velocity = new THREE.Vector3();
const desired = new THREE.Vector3();
let waddlePhase = 0;

// cursor aiming
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2(0, 0);
const lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
const _center = new THREE.Vector2(0, 0);
function aimRay() {
  // first-person & right-drag both aim straight down the center of the screen
  raycaster.setFromCamera(dragging || firstPerson ? _center : mouseNDC, camera);
  return raycaster.ray;
}
function moveReticle(px, py) {
  ui.crosshair.style.left = px + 'px';
  ui.crosshair.style.top = py + 'px';
}

// jump / vertical physics
let velY = 0;
let onGround = true;
const GRAVITY = 32;
const JUMP_SPEED = 11.5;
let stepTimer = 0;
let stepFlip = false;
let wasAir = false;

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function updateCamera() {
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // ---- first person: camera sits in the penguin's head ----
  firstPerson = camDist <= FP_DIST;
  player.group.visible = !firstPerson;
  if (firstPerson) {
    const head = player.group.position.clone().add(new THREE.Vector3(0, 1.85, 0));
    // look along the same direction the orbit camera would face
    const fwd = new THREE.Vector3(-Math.sin(yaw) * cp, -sp, -Math.cos(yaw) * cp);
    camera.position.lerp(head, 1 - Math.exp(-30 * lastDt));
    camera.lookAt(camera.position.clone().add(fwd));
    // crosshair stays locked to screen center
    ui.crosshair.style.left = '50%';
    ui.crosshair.style.top = '50%';
    return;
  }

  const target = player.group.position.clone().add(new THREE.Vector3(0, 1.6, 0));
  // spherical offset around the player (full 360° yaw, clamped pitch)
  const offset = new THREE.Vector3(
    Math.sin(yaw) * cp * camDist,
    sp * camDist,
    Math.cos(yaw) * cp * camDist
  );
  const desiredPos = target.clone().add(offset);
  // simple collision: pull the camera in if it would clip a building/landmark
  for (const s of solid) {
    if (Math.abs(desiredPos.x - s.x) < s.hx && Math.abs(desiredPos.z - s.z) < s.hz && desiredPos.y < 6) {
      desiredPos.copy(target).add(offset.multiplyScalar(0.55));
      break;
    }
  }
  // never let the camera dip below the snow
  desiredPos.y = Math.max(desiredPos.y, 0.9);
  camera.position.lerp(desiredPos, 1 - Math.exp(-18 * lastDt));
  camera.lookAt(target);
}
function collides(pos, ignoreBoundary = false) {
  // zombies ignore the outer wall so they can pour in from beyond the map edge
  if (!ignoreBoundary && Math.hypot(pos.x, pos.z) > 105) return true;
  for (const s of solid) {
    if (Math.abs(pos.x - s.x) < s.hx && Math.abs(pos.z - s.z) < s.hz) return true;
  }
  return false;
}
function currentZone() {
  let nearest = zones[0];
  let dist = Infinity;
  for (const z of zones) {
    const d = Math.hypot(player.group.position.x - z.x, player.group.position.z - z.z);
    if (d < dist) { nearest = z; dist = d; }
  }
  return dist < nearest.radius ? nearest.name : 'Frosty Trails';
}

// don't show the browser menu on right-click (we use it to orbit)
document.addEventListener('contextmenu', (e) => e.preventDefault());

// pointer lock is only used while right-dragging, to capture unlimited rotation
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== document.body) {
    dragging = false;
    // return the reticle to the cursor position
    moveReticle(lastMouse.x, lastMouse.y);
  }
});
document.addEventListener('mousemove', (e) => {
  const mouseLook = dragging || (firstPerson && document.pointerLockElement === document.body);
  if (mouseLook) {
    // right-drag (or first-person) moves the view directly
    yaw -= e.movementX * 0.0025;
    pitch = clamp(pitch + e.movementY * 0.0022, PITCH_MIN, PITCH_MAX);
  } else if (started) {
    // free cursor: track it for aiming and move the reticle to it
    lastMouse.x = e.clientX;
    lastMouse.y = e.clientY;
    mouseNDC.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouseNDC.y = -(e.clientY / window.innerHeight) * 2 + 1;
    moveReticle(e.clientX, e.clientY);
  }
});
document.addEventListener('wheel', (e) => {
  if (!started && !spectating) return;
  const wasFP = camDist <= FP_DIST;
  camDist = clamp(camDist + e.deltaY * 0.01, CAM_MIN_DIST, CAM_MAX_DIST);
  const nowFP = camDist <= FP_DIST;
  // while spectating we just zoom — no pointer lock / mouse-look needed
  if (spectating) return;
  // entering first-person: capture the mouse for Roblox-style look
  if (nowFP && !wasFP && !dragging && !document.pointerLockElement) {
    document.body.requestPointerLock();
  } else if (!nowFP && wasFP && !dragging && document.pointerLockElement) {
    // leaving first-person: release the mouse back to the free cursor
    document.exitPointerLock();
    moveReticle(lastMouse.x, lastMouse.y);
  }
}, { passive: true });
document.addEventListener('mousedown', (e) => {
  if (!started) return;
  sfx.resume();
  const onCanvas = e.target === renderer.domElement;
  if (e.button === 2 && onCanvas) {
    // right button: begin camera orbit (reticle snaps to center while looking)
    dragging = true;
    mouseNDC.set(0, 0);
    ui.crosshair.style.left = '50%';
    ui.crosshair.style.top = '50%';
    document.body.requestPointerLock();
  } else if (e.button === 0 && (onCanvas || dragging || firstPerson)) {
    // left button: shoot / throw toward the reticle (center in first-person)
    if (hasGun) fire();
    else throwSnowball();
  }
});
document.addEventListener('mouseup', (e) => {
  if (e.button === 2 && dragging) {
    dragging = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
});
document.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (!started) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyR' && hasGun) reloadGun();
  if (e.code === 'KeyE') buyPistol();
  if (e.code === 'KeyF') tryBuyUpgrade();
  if (e.code === 'KeyM') toast(sfx.toggle() ? '🔊 Sound on' : '🔇 Sound muted');
  const idx = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5'].indexOf(e.code);
  if (idx >= 0) doEmote(idx);
});
document.addEventListener('keyup', (e) => keys.delete(e.code));

const BAR_EMOTES = ['👋', '😄', '❤️', '🎉', '🎵'];
function doEmote(i) {
  showEmote(player.group, BAR_EMOTES[i], 3.0);
  localEmote = BAR_EMOTES[i];
  localEmoteSeq++;
  sfx.emote();
}

function move(dt) {
  if (!started) return;

  // ---- frozen in place (boss ice crater) — can still aim/shoot, but no moving ----
  if (frozenTimer > 0) {
    const mashing = keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD')
      || keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight');
    frozenTimer = Math.max(0, frozenTimer - dt * (mashing ? 2.4 : 1));
    velocity.set(0, 0, 0);
    moving = false;
    velY -= GRAVITY * dt;
    let fy = player.group.position.y + velY * dt;
    if (fy <= 0) { fy = 0; velY = 0; onGround = true; }
    player.group.position.y = fy;
    if (frozenTimer === 0) { playerIce.visible = false; frostOverlay.style.opacity = '0'; }
    return;
  }

  // ---- vertical physics (jump + gravity) ----
  if (keys.has('Space') && onGround) {
    velY = JUMP_SPEED;
    onGround = false;
    sfx.jump();
  }
  velY -= GRAVITY * dt;
  let ny = player.group.position.y + velY * dt;
  if (ny <= 0) {
    ny = 0;
    velY = 0;
    onGround = true;
  }
  player.group.position.y = ny;
  if (onGround && wasAir) sfx.land();
  wasAir = !onGround;

  // ---- horizontal movement (with air control) ----
  desired.set(0, 0, 0);
  if (keys.has('KeyW') || keys.has('ArrowUp')) desired.z -= 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) desired.z += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) desired.x -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) desired.x += 1;
  moving = desired.lengthSq() > 0;
  if (!moving) {
    velocity.multiplyScalar(Math.exp(-12 * dt));
  } else {
    desired.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const speed = sprint ? 9 : 5;
    velocity.lerp(desired.multiplyScalar(speed), 1 - Math.exp(-12 * dt));
    const targetYaw = Math.atan2(velocity.x, velocity.z);
    player.group.rotation.y = lerpAngle(player.group.rotation.y, targetYaw, 1 - Math.exp(-12 * dt));
  }
  // apply horizontal velocity every frame so momentum carries while airborne
  const tryX = player.group.position.clone(); tryX.x += velocity.x * dt;
  if (!collides(tryX)) player.group.position.x = tryX.x;
  const tryZ = player.group.position.clone(); tryZ.z += velocity.z * dt;
  if (!collides(tryZ)) player.group.position.z = tryZ.z;

  // footstep crunches in the snow
  const speedNow = Math.hypot(velocity.x, velocity.z);
  if (onGround && speedNow > 1.2) {
    stepTimer -= dt;
    if (stepTimer <= 0) {
      stepTimer = speedNow > 7 ? 0.26 : 0.36;
      sfx.step(stepFlip); stepFlip = !stepFlip;
    }
  } else {
    stepTimer = 0;
  }
}
function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  return a + d * t;
}

// animate a penguin's waddle/flap given speed factor [0..1]
function animatePenguin(pen, speed, t, phase) {
  const wobble = Math.sin(phase) * 0.12 * speed;
  pen.group.rotation.z = wobble;
  pen.parts.body.position.y = pen.baseBodyY + Math.abs(Math.sin(phase)) * 0.06 * speed + (speed < 0.05 ? Math.sin(t * 2) * 0.015 : 0);
  pen.parts.head.position.y = pen.baseHeadY + Math.sin(phase + 0.5) * 0.04 * speed;
  for (const f of pen.parts.flippers) {
    f.rotation.x = Math.sin(phase + (f.userData.side > 0 ? Math.PI : 0)) * 0.6 * speed - 0.1;
    f.rotation.z = f.userData.side * (0.15 + Math.sin(t * 3 + f.userData.side) * 0.08 * (1 - speed));
  }
  pen.parts.feet[0].position.z = 0.12 + Math.sin(phase) * 0.2 * speed;
  pen.parts.feet[1].position.z = 0.12 - Math.sin(phase) * 0.2 * speed;
}

// =====================================================================
//  Multiplayer — remote penguins
// ---------------------------------------------------------------------
//  Each client publishes its own penguin state every frame and renders
//  everyone else's. Players see each other waddle, look, emote and shoot.
//  (The zombie horde stays local to each client for now.)
// =====================================================================
const remotePlayers = new Map(); // id -> { pen, tag, gun, phase, lastFire, lastEmote, color, down }
let localFireSeq = 0;
let localEmoteSeq = 0;
let localEmote = null;

// ---- co-op down / spectate / respawn ----
let spectating = false;
let diedRound = 0;
let spectateId = null;   // which teammate we're currently watching
const spectateBanner = document.createElement('div');
spectateBanner.style.cssText =
  'position:fixed;top:0;left:0;right:0;z-index:19;display:none;flex-direction:column;align-items:center;' +
  'padding:18px;pointer-events:none;font-family:"Baloo 2",system-ui;color:#fff;text-shadow:0 2px 8px rgba(0,0,0,.7);' +
  'background:linear-gradient(180deg,rgba(60,0,0,.7),transparent)';
spectateBanner.innerHTML =
  '<div style="font:900 30px \'Baloo 2\',system-ui;color:#ff6b6b">💀 YOU\'RE DOWN</div>' +
  '<div id="spec-sub" style="font-size:16px;opacity:.92;margin-top:4px"></div>';
document.body.appendChild(spectateBanner);
const specSub = spectateBanner.querySelector('#spec-sub');

function anyTeammateAlive() {
  for (const [, r] of remotePlayers) if (!r.down) return true;
  return false;
}

function downPlayer() {
  if (spectating) return;
  spectating = true;
  diedRound = round;
  spectateId = null;
  started = false;
  player.group.visible = false;
  ui.crosshair.style.display = 'none';
  document.exitPointerLock?.();
  renderer.domElement.style.cursor = 'default';
  vignette.style.opacity = '0';
  damageFlash = 0;
  frozenTimer = 0; playerIce.visible = false; frostOverlay.style.opacity = '0';
  sfx.death();
  spectateBanner.style.display = 'flex';
}

function respawnPlayer() {
  spectating = false;
  spectateId = null;
  playerHP = PLAYER_MAX_HP;
  updatePlayerHP();
  updateCashHUD();
  damageFlash = 0;
  vignette.style.opacity = '0';
  frozenTimer = 0; playerIce.visible = false; frostOverlay.style.opacity = '0';
  let sx = 0, sz = 0, found = false;
  for (const [, r] of remotePlayers) {
    r.pen.group.visible = true;             // un-hide anyone we were POV-spectating
    r.tag.visible = true;
    if (!found && !r.down) { sx = r.pen.group.position.x; sz = r.pen.group.position.z + 3; found = true; }
  }
  player.group.position.set(sx, 0, sz);
  player.group.visible = true;
  started = true;
  spectateBanner.style.display = 'none';
  ui.crosshair.style.display = 'block';
  moveReticle(lastMouse.x, lastMouse.y);
  renderer.domElement.style.cursor = 'none';
  toast('🔁 Respawned — back in the fight!');
}

// Spectate a living teammate from their own viewpoint: we replicate their
// camera (look direction + position), keep our own zoom (scroll), and mirror
// their HP/cash to the HUD. Scroll all the way in for a true first-person view.
function updateSpectate() {
  if (!spectating) return;
  if (!anyTeammateAlive()) { spectating = false; spectateBanner.style.display = 'none'; endGame(); return; }
  if (round > diedRound) { respawnPlayer(); return; }

  // keep watching the same teammate until they go down or leave
  let rp = spectateId && remotePlayers.get(spectateId);
  if (!rp || rp.down) {
    rp = null;
    for (const [rid, r] of remotePlayers) if (!r.down) { rp = r; spectateId = rid; break; }
  }
  // make sure nobody is left hidden from a previous frame, except our POV target
  for (const [, r] of remotePlayers) if (r !== rp) { r.pen.group.visible = true; r.tag.visible = true; }
  if (!rp) return;

  specSub.textContent = `Spectating ${rp.name || 'a teammate'} • respawn at Round ${diedRound + 1} • scroll to zoom`;

  // mirror the teammate's HP + cash onto the HUD
  const f = clamp(rp.hp / PLAYER_MAX_HP, 0, 1);
  hpFill.style.width = (f * 100) + '%';
  hpFill.style.background = f > 0.5 ? '#46d65f' : f > 0.25 ? '#ffd23f' : '#ff3b3b';
  hpLabel.textContent = `${rp.name || 'Teammate'}: ${Math.ceil(rp.hp)} HP`;
  cashPill.innerHTML = `💵 <span>$${rp.cash || 0}</span>`;

  // replicate their camera. yaw/pitch come from them; distance is OUR zoom.
  const center = rp.pen.group.position;
  const ty = rp.camYaw || 0;
  const tpi = rp.camPitch || 0;
  const cp = Math.cos(tpi), sp = Math.sin(tpi);

  if (camDist <= FP_DIST) {
    // first-person at their head — hide their body + tag so we don't see inside
    rp.pen.group.visible = false;
    rp.tag.visible = false;
    const head = _specHead.set(center.x, center.y + 1.85, center.z);
    const fwd = _specFwd.set(-Math.sin(ty) * cp, -sp, -Math.cos(ty) * cp);
    camera.position.lerp(head, 1 - Math.exp(-30 * lastDt));
    camera.lookAt(camera.position.x + fwd.x, camera.position.y + fwd.y, camera.position.z + fwd.z);
  } else {
    rp.pen.group.visible = true;
    rp.tag.visible = true;
    const target = _specTarget.set(center.x, center.y + 1.6, center.z);
    const desired = _specPos.set(
      center.x + Math.sin(ty) * cp * camDist,
      center.y + 1.6 + sp * camDist,
      center.z + Math.cos(ty) * cp * camDist
    );
    desired.y = Math.max(desired.y, 0.9);
    camera.position.lerp(desired, 1 - Math.exp(-18 * lastDt));
    camera.lookAt(target);
  }
}
const _specPos = new THREE.Vector3();
const _specHead = new THREE.Vector3();
const _specFwd = new THREE.Vector3();
const _specTarget = new THREE.Vector3();

function ensureRemote(id, s) {
  let rp = remotePlayers.get(id);
  if (rp) {
    if (s.color !== rp.color) recolorRemote(rp, s.color);
    return rp;
  }
  const color = s.color ?? 0x2f7fe0;
  const pen = makePenguin({ color });
  pen.group.position.set(s.x ?? 0, s.y ?? 0, s.z ?? 0);
  world.add(pen.group);

  const tag = makeNameTag(s.name || 'Penguin', color);
  world.add(tag);

  const gun = makePistol(0.85);
  gun.position.set(0.55, 1.25, 0.5);
  gun.visible = false;
  pen.group.add(gun);

  rp = { pen, tag, gun, phase: 0, lastFire: s.fireSeq || 0, lastEmote: s.emoteSeq || 0, color, name: s.name, down: false };
  remotePlayers.set(id, rp);
  return rp;
}

function recolorRemote(rp, hex) {
  const skin = darken(hex, 0.85);
  rp.pen.parts.body.material.color.set(hex);
  rp.pen.parts.head.material.color.set(skin);
  for (const f of rp.pen.parts.flippers) f.children[0].material.color.set(hex);
  rp.color = hex;
}

function removeRemote(id) {
  const rp = remotePlayers.get(id);
  if (!rp) return;
  world.remove(rp.pen.group);
  world.remove(rp.tag);
  remotePlayers.delete(id);
}

function remoteFire(rp) {
  const muzzle = new THREE.Vector3();
  rp.gun.getWorldPosition(muzzle);
  const ry = rp.pen.group.rotation.y;
  const p = rp.lookPitch || 0;
  const cp = Math.cos(p);
  const dir = new THREE.Vector3(Math.sin(ry) * cp, -Math.sin(p), Math.cos(ry) * cp);
  const end = muzzle.clone().add(dir.multiplyScalar(70));
  spawnTracer(muzzle, end);
}

function pushLocalState() {
  if (!mpActive()) return;
  // In first person the body isn't turned by movement, so face where we LOOK.
  // Camera forward is (-sin yaw, -cos yaw); the penguin's beak is +Z, so the
  // body yaw that matches the look direction is atan2(-sin yaw, -cos yaw).
  const lookYaw = Math.atan2(-Math.sin(yaw), -Math.cos(yaw));
  setLocalState({
    x: player.group.position.x,
    y: player.group.position.y,
    z: player.group.position.z,
    ry: firstPerson ? lookYaw : player.group.rotation.y,
    // raw camera state so spectators can replicate exactly what we see
    cy: yaw,
    cpitch: pitch,
    cd: camDist,
    fp: firstPerson,
    color: playerColor,
    name: playerName,
    mv: moving,
    hasGun,
    down: spectating,
    hp: Math.ceil(playerHP),
    cash,
    fireSeq: localFireSeq,
    emoteSeq: localEmoteSeq,
    emote: localEmote,
  });
}

function updateRemotePlayers(dt, t) {
  if (!mpActive()) return;
  const seen = new Set();
  eachRemote((id, s) => {
    seen.add(id);
    const rp = ensureRemote(id, s);
    rp.name = s.name || rp.name;
    rp.down = !!s.down;
    rp.camYaw = s.cy ?? rp.camYaw ?? 0;
    rp.camPitch = s.cpitch ?? 0;
    rp.fp = !!s.fp;
    rp.hp = s.hp ?? rp.hp ?? 0;
    rp.cash = s.cash ?? rp.cash ?? 0;
    const g = rp.pen.group;
    const k = 1 - Math.exp(-12 * dt);
    g.position.x += ((s.x ?? g.position.x) - g.position.x) * k;
    g.position.y += ((s.y ?? g.position.y) - g.position.y) * k;
    g.position.z += ((s.z ?? g.position.z) - g.position.z) * k;
    g.rotation.y = lerpAngle(g.rotation.y, s.ry ?? g.rotation.y, k);

    rp.phase += dt * (s.mv && !rp.down ? 10 : 0);
    animatePenguin(rp.pen, s.mv && !rp.down ? 1 : 0, t, rp.phase);
    // downed teammates lie on their side; otherwise lean to match their look
    if (rp.down) {
      g.rotation.z = lerpAngle(g.rotation.z, Math.PI / 2, k);
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, 0, k);
    } else {
      rp.lookPitch = rp.fp ? rp.camPitch : 0;
      const lean = clamp(rp.lookPitch, -0.9, 0.9) * 0.6;
      g.rotation.x = THREE.MathUtils.lerp(g.rotation.x, lean, k);
    }

    rp.tag.position.set(g.position.x, g.position.y + 3.0, g.position.z);
    rp.gun.visible = !!s.hasGun && !rp.down;

    if (s.fireSeq && s.fireSeq !== rp.lastFire) {
      rp.lastFire = s.fireSeq;
      remoteFire(rp);
    }
    if (s.emoteSeq && s.emoteSeq !== rp.lastEmote) {
      rp.lastEmote = s.emoteSeq;
      showEmote(g, s.emote || '👋', 3.0);
    }
  });
  // drop anyone we no longer hear from (covers reloads / missed onQuit)
  for (const id of remotePlayers.keys()) {
    if (!seen.has(id)) removeRemote(id);
  }
  if (ui.online) ui.online.textContent = NPC_COUNT + mpPlayerCount();
  updateMpStatus();
}

// =====================================================================
//  Multiplayer — host-authoritative horde sync
// ---------------------------------------------------------------------
//  HOST runs the full simulation (spawns, AI, rounds, bosses, pickups)
//  and broadcasts a snapshot of the world each frame. CLIENTS render that
//  snapshot as "ghost" entities, report their hits/pickups to the host,
//  and apply damage to themselves locally.
// =====================================================================
const TYPE_LIST = ['shambler', 'runner', 'brute', 'bomber', 'spitter', 'boss', 'peaceful'];
const TYPE_IDX = Object.fromEntries(TYPE_LIST.map((t, i) => [t, i]));
const CONTACT_DMG = { shambler: 7, runner: 5, brute: 14, spitter: 6, boss: 22, bomber: 0, peaceful: 0 };

function netRole() {
  if (!mpActive()) return 'solo';
  return mpIsHost() ? 'host' : 'client';
}

function npcByNet(nid) {
  for (const n of npcs) if (n.netId === nid) return n;
  return null;
}

// nearest *living* player position (local + remotes) — host AI retargets every
// frame, so zombies always chase whoever is currently closest (skipping downed).
const _np = new THREE.Vector3();
function nearestPlayerPos(x, z) {
  let bx = player.group.position.x, bz = player.group.position.z, bd = Infinity;
  let found = false;
  if (!spectating) { bd = (bx - x) ** 2 + (bz - z) ** 2; found = true; }
  if (mpActive()) {
    eachRemote((id, s) => {
      if (s.x == null || s.down) return;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; bx = s.x; bz = s.z; found = true; }
    });
  }
  if (!found) { bx = player.group.position.x; bz = player.group.position.z; }
  _np.set(bx, 0, bz);
  return _np;
}

// ---------- HOST: serialize + broadcast the world ----------
let bannerSeq = 0;
let bannerText = '';
const killFeed = [];
let killSeq = 0;
const chatFeed = [];        // zombie taunts → mirrored to every client
let chatSeq = 0;
let bcastAcc = 0;

// show a zombie taunt locally and (on the host) queue it for every client
function broadcastChat(group, text, headY, nid) {
  showChat(group, text, headY);
  if (netRole() === 'host') {
    chatFeed.push({ seq: ++chatSeq, nid, txt: text, hy: Math.round(headY * 100) / 100 });
    if (chatFeed.length > 10) chatFeed.shift();
  }
}

function hostBroadcast() {
  const arr = [];
  for (const n of npcs) {
    arr.push([
      n.netId,
      Math.round(n.group.position.x * 100) / 100,
      Math.round(n.group.position.z * 100) / 100,
      Math.round(n.group.rotation.y * 100) / 100,
      TYPE_IDX[n.isZombie ? n.type : 'peaceful'] ?? 0,
      Math.max(0, Math.ceil(n.hp)),
      n.maxHp,
      Math.round(n.scale * 100) / 100,
      (n.dead ? 1 : 0) | (n.moving ? 2 : 0) | (n.isZombie ? 4 : 0),
      n.color,
    ]);
  }
  setGlobal('z', arr);
  setGlobal('rs', {
    round, intermission: Math.round(intermission * 10) / 10,
    zTarget, zKilled, zSpawned, hordeMode, bSeq: bannerSeq, bTxt: bannerText,
  });
  setGlobal('boss', bossRef && !bossRef.dead ? { hp: Math.max(0, Math.ceil(bossRef.hp)), max: bossRef.maxHp } : null);
  setGlobal('meds', medpacks.map((m) => [m.id, Math.round(m.x * 10) / 10, Math.round(m.z * 10) / 10]));
  setGlobal('ammos', ammoDrops.map((a) => [a.id, Math.round(a.x * 10) / 10, Math.round(a.z * 10) / 10, a.amount]));
  setGlobal('kf', killFeed);
  setGlobal('cf', chatFeed);
  setGlobal('craters', iceCraters.map((c) => [c.id, Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10, craterArmed(c.life) ? 1 : 0]));
  setGlobal('env', { tod: Math.round(dayTime * 1000) / 1000, wx: Math.round(weatherCur * 100) / 100 });
}

// ---------- HOST: process incoming client inputs ----------
const clientHitSeq = new Map();
const clientPickSeq = new Map();
function hostReadInputs() {
  eachRemoteState('hx', (pid, data) => {
    const last = clientHitSeq.get(pid) || 0;
    if (!data || data.seq <= last) return;
    clientHitSeq.set(pid, data.seq);
    for (const h of data.hits) {
      const n = npcByNet(h.nid);
      if (n && !n.dead) {
        const pt = new THREE.Vector3(n.group.position.x, n.group.position.y + 1.2, n.group.position.z);
        damageNPC(n, h.dmg, pt, h.hs, pid);
      }
    }
  });
  eachRemoteState('pkq', (pid, data) => {
    const last = clientPickSeq.get(pid) || 0;
    if (!data || data.seq <= last) return;
    clientPickSeq.set(pid, data.seq);
    for (const req of data.reqs) {
      if (req.kind === 'med') removeMedById(req.id);
      else removeAmmoById(req.id);
    }
  });
}

function removeMedById(id) {
  for (let i = medpacks.length - 1; i >= 0; i--) {
    if (medpacks[i].id === id) { world.remove(medpacks[i].group); medpacks.splice(i, 1); return; }
  }
}
function removeAmmoById(id) {
  for (let i = ammoDrops.length - 1; i >= 0; i--) {
    if (ammoDrops[i].id === id) { world.remove(ammoDrops[i].group); ammoDrops.splice(i, 1); return; }
  }
}

// kill feed entry, awarded to a *client* attacker (host rewards itself directly)
function pushKill(killerId, base, hs, point) {
  const e = { seq: ++killSeq, killer: killerId, base, hs };
  if (point) { e.x = Math.round(point.x * 100) / 100; e.y = Math.round(point.y * 100) / 100; e.z = Math.round(point.z * 100) / 100; }
  killFeed.push(e);
  if (killFeed.length > 12) killFeed.shift();
}

// ---------- CLIENT: ghost entities driven by the host snapshot ----------
const ghosts = new Map(); // netId -> { pen, hb, type, scale, dead, deathT, phase, atkCD, contactDmg }
function createGhost(nid, type, scale, color, zombie) {
  const pen = makePenguin({ color, scale });
  world.add(pen.group);
  addTypeMarkers(pen.group, type);
  const hb = makeHealthBar();
  hb.sprite.visible = false;
  world.add(hb.sprite);
  const g = { pen, hb, type, scale, color, dead: false, deathT: 0, phase: Math.random() * 6, atkCD: 0, contactDmg: CONTACT_DMG[type] ?? 7, zombie };
  ghosts.set(nid, g);
  return g;
}
function clientReconcile(dt, t) {
  const arr = getGlobal('z') || [];
  const seen = new Set();
  for (const e of arr) {
    const [nid, x, z, ry, ti, hp, maxHp, scale, flags, color] = e;
    seen.add(nid);
    const dead = !!(flags & 1), mv = !!(flags & 2), zombie = !!(flags & 4);
    const type = TYPE_LIST[ti] || 'shambler';
    let g = ghosts.get(nid);
    const justCreated = !g;
    if (!g) g = createGhost(nid, type, scale, color, zombie);
    // keep live attributes in sync — peaceful townsfolk become zombies mid-game
    g.zombie = zombie;
    g.type = type;
    g.contactDmg = CONTACT_DMG[type] ?? 7;
    const grp = g.pen.group;
    const k = justCreated ? 1 : 1 - Math.exp(-14 * dt);
    grp.position.x += (x - grp.position.x) * k;
    grp.position.z += (z - grp.position.z) * k;
    grp.rotation.y = lerpAngle(grp.rotation.y, ry, k);

    if (dead && justCreated) { g.dead = true; g.deathT = 1; }  // arrived already dead — no FX
    else if (dead && !g.dead) {
      g.dead = true; g.deathT = 0;
      g.hb.sprite.visible = false;
      const pt = new THREE.Vector3(grp.position.x, grp.position.y + 1.0, grp.position.z);
      spawnBloodBurst(pt);
      spawnBloodPool(grp.position.x, grp.position.z);
      if (type === 'bomber') explodeAt(grp.position);
    }
    if (g.dead) {
      g.deathT += dt;
      grp.rotation.z = lerpAngle(grp.rotation.z, Math.PI / 2, 1 - Math.exp(-9 * dt));
      grp.position.y = Math.max(0, grp.position.y - dt * 0.6);
    } else {
      g.phase += dt * (mv ? 11 : 1.5);
      animatePenguin(g.pen, mv ? 1 : 0.2, t, g.phase);
      grp.position.y = 0;
      if (zombie && type !== 'boss') {
        g.hb.sprite.visible = true;
        g.hb.set(hp / Math.max(1, maxHp));
        g.hb.sprite.position.set(grp.position.x, 3.0 + scale * 1.0, grp.position.z);
      }
    }
  }
  for (const [nid, g] of ghosts) {
    if (!seen.has(nid)) { world.remove(g.pen.group); world.remove(g.hb.sprite); ghosts.delete(nid); }
  }
  if (ui.online) ui.online.textContent = ghosts.size + mpPlayerCount();
}

// client takes melee damage from ghost zombies near it (bombers handled on death)
function clientGhostDanger(dt) {
  if (gameOver || !started) return;
  for (const [, g] of ghosts) {
    if (g.dead || !g.zombie || g.type === 'spitter' || g.type === 'bomber') continue;
    const p = g.pen.group.position;
    const reach = 1.2 + g.scale * 0.9;
    if (Math.hypot(player.group.position.x - p.x, player.group.position.z - p.z) < reach) {
      g.atkCD -= dt;
      if (g.atkCD <= 0) { damagePlayer(g.contactDmg); g.atkCD = 1.0; }
    }
  }
}

// client mirrors round HUD / banners from the host
let lastBannerSeq = 0;
function clientReadRounds() {
  const rs = getGlobal('rs');
  if (!rs) return;
  if (rs.hordeMode && !hordeMode) {
    hordeMode = true;
    hpBar.style.display = 'block';
    roundPill.style.display = '';
    cashPill.style.display = '';
    updateCashHUD();
    updatePlayerHP();
    sfx.combatMusic();
  }
  round = rs.round;
  zTarget = rs.zTarget; zKilled = rs.zKilled;
  if (hordeMode) updateRoundHUD();
  if (rs.bSeq && rs.bSeq !== lastBannerSeq) {
    lastBannerSeq = rs.bSeq;
    roundBanner.textContent = rs.bTxt || ('ROUND ' + rs.round);
    roundBanner.style.opacity = '1';
    sfx.round();
    setTimeout(() => { roundBanner.style.opacity = '0'; }, 1800);
  }
}

// client awards itself cash/elims for kills the host attributed to it
let lastFeedSeq = 0;
function clientReadFeed() {
  const kf = getGlobal('kf');
  if (!kf || !kf.length) return;
  let maxSeq = lastFeedSeq;
  const fresh = [];
  for (const e of kf) {
    if (e.seq > lastFeedSeq) { fresh.push(e); if (e.seq > maxSeq) maxSeq = e.seq; }
  }
  fresh.sort((a, b) => a.seq - b.seq);
  for (const e of fresh) {
    if (e.killer !== mpMyId()) continue;
    dismissMpStatus();
    eliminations++;
    const mult = registerKillCombo();
    const pt = (e.x !== undefined) ? new THREE.Vector3(e.x, e.y, e.z) : null;
    earnCash(Math.round(e.base * mult), pt);   // pt → floating "+$" popup
    if (e.hs && pt) floatText('HEADSHOT KILL!', pt, '#ffd23f', 22);
    showHitMarker(true);
    if (e.hs) sfx.headshotKill(); else sfx.kill();
    updateWeaponHUD();
  }
  lastFeedSeq = maxSeq;
}

// client mirrors zombie taunt bubbles, anchored to the matching ghost
let lastChatSeq = 0;
let chatSynced = false;
function clientReadChats() {
  const cf = getGlobal('cf');
  if (!cf || !cf.length) return;
  let maxSeq = lastChatSeq;
  for (const e of cf) if (e.seq > maxSeq) maxSeq = e.seq;
  // on first sync just catch up — don't replay a backlog of old taunts at once
  if (!chatSynced) { chatSynced = true; lastChatSeq = maxSeq; return; }
  for (const e of cf) {
    if (e.seq <= lastChatSeq) continue;
    const g = ghosts.get(e.nid);
    if (g && !g.dead) showChat(g.pen.group, e.txt, e.hy ?? 3.4);
  }
  lastChatSeq = maxSeq;
}

function updateBossBarFromNet() {
  const b = getGlobal('boss');
  if (b) { bossBar.style.display = 'block'; bossFill.style.width = (b.hp / Math.max(1, b.max) * 100) + '%'; }
  else bossBar.style.display = 'none';
}

// ---------- CLIENT: pickups (request removal from host, apply locally) ----------
const ghostMeds = new Map();
const ghostAmmo = new Map();
let pickSeq = 0;
const pickOut = [];
function flushPick() { setMyState('pkq', { seq: ++pickSeq, reqs: pickOut.slice(-20) }, true); }
function clientPickups(dt, t) {
  const meds = getGlobal('meds') || [];
  const mseen = new Set();
  for (const [id, x, z] of meds) {
    mseen.add(id);
    let grp = ghostMeds.get(id);
    if (!grp) { grp = makeMedpack(); grp.position.set(x, 0, z); grp.userData = { x, z }; world.add(grp); ghostMeds.set(id, grp); }
    grp.rotation.y += dt * 1.5;
    grp.position.y = Math.sin(t * 2 + id) * 0.18 + 0.1;
    if (started && !gameOver && !grp.userData.claimed && playerHP < PLAYER_MAX_HP &&
        Math.hypot(player.group.position.x - grp.userData.x, player.group.position.z - grp.userData.z) < 1.9) {
      grp.userData.claimed = true;
      playerHP = Math.min(PLAYER_MAX_HP, playerHP + MED_HEAL);
      updatePlayerHP();
      damageFlash = 0; vignette.style.opacity = '0';
      sfx.med();
      toast(`➕ Med pack — +${MED_HEAL} HP`);
      pickOut.push({ kind: 'med', id }); flushPick();
    }
  }
  for (const [id, grp] of ghostMeds) if (!mseen.has(id)) { world.remove(grp); ghostMeds.delete(id); }

  const ammos = getGlobal('ammos') || [];
  const aseen = new Set();
  for (const [id, x, z, amount] of ammos) {
    aseen.add(id);
    let grp = ghostAmmo.get(id);
    if (!grp) { grp = makeAmmoBox(); grp.position.set(x, 0, z); grp.userData = { x, z, amount }; world.add(grp); ghostAmmo.set(id, grp); }
    grp.rotation.y += dt * 1.8;
    grp.position.y = Math.sin(t * 2.4 + id) * 0.14 + 0.06;
    if (started && !gameOver && hasGun && !grp.userData.claimed && ammoReserve < RESERVE_MAX &&
        Math.hypot(player.group.position.x - grp.userData.x, player.group.position.z - grp.userData.z) < 1.9) {
      grp.userData.claimed = true;
      ammoReserve = Math.min(RESERVE_MAX, ammoReserve + grp.userData.amount);
      updateWeaponHUD();
      sfx.pickup();
      floatText(`+${grp.userData.amount} AMMO`, new THREE.Vector3(grp.userData.x, 1.2, grp.userData.z), '#ffd23f', 18);
      pickOut.push({ kind: 'ammo', id }); flushPick();
    }
  }
  for (const [id, grp] of ghostAmmo) if (!aseen.has(id)) { world.remove(grp); ghostAmmo.delete(id); }
}

// ---------- CLIENT: outgoing hits ----------
let hitSeq = 0;
const hitOut = [];
function flushHits() {
  if (!hitOut.length) return;
  setMyState('hx', { seq: ++hitSeq, hits: hitOut.slice() }, true);
  hitOut.length = 0;
}

// when becoming a client, the host owns the world — drop our local entities
function enterClientMode() {
  for (const n of npcs) { world.remove(n.group); world.remove(n.tag); world.remove(n.hb.sprite); }
  npcs.length = 0;
  for (const m of medpacks) world.remove(m.group); medpacks.length = 0;
  for (const a of ammoDrops) world.remove(a.group); ammoDrops.length = 0;
  for (const s of spits) world.remove(s.m); spits.length = 0;
  for (const b of iceBalls) world.remove(b.m); iceBalls.length = 0;
  for (const c of iceCraters) world.remove(c.group); iceCraters.length = 0;
}

// =====================================================================
//  NPC behavior
// =====================================================================
const _toP = new THREE.Vector3();
const _perp = new THREE.Vector3();
function updateNPCs(dt, t) {
  for (let i = npcs.length - 1; i >= 0; i--) {
    const npc = npcs[i];
    const pos = npc.group.position;

    // --- eliminated: collapse, then despawn (a fresh one spawns elsewhere) ---
    if (npc.dead) {
      npc.deathT += dt;
      npc.group.rotation.z = lerpAngle(npc.group.rotation.z, Math.PI / 2, 1 - Math.exp(-9 * dt));
      npc.group.position.y = Math.max(0, npc.group.position.y - dt * 0.6);
      if (npc.deathT > 3) {
        world.remove(npc.group);
        world.remove(npc.tag);
        world.remove(npc.hb.sprite);
        npcs.splice(i, 1);
      }
      continue;
    }

    if (npc.hitFlash) npc.hitFlash = Math.max(0, npc.hitFlash - dt);

    // a penguin tossed by the boss: ballistic arc, then resume the chase sprinting
    if (npc.flying) {
      npc.fvy -= ICE_GRAV * dt;
      pos.x += npc.fvx * dt; pos.z += npc.fvz * dt; pos.y += npc.fvy * dt;
      npc.group.rotation.x += dt * 7;
      if (pos.y <= 0) {
        pos.y = 0; npc.flying = false; npc.group.rotation.x = 0;
        npc.lunge = 0.9; npc.lungeTimer = 1.4; npc.moving = true;
        sfx.land();
      }
      continue;
    }

    if (npc.state === 'chase') {
      // ---------- ZOMBIE: shamble toward the NEAREST player with variation ----------
      const tgt = nearestPlayerPos(pos.x, pos.z);
      _toP.set(tgt.x - pos.x, 0, tgt.z - pos.z);
      const distP = _toP.length();
      // distance to *this* machine's player — melee only ever hurts the local one
      const distLocal = Math.hypot(player.group.position.x - pos.x, player.group.position.z - pos.z);
      const reach = 1.2 + npc.scale * 0.9;

      // random trash-talk in a chat bubble (only some penguins, staggered)
      npc.chatTimer -= dt;
      if (npc.chatTimer <= 0) {
        npc.chatTimer = 5 + Math.random() * 9;
        if (distP < 42 && Math.random() < 0.5) {
          const txt = ZOMBIE_TAUNTS[Math.floor(Math.random() * ZOMBIE_TAUNTS.length)];
          broadcastChat(npc.group, txt, 3.0 + npc.scale * 1.15, npc.netId);
        }
      }

      // bombers detonate the instant they reach you
      if (npc.type === 'bomber' && distP < reach + 0.5) {
        killNPC(npc, new THREE.Vector3(pos.x, pos.y + 1.0, pos.z));
        continue;
      }
      // spitters lob acid from range (at the nearest player)
      if (npc.type === 'spitter') {
        npc.attackCD -= dt;
        if (npc.attackCD <= 0 && distP < 24 && distP > 3.5) {
          npc.attackCD = 2.0 + Math.random() * 1.6;
          spawnSpit(new THREE.Vector3(pos.x, pos.y + 1.7, pos.z), tgt);
        }
      }

      // BOSS: rains freezing ice + hurls fast penguins at the player
      if (npc.type === 'boss') {
        npc.iceTimer = (npc.iceTimer ?? 3.5) - dt;
        if (npc.iceTimer <= 0 && distP < 64) {
          npc.iceTimer = 4.5 + Math.random() * 2;
          const volley = 3 + Math.floor(round / 5);
          for (let q = 0; q < volley; q++) {
            const ox = (Math.random() - 0.5) * 9, oz = (Math.random() - 0.5) * 9;
            spawnIceBall(new THREE.Vector3(pos.x, pos.y + 3.6, pos.z), tgt.x + ox, tgt.z + oz);
          }
          sfx.groan();
        }
        npc.throwTimer = (npc.throwTimer ?? 6) - dt;
        if (npc.throwTimer <= 0 && distP < 58 && aliveZombies() < HORDE_CAP) {
          npc.throwTimer = 6.5 + Math.random() * 3;
          throwPenguin(pos, tgt);
        }
      }

      // approach (1), hold (0) or back away (-1)
      let approach = 1;
      if (npc.type === 'spitter') approach = distP > 13 ? 1 : distP < 8 ? -1 : 0;
      else if (distP < reach) approach = 0;

      if (approach === 0) {
        npc.moving = false;
        if (npc.type !== 'spitter' && distLocal < reach) {
          // melee swipe — only hits the player simulating this machine
          npc.attackCD -= dt;
          if (npc.attackCD <= 0) { damagePlayer(npc.contactDmg); npc.attackCD = 1.0; npc.lunge = 0.35; }
        } else {
          npc.heading = Math.atan2(_toP.x, _toP.z);
          npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-9 * dt));
        }
      } else {
        npc.moving = true;
        _toP.normalize();
        // desired heading toward the player (or away), plus a weaving sway offset
        npc.swayPhase += dt * npc.swayFreq;
        let baseAng = Math.atan2(_toP.x, _toP.z);
        if (approach < 0) baseAng += Math.PI; // retreat
        const swayOff = Math.sin(npc.swayPhase) * npc.sway * 0.18;
        // occasional lunges (bursts of speed)
        npc.lungeTimer -= dt;
        if (npc.lungeTimer <= 0) { npc.lunge = 0.5; npc.lungeTimer = 3 + Math.random() * 5; }
        let sp = npc.speed;
        if (npc.lunge > 0) { npc.lunge -= dt; sp *= 1.9; }
        // probe several candidate headings and take the first clear one so they
        // steer AROUND buildings instead of grinding into corners
        const cands = npc.stuck > 0.6
          ? [1.6, -1.6, 2.4, -2.4, 0.8, -0.8, Math.PI]
          : [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6];
        let movedAny = false;
        for (const off of cands) {
          const ang = baseAng + swayOff + off;
          const step = { x: Math.sin(ang) * sp * dt, z: Math.cos(ang) * sp * dt };
          const np = pos.clone(); np.x += step.x; np.z += step.z;
          if (!collides(np, true)) { pos.copy(np); npc.heading = ang; movedAny = true; break; }
        }
        if (movedAny) npc.stuck = Math.max(0, npc.stuck - dt * 2);
        else npc.stuck += dt;
        npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-9 * dt));
      }
      // forward lurch + faster, jerky waddle
      npc.group.rotation.x = THREE.MathUtils.lerp(npc.group.rotation.x, npc.moving ? 0.2 : 0, 1 - Math.exp(-8 * dt));
      npc.phase += dt * (9 + npc.speed * 1.5);
      animatePenguin(npc, npc.moving ? 1 : 0.2, t, npc.phase);
      npc.hb.sprite.position.set(pos.x, 3.0 + npc.scale * 1.0, pos.z);
      continue;
    }

    // ---------- peaceful wander (pre-horde) ----------
    npc.emoteTimer -= dt;
    if (npc.emoteTimer <= 0) {
      npc.emoteTimer = 6 + Math.random() * 10;
      if (Math.random() < 0.7) showEmote(npc.group, EMOTES[Math.floor(Math.random() * EMOTES.length)]);
    }
    const toTarget = npc.target.clone().sub(pos);
    const dist = toTarget.length();
    if (dist < 1.2) {
      npc.moving = false;
      npc.waitTimer -= dt;
      if (npc.waitTimer <= 0) {
        npc.target = pickWanderTarget();
        npc.waitTimer = 1 + Math.random() * 3;
      }
    } else {
      npc.moving = true;
      toTarget.normalize();
      const step = toTarget.multiplyScalar(npc.speed * dt);
      const np = pos.clone().add(step);
      if (!collides(np)) pos.copy(np);
      else npc.target = pickWanderTarget();
      npc.heading = Math.atan2(step.x, step.z);
      npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-8 * dt));
    }
    npc.phase = npc.phase + dt * 8 * (npc.moving ? 1 : 0);
    animatePenguin(npc, npc.moving ? 1 : 0, t, npc.phase);
    npc.tag.position.set(pos.x, 3.0, pos.z);
  }
}

// =====================================================================
//  Greeting proximity (subtle social touch)
// =====================================================================
let greetCooldown = 0;
function checkGreetings(dt) {
  greetCooldown -= dt;
  if (greetCooldown > 0 || !started || hordeMode) return;
  for (const npc of npcs) {
    if (npc.dead) continue;
    if (player.group.position.distanceTo(npc.group.position) < 3.2) {
      showEmote(npc.group, '👋');
      greetCooldown = 6;
      break;
    }
  }
}

// =====================================================================
//  Emote update
// =====================================================================
function updateEmotes(dt) {
  for (let i = activeEmotes.length - 1; i >= 0; i--) {
    const e = activeEmotes[i];
    e.life += dt;
    const pos = e.target.position;
    const pop = Math.min(1, e.life / 0.18);
    const rise = Math.min(1, e.life / e.ttl);
    e.sprite.position.set(pos.x, pos.y + e.headY + rise * 0.7, pos.z);
    const s = (0.4 + pop * 0.6) * 2.2;
    e.sprite.scale.set(s, s, 1);
    e.sprite.material.opacity = e.life > e.ttl - 0.4 ? Math.max(0, (e.ttl - e.life) / 0.4) : 1;
    if (e.life >= e.ttl) {
      world.remove(e.sprite);
      activeEmotes.splice(i, 1);
    }
  }
}

// =====================================================================
//  Start / customization wiring
// =====================================================================
PENGUIN_COLORS.forEach((c, i) => {
  const sw = document.createElement('div');
  sw.className = 'swatch' + (i === 0 ? ' selected' : '');
  sw.style.background = '#' + new THREE.Color(c.hex).getHexString();
  sw.title = c.name;
  sw.addEventListener('click', () => {
    sfx.uiClick();
    document.querySelectorAll('.swatch').forEach((s) => s.classList.remove('selected'));
    sw.classList.add('selected');
    playerColor = c.hex;
    recolorPlayer(c.hex);
  });
  ui.swatches.appendChild(sw);
});

BAR_EMOTES.forEach((emoji, i) => {
  const btn = document.createElement('button');
  btn.className = 'emote-btn';
  btn.innerHTML = `${emoji}<span class="key">${i + 1}</span>`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (started) doEmote(i);
  });
  ui.actionBar.appendChild(btn);
});

function recolorPlayer(hex) {
  const skin = darken(hex, 0.85);
  player.parts.body.material.color.set(hex);
  player.parts.head.material.color.set(skin);
  for (const f of player.parts.flippers) f.children[0].material.color.set(hex);
  fpArmMat.color.set(hex);
}

function beginGame() {
  playerName = (ui.nameInput.value || '').trim() || 'Waddles';
  recolorPlayer(playerColor);
  sfx.startWorld();
  sfx.uiClick();
  started = true;
  ui.overlay.style.display = 'none';
  ui.actionBar.classList.add('show');
  // custom reticle follows the mouse; hide the OS cursor over the 3D view
  ui.crosshair.style.display = 'block';
  moveReticle(lastMouse.x, lastMouse.y);
  renderer.domElement.style.cursor = 'none';
  ui.online.textContent = NPC_COUNT + 1;
  setTimeout(() => toast(`Welcome to Penguin Town, ${playerName}! 🐧`), 400);
  setTimeout(() => toast('WASD to move • hold right-click + drag to look around'), 2600);
  setTimeout(() => toast('Left-click to throw snowballs • 1–5 to emote'), 5000);
  setTimeout(() => toast('Visit Gunther\'s 🔫 Weapon Shop to grab a pistol & buy upgrades'), 7400);
}

ui.startButton.addEventListener('click', () => beginGame());

// ---------- "Play with friends" button (lazy multiplayer) ----------
const mpButton = document.createElement('button');
mpButton.id = 'mp-button';
mpButton.textContent = '👥 Play with Friends';
mpButton.style.cssText =
  'margin-top:10px;width:100%;padding:12px 18px;border:0;border-radius:14px;cursor:pointer;' +
  'font:700 16px "Baloo 2",system-ui,sans-serif;color:#0f344f;' +
  'background:linear-gradient(180deg,#bfe9ff,#7fc7f5);box-shadow:0 6px 18px rgba(46,121,184,.35);';
ui.startButton.insertAdjacentElement('afterend', mpButton);

// If we arrived via an invite link (?r=CODE), this player is joining a
// friend's room — make that the obvious primary action so it's not confusing.
const isJoining = new URLSearchParams(window.location.search).has('r');
if (isJoining) {
  const card = ui.startButton.closest('#start-card');
  const heading = card?.querySelector('h1');
  const subtext = card?.querySelector('p');
  if (heading) heading.innerHTML = "Join your friend's game";
  if (subtext) subtext.textContent = 'You were invited to a room. Pick a name & color, then jump in!';
  // promote the multiplayer button to the top, styled as the main CTA
  mpButton.textContent = "🎮 Join Friend's Game";
  mpButton.style.marginTop = '0';
  ui.startButton.insertAdjacentElement('beforebegin', mpButton);
  // demote the solo button to a secondary option
  ui.startButton.textContent = 'Play solo instead';
  ui.startButton.style.cssText +=
    ';margin-top:10px;background:transparent;color:rgba(15,52,79,.7);' +
    'box-shadow:none;border:2px solid rgba(127,199,245,.5);';
}

// persistent multiplayer status badge (click to copy the invite link)
const mpStatus = document.createElement('div');
mpStatus.id = 'mp-status';
mpStatus.style.cssText =
  'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:50;display:none;' +
  'padding:8px 16px;border-radius:999px;cursor:pointer;user-select:none;' +
  'font:600 14px "Baloo 2",system-ui,sans-serif;color:#0f344f;' +
  'background:rgba(255,255,255,.92);box-shadow:0 4px 14px rgba(46,121,184,.35);' +
  'border:2px solid rgba(127,199,245,.8);backdrop-filter:blur(4px);';
document.body.appendChild(mpStatus);
mpStatus.addEventListener('click', () => {
  const link = mpInviteUrl();
  navigator.clipboard?.writeText(link).then(
    () => toast('📋 Invite link copied — send it to a friend!'),
    () => toast(`Invite link: ${link}`)
  );
});

let mpConnected = false;
let mpStatusDismissed = false;
function dismissMpStatus() {
  if (mpStatusDismissed) return;
  mpStatusDismissed = true;
  mpStatus.style.display = 'none';
}
function updateMpStatus() {
  if (!mpConnected || mpStatusDismissed) return;
  const n = mpPlayerCount();
  const code = mpRoomCode() || '…';
  mpStatus.innerHTML =
    n > 1
      ? `🌐 ${n} penguins in room · <b>${code}</b>`
      : `🌐 Waiting for friends · room <b>${code}</b> · <u>click to copy invite</u>`;
}

mpButton.addEventListener('click', async () => {
  sfx.uiClick();
  mpButton.disabled = true;
  mpButton.textContent = 'Connecting…';
  const ok = await startMultiplayer({
    onError: (e) => {
      mpButton.disabled = false;
      mpButton.textContent = '👥 Play with Friends';
      toast('⚠️ Couldn\'t reach the multiplayer service — try again or play solo.');
      console.error('[mp] connect error', e);
    },
  });
  if (!ok) return;
  mpConnected = true;
  onRemoteLeave(removeRemote);
  // a joining (non-host) player hands authority to the host: drop local entities
  if (!mpIsHost()) enterClientMode();
  beginGame();
  mpStatus.style.display = 'block';
  updateMpStatus();
  // auto-copy the invite link so it's ready to paste
  navigator.clipboard?.writeText(mpInviteUrl()).catch(() => {});
  setTimeout(() => toast('🌐 Multiplayer on! Invite link copied — send it to a friend.'), 1000);
  setTimeout(() => toast('Both players must open the SAME invite link, then click Play with Friends.'), 4000);
  console.log('[mp] connected. invite url:', mpInviteUrl());
});

// =====================================================================
//  Main loop
// =====================================================================
// =====================================================================
//  Atmosphere: smoke, clouds, aurora, twinkling lights
// =====================================================================
// =====================================================================
//  Day / night cycle + dynamic weather
// =====================================================================
let dayTime = 0.32;            // phase 0..1 (0 = midnight, .25 sunrise, .5 noon, .75 sunset)
const DAY_LENGTH = 300;        // seconds for a full day→night→day loop
let weatherCur = 0.4;          // 0 = clear … 1 = blizzard
let weatherTarget = 0.4;
let weatherTimer = 22;
let weatherSnowVis = 0.4;      // read by the snow particle loop
let lastWeatherLabel = 'snow';

// keyframes around the clock — colors/intensities are interpolated between them
const SKY_KEYS = [
  { t: 0.00, top: 0x0a1230, mid: 0x132a55, bot: 0x21406e, fog: 0x16263f, sun: 0x8fa6d8, sunI: 0.12, hemiI: 0.5, exp: 0.82 }, // midnight
  { t: 0.24, top: 0x355a93, mid: 0x8a7ba8, bot: 0xe0a888, fog: 0xc29684, sun: 0xffb070, sunI: 1.1, hemiI: 1.2, exp: 0.96 }, // sunrise glow
  { t: 0.32, top: 0x4b86c6, mid: 0xbcd6ee, bot: 0xffe2bd, fog: 0xd9e6e8, sun: 0xffd8a8, sunI: 2.1, hemiI: 1.8, exp: 1.04 }, // morning
  { t: 0.50, top: 0x2f7fd0, mid: 0x7cc3f0, bot: 0xeaf7ff, fog: 0xbfe9ff, sun: 0xfff2cf, sunI: 2.7, hemiI: 2.1, exp: 1.08 }, // noon
  { t: 0.70, top: 0x3f70b8, mid: 0xc0d2ec, bot: 0xffe0b0, fog: 0xd9d7e0, sun: 0xffd8a8, sunI: 2.0, hemiI: 1.7, exp: 1.04 }, // afternoon
  { t: 0.78, top: 0x394e8c, mid: 0xd98a5e, bot: 0xffb070, fog: 0xdf9e72, sun: 0xff9a55, sunI: 1.0, hemiI: 1.1, exp: 0.95 }, // sunset
  { t: 0.86, top: 0x1c2a55, mid: 0x46407e, bot: 0x6a4f7a, fog: 0x40334f, sun: 0x9a7fc0, sunI: 0.35, hemiI: 0.72, exp: 0.86 }, // dusk
];

const _ca = new THREE.Color(), _cb = new THREE.Color(), _tmpCol = new THREE.Color();
function envColor(out, hexA, hexB, f) { _ca.setHex(hexA); _cb.setHex(hexB); return out.copy(_ca).lerp(_cb, f); }

function updateEnvironment(dt) {
  const role = netRole();
  if (role === 'client') {
    // the host owns time + weather; mirror it
    const env = getGlobal('env');
    if (env) { dayTime = env.tod ?? dayTime; weatherCur = env.wx ?? weatherCur; }
  } else {
    dayTime = (dayTime + dt / DAY_LENGTH) % 1;
    weatherTimer -= dt;
    if (weatherTimer <= 0) {
      weatherTimer = 30 + Math.random() * 45;
      const r = Math.random();
      weatherTarget = r < 0.45 ? 0.1 : r < 0.8 ? 0.5 : 0.95;
    }
    weatherCur += (weatherTarget - weatherCur) * (1 - Math.exp(-0.25 * dt));
    const label = weatherCur > 0.75 ? 'blizzard' : weatherCur > 0.3 ? 'snow' : 'clear';
    if (label !== lastWeatherLabel && started) {
      if (label === 'blizzard') toast('🌨️ A blizzard is rolling in…');
      else if (label === 'clear') toast('☀️ The skies are clearing.');
      else if (lastWeatherLabel === 'clear') toast('❄️ Snow starts to fall.');
      lastWeatherLabel = label;
    }
  }
  weatherSnowVis = weatherCur;

  // locate the surrounding keyframes (wrapping around midnight)
  let a = SKY_KEYS[SKY_KEYS.length - 1], b = SKY_KEYS[0], local = 0;
  for (let k = 0; k < SKY_KEYS.length; k++) {
    const cur = SKY_KEYS[k], nxt = SKY_KEYS[(k + 1) % SKY_KEYS.length];
    let t0 = cur.t, t1 = nxt.t; if (t1 <= t0) t1 += 1;
    let pp = dayTime; if (pp < t0) pp += 1;
    if (pp >= t0 && pp <= t1) { a = cur; b = nxt; local = (pp - t0) / (t1 - t0); break; }
  }
  const f = local * local * (3 - 2 * local); // smoothstep

  envColor(skyMat.uniforms.top.value, a.top, b.top, f);
  envColor(skyMat.uniforms.mid.value, a.mid, b.mid, f);
  envColor(skyMat.uniforms.bottom.value, a.bot, b.bot, f);

  envColor(scene.fog.color, a.fog, b.fog, f);
  scene.fog.far = THREE.MathUtils.lerp(190, 105, weatherCur);
  scene.fog.near = THREE.MathUtils.lerp(60, 22, weatherCur);

  sun.color.copy(envColor(_tmpCol, a.sun, b.sun, f));
  sun.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, f) * (1 - weatherCur * 0.45);
  hemi.intensity = THREE.MathUtils.lerp(a.hemiI, b.hemiI, f) * (1 - weatherCur * 0.3);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(a.exp, b.exp, f);

  // move the sun around an arc; keep some fill light so night isn't pitch black
  const ang = (dayTime - 0.25) * Math.PI * 2;
  const elev = Math.sin(ang);
  sun.position.set(Math.cos(ang) * 80, elev * 95, 30);

  // sun by day, moon by night — reposition + retint the glowing disc
  const up = elev >= 0;
  const lang = up ? ang : ang + Math.PI;       // moon rides the opposite arc
  const lh = Math.abs(elev);
  sunDisc.position.set(Math.cos(lang) * 210, lh * 165 + 20, -150);
  sunDisc.lookAt(0, 0, 0);
  sunHalo.position.copy(sunDisc.position);
  sunHalo.lookAt(0, 0, 0);
  sunDisc.material.color.setHex(up ? 0xfff7e3 : 0xdfe8ff);
  sunHalo.material.color.setHex(up ? 0xfff2c8 : 0xbcd0ff);
  sunHalo.material.opacity = (up ? 0.28 : 0.16) * (1 - weatherCur * 0.7);
  sunDisc.material.opacity = (up ? 0.95 : 0.8) * (1 - weatherCur * 0.6);

  // stars + aurora glow strongest deep at night and fade out in bad weather
  const night = clamp(-elev * 1.3 + 0.12, 0, 1);
  starMat.opacity = night * 0.9 * (1 - weatherCur * 0.7);
  auroraMat.uniforms.intensity.value = night * (1 - weatherCur * 0.6);
}

const smokeGeo = new THREE.SphereGeometry(0.4, 8, 8);
function updateAtmosphere(dt, t) {
  updateEnvironment(dt);
  // aurora shimmer
  auroraMat.uniforms.time.value = t;

  // drifting clouds (wrap around)
  for (const c of clouds) {
    c.sprite.position.x += c.speed * dt;
    if (c.sprite.position.x > 190) c.sprite.position.x = -190;
  }

  // twinkling lights / baubles
  for (const tw of twinkles) {
    const amp = tw.amp ?? 0.45;
    tw.mat.emissiveIntensity = tw.base + Math.sin(t * 2.5 + tw.phase) * amp;
  }

  // chimney smoke
  for (const em of smokeEmitters) {
    em.timer -= dt;
    if (em.timer <= 0) {
      em.timer = 0.5 + Math.random() * 0.4;
      const puff = new THREE.Mesh(smokeGeo, new THREE.MeshStandardMaterial({ color: 0xdfe7ee, transparent: true, opacity: 0.7, roughness: 1 }));
      puff.position.set(em.x + (Math.random() - 0.5) * 0.2, em.y, em.z + (Math.random() - 0.5) * 0.2);
      world.add(puff);
      smokePuffs.push({ mesh: puff, life: 0, drift: (Math.random() - 0.5) * 0.6 });
    }
  }
  for (let i = smokePuffs.length - 1; i >= 0; i--) {
    const s = smokePuffs[i];
    s.life += dt;
    s.mesh.position.y += dt * 1.4;
    s.mesh.position.x += s.drift * dt;
    const grow = 1 + s.life * 1.2;
    s.mesh.scale.setScalar(grow);
    s.mesh.material.opacity = Math.max(0, 0.7 - s.life / 3);
    if (s.life > 3) {
      world.remove(s.mesh);
      s.mesh.material.dispose();
      smokePuffs.splice(i, 1);
    }
  }

  // gentle lake shimmer
  lake.material.opacity = 0.82 + Math.sin(t * 1.5) * 0.06;
}

let lastDt = 0.016;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  lastDt = dt;
  const t = clock.elapsedTime;

  move(dt);

  // player waddle
  const playerSpeed = clamp(velocity.length() / 5, 0, 1);
  if (moving && onGround) waddlePhase += dt * (8 + playerSpeed * 4);
  animatePenguin(player, onGround ? playerSpeed : 0, t, waddlePhase);

  // keep the player's shadow on the ground and shrink it with jump height
  const jumpH = player.group.position.y;
  player.parts.shadow.position.y = 0.02 - jumpH;
  const shScale = clamp(1 - jumpH * 0.18, 0.45, 1);
  player.parts.shadow.scale.set(shScale, shScale, shScale);
  // airborne pose: tuck the body back and spread the flippers
  if (!onGround) {
    player.group.rotation.x = clamp(-velY * 0.015, -0.2, 0.2);
    for (const f of player.parts.flippers) {
      f.rotation.z = f.userData.side * 0.7;
      f.rotation.x = -0.3;
    }
  } else {
    player.group.rotation.x = THREE.MathUtils.lerp(player.group.rotation.x, 0, 1 - Math.exp(-12 * dt));
  }

  const role = netRole();
  if (role === 'client') {
    // CLIENT: the host owns the world; we render its snapshot + handle our own
    // hits/pickups/damage locally and report them upstream.
    clientReconcile(dt, t);
    clientPickups(dt, t);
    clientGhostDanger(dt);
    clientReadRounds();
    clientReadFeed();
    clientReadChats();
    clientCraters();
    updateBossBarFromNet();
    flushHits();
    if (damageFlash > 0) { damageFlash = Math.max(0, damageFlash - dt * 1.6); vignette.style.opacity = String(damageFlash); }
  } else {
    // SOLO or HOST: run the full local simulation.
    updateHorde(dt);
    updateNPCs(dt, t);
    updateMedpacks(dt, t);
    updateAmmoDrops(dt, t);
    updateIceBalls(dt);
    updateIceCraters(dt);
    updateBossBar();
    if (role === 'host') {
      hostReadInputs();
      bcastAcc += dt;
      if (bcastAcc >= 0.05) { bcastAcc = 0; hostBroadcast(); }  // ~20 Hz world snapshot
    }
  }
  updateUpgrader();
  updateBlasts(dt);
  updateSpits(dt);
  updateCombo(dt);
  updateHitMarker(dt);
  updateSnowballs(dt);
  updateWeapons(dt);
  updateEmotes(dt);
  updateChats(dt);
  if (role !== 'client') checkGreetings(dt);
  pushLocalState();
  updateRemotePlayers(dt, t);

  // landmark spin (hat) + gentle bob
  plaza.position.y = Math.sin(t * 1.2) * 0.04;

  updateAtmosphere(dt, t);

  // snow — density / speed / wind all scale with the current weather
  snowPoints.material.opacity = 0.3 + weatherSnowVis * 0.65;
  snowPoints.material.size = 0.15 + weatherSnowVis * 0.13;
  const fallMul = 1 + weatherSnowVis * 1.6;
  const wind = weatherSnowVis * 0.05;
  const p = snowGeo.attributes.position;
  const cx = player.group.position.x;
  const cz = player.group.position.z;
  for (let i = 0; i < snowCount; i++) {
    p.array[i * 3 + 1] -= snowSpeed[i] * dt * fallMul;
    p.array[i * 3] += Math.sin(t * 0.6 + i) * 0.003 + wind;
    if (p.array[i * 3 + 1] < 0) {
      p.array[i * 3 + 1] = 50;
      p.array[i * 3] = cx + (Math.random() - 0.5) * 120;
      p.array[i * 3 + 2] = cz + (Math.random() - 0.5) * 120;
    }
  }
  p.needsUpdate = true;

  if (spectating) updateSpectate();           // may respawn or end the game
  if (spectating) player.group.visible = false;
  else updateCamera();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// focus name input for convenience
ui.nameInput.focus();
updateCamera();
animate();
