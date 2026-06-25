import * as THREE from 'three';
import {
  startMultiplayer, mpActive, mpPlayerCount, setLocalState, eachRemote, onRemoteLeave,
  mpRoomCode, mpInviteUrl, mpIsHost, mpMyId, setGlobal, getGlobal, setMyState, eachRemoteState,
} from './multiplayer.js';
import {
  CATALOG, PALETTE, CATEGORIES, makeObject, defaultDef, mergedParams, registerType,
} from './world/catalog.js';
import { COMPONENTS, COMPONENT_TYPES, defaultComponent } from './world/components.js';
import { defaultTown } from './world/defaultTown.js';
import townLevel from './levels/town.json';

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
    // shotgun: a fat, throaty boom with a low body thump and a pump-rack tail
    shotgun() { go((t) => {
      noise(0.26, t, 0.6, 'lowpass', 1100, 0.6); noise(0.16, t, 0.5, 'highpass', 700);
      tone(120, t, 0.2, 'square', 0.34, 46); tone(72, t, 0.26, 'sine', 0.42, 38);
      noise(0.05, t + 0.22, 0.18, 'highpass', 2600); tone(380, t + 0.24, 0.05, 'square', 0.16, 220);  // chk-chk pump
    }); },
    // quick weapon swap — light mechanical clack
    swap() { go((t) => { tone(360, t, 0.05, 'square', 0.16, 220); tone(560, t + 0.07, 0.05, 'square', 0.16, 320); }); },
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
    // two quick bites with a downward gnash — eating a candy bar
    chomp() { go((t) => {
      noise(0.07, t, 0.36, 'lowpass', 900, 0.8); tone(260, t, 0.07, 'sawtooth', 0.22, 110);
      noise(0.07, t + 0.12, 0.34, 'lowpass', 760, 0.8); tone(210, t + 0.12, 0.08, 'sawtooth', 0.22, 85);
      tone(1320, t + 0.2, 0.12, 'triangle', 0.14, 1760);   // sweet little chime to sell the sugar rush
    }); },
    // siren screech — a piercing dissonant wail that disorients
    screech() { go((t) => {
      noise(0.55, t, 0.2, 'bandpass', 2400, 4);
      tone(1300, t, 0.55, 'sawtooth', 0.16, 520);
      tone(1720, t + 0.02, 0.5, 'square', 0.09, 700);
      tone(880, t + 0.05, 0.55, 'triangle', 0.12, 300);
      tone(2100, t + 0.08, 0.4, 'sawtooth', 0.07, 1500);
    }); },
    // hissing burst of toxic gas escaping
    gas() { go((t) => {
      noise(0.95, t, 0.16, 'highpass', 1700, 0.7);
      tone(420, t, 0.5, 'sawtooth', 0.05, 170);
      noise(0.5, t + 0.1, 0.1, 'bandpass', 900, 2);
    }); },
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

// ---------- world dressing (data-driven) ----------
// The entire town — terrain, snow mounds, the frozen lake, the toboggan
// hill, the plaza floor, walkways, string lights, bunting, docks, ramp
// rails, the central snow-giant landmark, location signs, the weapon shop,
// Gunther and the pistol pickup — are all GameObject defs now (see
// src/world/catalog.js + src/world/defaultTown.js). They load through the
// level system into the editor layer so every piece is editable, movable
// and deletable. Delete them all and you get a truly empty scene.

// animated twinkle lights (emissive meshes tagged with userData.twinkle are
// collected into this list by the level loader and pulsed in the animate loop)
const twinkles = [];

// chimney smoke emitters (the animate loop reads these arrays)
const smokeEmitters = [];
const smokePuffs = [];

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
  // yaw-first rotation order so the running lean (pitch) and waddle (roll) are
  // applied in the penguin's own facing frame. With the default XYZ order they
  // mix with the heading yaw and read as a sideways tilt when running across
  // certain world directions.
  g.rotation.order = 'YXZ';
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
  } else if (type === 'siren') {
    // long flowing hair: a back curtain of locks + side bangs, plus eyelashes,
    // so she reads instantly as a distinct support enemy at a glance
    const hairMat = mat(0x241016, 0.7);
    // crown/bangs cap framing the face
    const crown = mesh(new THREE.SphereGeometry(0.72, 18, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat, false, false);
    crown.position.set(0, 2.12, -0.04);
    crown.scale.set(1.04, 1.0, 1.06);
    group.add(crown);
    // draping locks down the back and sides (long hair)
    const locks = [
      { x: -0.46, z: -0.22, len: 1.7, tilt: 0.12 },
      { x: 0.46, z: -0.22, len: 1.7, tilt: -0.12 },
      { x: 0, z: -0.5, len: 2.0, tilt: 0 },
      { x: -0.26, z: -0.46, len: 1.9, tilt: 0.06 },
      { x: 0.26, z: -0.46, len: 1.9, tilt: -0.06 },
      { x: -0.62, z: 0.16, len: 1.2, tilt: 0.18 },
      { x: 0.62, z: 0.16, len: 1.2, tilt: -0.18 },
    ];
    for (const l of locks) {
      const lock = mesh(new THREE.CapsuleGeometry(0.17, l.len, 4, 8), hairMat, false, false);
      lock.position.set(l.x, 2.05 - l.len * 0.45, l.z);
      lock.rotation.z = l.tilt;
      lock.rotation.x = -0.12;
      group.add(lock);
    }
    // long eyelashes — small dark cones flicking up from each eye
    for (const sx of [-0.24, 0.24]) {
      for (const k of [-1, 0, 1]) {
        const lash = mesh(new THREE.ConeGeometry(0.025, 0.16, 6), hairMat, false, false);
        lash.position.set(sx + k * 0.07, 2.3, 0.6);
        lash.rotation.x = -0.9;
        lash.rotation.z = k * 0.25;
        group.add(lash);
      }
    }
  } else if (type === 'gasser') {
    // gas mask: dark goggle lenses, a filter canister snout, and a face strap
    const maskMat = mat(0x39463a, 0.5);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x223028, emissive: 0x74d674, emissiveIntensity: 0.35, roughness: 0.15 });
    for (const sx of [-0.24, 0.24]) {
      const rim = mesh(new THREE.TorusGeometry(0.2, 0.06, 8, 16), maskMat, false, false);
      rim.position.set(sx, 2.18, 0.56);
      group.add(rim);
      const lens = mesh(new THREE.SphereGeometry(0.19, 14, 12), glassMat, false, false);
      lens.scale.set(1, 1, 0.55);
      lens.position.set(sx, 2.18, 0.55);
      group.add(lens);
    }
    // filter canister jutting from the snout
    const canister = mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.5, 14), maskMat, false, false);
    canister.rotation.x = Math.PI / 2;
    canister.position.set(0, 1.9, 0.74);
    group.add(canister);
    const cap = mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.12, 14), mat(0x222a23, 0.5), false, false);
    cap.rotation.x = Math.PI / 2;
    cap.position.set(0, 1.9, 1.0);
    group.add(cap);
    // strap wrapping the head
    const strap = mesh(new THREE.TorusGeometry(0.52, 0.07, 8, 20), maskMat, false, false);
    strap.position.set(0, 2.05, 0.16);
    group.add(strap);
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
vignette.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;background:radial-gradient(135% 110% at 50% 50%, transparent 34%, rgba(180,0,0,.32) 64%, rgba(140,0,0,.72) 85%, rgba(85,0,0,.96) 100%);transition:opacity .07s ease-out';
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
//  Weapon shop — buy the pistol & upgrade it by talking to the keeper.
//  The shop stall, Gunther and the pistol pickup are data-driven
//  GameObjects (see defaultTown.js); the buy/upgrade gameplay below reads
//  their live positions via refs resolved in syncSceneRefs() (called from
//  rebuildSolid on load and after every editor edit). Move or delete the
//  shop in the editor and the gameplay follows.
// =====================================================================
const SHOP_R = 5.2;
let shopRec = null;        // placed 'shop' GameObject (counter the player chats across)
let gunPickupRec = null;   // placed 'gunpickup' GameObject (hidden once bought)

// ---------------------------------------------------------------------
//  Shop: a walk-in zone in front of the counter. Step onto the glowing pad
//  and a storefront screen opens (releasing the look-camera so you can use the
//  mouse); buy/upgrade/restock in there; walk back out to close it and resume.
// ---------------------------------------------------------------------
// ammo crate size + pricing now live per-weapon in the WEAPONS registry; cost
// scales with the weapon's level so a maxed gun can't endlessly restock cheaply.
function weaponAmmoCost(w) { return Math.round(w.ammoBaseCost * (1 + (w.level - 1) * 0.6)); }
const SHOP_ZONE_R = 3.4;
let shopZone = null;             // { x, z, r } in front of the counter
let shopOpen = false;

// glowing floor pad marking the storefront zone
const shopPad = (() => {
  const g = new THREE.Group();
  const ring = mesh(new THREE.RingGeometry(SHOP_ZONE_R - 0.55, SHOP_ZONE_R, 44),
    new THREE.MeshBasicMaterial({ color: 0x57d7ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }), false, false);
  ring.rotation.x = -Math.PI / 2;
  const disc = mesh(new THREE.CircleGeometry(SHOP_ZONE_R - 0.55, 44),
    new THREE.MeshBasicMaterial({ color: 0x1f9fd0, transparent: true, opacity: 0.12, depthWrite: false }), false, false);
  disc.rotation.x = -Math.PI / 2;
  g.add(ring); g.add(disc);
  g.visible = false;
  world.add(g);
  return g;
})();

function computeShopZone() {
  if (!shopRec) { shopZone = null; return; }
  const sp = shopRec.obj.position;
  // the "front" of the counter is wherever the pistol pickup sits (customer side);
  // fall back to the shop's facing if there's no pickup placed.
  let fx, fz;
  if (gunPickupRec) {
    const gp = gunPickupRec.obj.position;
    const dx = gp.x - sp.x, dz = gp.z - sp.z, l = Math.hypot(dx, dz) || 1;
    fx = dx / l; fz = dz / l;
  } else {
    fx = Math.sin(shopRec.obj.rotation.y + Math.PI);
    fz = Math.cos(shopRec.obj.rotation.y + Math.PI);
  }
  const zx = sp.x + fx * 2.7, zz = sp.z + fz * 2.7;
  shopZone = { x: zx, z: zz, r: SHOP_ZONE_R };
  shopPad.position.set(zx, groundHeightAt(zx, zz, 0) + 0.04, zz);
}
function inShopZone() {
  return shopZone && Math.hypot(player.group.position.x - shopZone.x, player.group.position.z - shopZone.z) < shopZone.r;
}

// ---- storefront screen ----
const shopStyle = document.createElement('style');
shopStyle.textContent = `
  #shop-screen { position: fixed; inset: 0; z-index: 14; display: none; align-items: center; justify-content: center;
    pointer-events: none; font-family: "Baloo 2", system-ui; backdrop-filter: blur(2px); background: rgba(4,12,22,.28); }
  #shop-card { pointer-events: auto; width: min(480px, 93vw); background: linear-gradient(180deg, rgba(17,44,66,.98), rgba(8,22,36,.99));
    border: 2px solid rgba(120,200,255,.45); border-radius: 22px;
    box-shadow: 0 30px 70px rgba(0,0,0,.6), inset 0 1px 0 rgba(255,255,255,.12); padding: 0; color: #eaf6ff; overflow: hidden;
    animation: shopPop .18s cubic-bezier(.2,.9,.3,1.2); }
  @keyframes shopPop { from { transform: scale(.92) translateY(8px); opacity: 0 } to { transform: scale(1) translateY(0); opacity: 1 } }
  .shop-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 16px 18px 14px; background: linear-gradient(180deg, rgba(40,98,150,.45), rgba(40,98,150,0));
    border-bottom: 1px solid rgba(255,255,255,.08); }
  .shop-title { font-weight: 900; font-size: 22px; line-height: 1.05; letter-spacing: .01em; }
  .shop-sub { font-weight: 700; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; opacity: .5; margin-top: 3px; }
  #shop-cash { flex: none; font-size: 16px; font-weight: 900; color: #ffe23a; background: rgba(45,120,55,.45);
    border: 1px solid rgba(140,230,150,.3); padding: 6px 13px; border-radius: 999px; white-space: nowrap; }
  #shop-items { padding: 12px; display: flex; flex-direction: column; gap: 10px; max-height: 62vh; overflow-y: auto; }
  #shop-items::-webkit-scrollbar { width: 8px; }
  #shop-items::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 8px; }
  .gun-card { border-radius: 16px; background: rgba(255,255,255,.045); border: 1px solid rgba(255,255,255,.07); overflow: hidden; }
  .gun-card.owned { border-color: rgba(120,200,255,.3); background: rgba(70,150,210,.1); }
  .gun-card.locked { opacity: .5; }
  .gun-head { display: flex; align-items: center; gap: 13px; padding: 12px 13px; }
  .gun-ic { flex: none; width: 48px; height: 48px; display: grid; place-items: center; font-size: 26px;
    border-radius: 13px; background: rgba(0,0,0,.28); box-shadow: inset 0 0 0 1px rgba(255,255,255,.07); }
  .gun-meta { flex: 1; min-width: 0; }
  .gun-name { font-weight: 800; font-size: 16px; display: flex; align-items: center; gap: 7px; }
  .gun-badge { font-size: 11px; font-weight: 800; letter-spacing: .04em; color: #bfe6ff; background: rgba(120,200,255,.22);
    padding: 2px 8px; border-radius: 999px; }
  .gun-tag { font-size: 12px; opacity: .6; margin-top: 1px; }
  .gun-status { flex: none; font-weight: 900; font-size: 13px; letter-spacing: .06em; color: rgba(255,255,255,.55);
    padding: 6px 12px; border-radius: 10px; background: rgba(255,255,255,.06); white-space: nowrap; }
  .gun-status.price { color: #ffe23a; background: rgba(45,120,55,.4); }
  .gun-actions { display: flex; gap: 8px; padding: 0 13px 13px; }
  .gun-actions.single { padding-bottom: 13px; }
  .shop-buy { flex: 1; border: none; cursor: pointer; border-radius: 12px; padding: 11px 12px; font: 800 13.5px "Baloo 2", system-ui;
    color: #06210f; background: linear-gradient(180deg,#8ff2ab,#37c267); box-shadow: inset 0 -3px 0 rgba(0,0,0,.22), 0 4px 10px rgba(40,160,80,.25);
    transition: filter .12s, transform .05s; line-height: 1.15; }
  .shop-buy.alt { color: #07243a; background: linear-gradient(180deg,#9bd6ff,#4aa3e6); box-shadow: inset 0 -3px 0 rgba(0,0,0,.22), 0 4px 10px rgba(40,120,200,.25); }
  .shop-buy:hover { filter: brightness(1.08); }
  .shop-buy:active { transform: translateY(1px); }
  .shop-buy:disabled { cursor: default; color: rgba(255,255,255,.4); background: rgba(255,255,255,.06); box-shadow: none; }
  .shop-buy small { display: block; font-weight: 700; font-size: 11px; opacity: .8; }
  #shop-foot { text-align: center; font-size: 12px; font-weight: 700; opacity: .5; padding: 4px 0 14px; }
`;
document.head.appendChild(shopStyle);

const shopScreen = document.createElement('div');
shopScreen.id = 'shop-screen';
shopScreen.innerHTML = `<div id="shop-card">
  <div class="shop-head">
    <div><div class="shop-title">🐧 Gunther's Armory</div><div class="shop-sub">Gear up, penguin</div></div>
    <span id="shop-cash">💵 $0</span>
  </div>
  <div id="shop-items"></div>
  <div id="shop-foot">Walk off the pad to leave</div>
</div>`;
document.body.appendChild(shopScreen);
const shopItemsEl = shopScreen.querySelector('#shop-items');
const shopCashEl = shopScreen.querySelector('#shop-cash');

// The storefront is driven entirely by the WEAPONS registry (defined down in the
// weapon section). Each gun gets its own card with buy / upgrade / restock / equip,
// so adding a weapon is just adding a registry entry — no shop code changes needed.
function buildGunCard(w) {
  const owned = w.owned;
  const lvl = w.level;
  const badge = owned ? `<span class="gun-badge">Mk.${lvl}</span>` : '';
  const equippedTag = (owned && w.id === equipped)
    ? `<span class="gun-badge" style="background:rgba(120,255,170,.22);color:#bfffd2">EQUIPPED</span>` : '';
  const status = owned
    ? `<div class="gun-status">⦿ ${w.reserve}/${w.reserveMax}</div>`
    : `<div class="gun-status price">${w.cost ? '$' + w.cost : 'FREE'}</div>`;

  let actions;
  if (!owned) {
    const can = cash >= w.cost;
    const label = w.cost ? `Buy — $${w.cost}` : 'Get for FREE';
    actions = `<div class="gun-actions single"><button class="shop-buy" data-gun="${w.id}" data-act="buy"${can ? '' : ' disabled'}>${label}</button></div>`;
  } else {
    const maxed = w.level >= w.maxLevel;
    const upBtn = maxed
      ? `<button class="shop-buy" disabled>Fully Maxed</button>`
      : `<button class="shop-buy" data-gun="${w.id}" data-act="upgrade"${cash >= w.upgradeCost ? '' : ' disabled'}>Upgrade → Mk.${lvl + 1}<small>$${w.upgradeCost}</small></button>`;
    const full = w.reserve >= w.reserveMax;
    const ammoCost = weaponAmmoCost(w);
    const ammoBtn = full
      ? `<button class="shop-buy alt" disabled>Ammo Full</button>`
      : `<button class="shop-buy alt" data-gun="${w.id}" data-act="ammo"${cash >= ammoCost ? '' : ' disabled'}>Buy Ammo +${w.ammoPack}<small>$${ammoCost}</small></button>`;
    const equipRow = (w.id === equipped)
      ? ''
      : `<div class="gun-actions single"><button class="shop-buy alt" data-gun="${w.id}" data-act="equip">Equip ${w.name}</button></div>`;
    actions = `<div class="gun-actions">${upBtn}${ammoBtn}</div>${equipRow}`;
  }
  return `<div class="gun-card ${owned ? 'owned' : ''}"><div class="gun-head">` +
    `<div class="gun-ic">${w.icon}</div>` +
    `<div class="gun-meta"><div class="gun-name">${w.name}${badge}${equippedTag}</div><div class="gun-tag">${w.tag}</div></div>` +
    `${status}</div>${actions}</div>`;
}
function renderShop() {
  if (WEAPONS[equipped].owned) saveEquipped();   // keep the live gun's record fresh
  shopCashEl.textContent = `💵 $${cash}`;
  shopItemsEl.innerHTML = WEAPON_ORDER.map((id) => buildGunCard(WEAPONS[id])).join('');
}
shopItemsEl.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const w = WEAPONS[b.dataset.gun];
  if (!w) return;
  const act = b.dataset.act;
  if (act === 'buy') shopBuyWeapon(w);
  else if (act === 'upgrade') shopUpgradeWeapon(w);
  else if (act === 'ammo') shopBuyAmmoFor(w);
  else if (act === 'equip') { equipWeapon(w.id); renderShop(); }
});

function openShop() {
  shopOpen = true;
  firing = false;
  dragging = false;
  if (document.pointerLockElement) document.exitPointerLock();
  renderer.domElement.style.cursor = 'default';
  ui.crosshair.style.display = 'none';
  shopScreen.style.display = 'flex';
  renderShop();
  sfx.resume();
}
function closeShop() {
  shopOpen = false;
  shopScreen.style.display = 'none';
  if (started && !gameOver && !spectating) {
    renderer.domElement.style.cursor = 'none';
    ui.crosshair.style.display = 'block';
    // if we're still zoomed into first-person, recapture the mouse so look
    // works again right away (otherwise it stays dead until you scroll out/in).
    if (camDist <= FP_DIST && !document.pointerLockElement) {
      const r = document.body.requestPointerLock();
      if (r && r.catch) r.catch(() => {});   // ignore the no-gesture rejection
    }
  }
}

function shopBuyWeapon(w) {
  if (w.owned || cash < w.cost) return;
  cash -= w.cost;
  acquireWeapon(w);                 // marks owned, refills, equips, shows HUD
  updateCashHUD();
  sfx.pickup();
  const ownedCount = WEAPON_ORDER.filter((k) => WEAPONS[k].owned).length;
  const hint = ownedCount > 1 ? ' — press Q to swap weapons' : '';
  toast(`${w.icon} ${w.cost ? 'Bought' : 'Unlocked'} the ${w.name}!${hint}`);
  renderShop();
}
function shopUpgradeWeapon(w) {
  if (!w.owned || w.level >= w.maxLevel || cash < w.upgradeCost) return;
  cash -= w.upgradeCost;
  if (w.id === equipped) saveEquipped();   // capture live ammo before mutating the record
  w.level++;
  // weighted-random gains: usually a small bump, occasionally a jackpot.
  const roll = Math.pow(Math.random(), 2.4);
  const dmgGain = Math.round((0.5 + roll * 5.5) * 10) / 10;       // +0.5 .. +6.0 dmg
  // shotgun mags are small by design, so they grow far slower than the pistol's
  const magGain = w.id === 'shotgun' ? Math.max(1, Math.round(roll * 2)) : Math.round(2 + roll * 16);
  w.damage = Math.round((w.damage + dmgGain) * 10) / 10;
  w.magSize += magGain;
  w.reserveMax += magGain * (w.id === 'shotgun' ? 6 : 3);
  w.ammo = w.magSize;
  w.reserve = w.reserveMax;          // upgrading fully restocks
  w.upgradeCost = Math.round(w.upgradeCost * 1.8);
  // the shotgun also tightens its pattern and occasionally packs more pellets
  let pelletNote = '';
  if (w.id === 'shotgun') {
    if (roll > 0.5 && w.pellets < 14) { w.pellets++; pelletNote = `, +1 pellet (${w.pellets})`; }
    w.spread = Math.max(0.045, Math.round(w.spread * 0.9 * 1000) / 1000);
  }
  if (w.id === equipped) loadEquipped();   // push the new stats into the live gun
  updateCashHUD();
  updateWeaponHUD();
  sfx.upgrade();
  const tier = roll > 0.65 ? '💥 JACKPOT UPGRADE!' : roll > 0.3 ? '✨ Solid upgrade' : '⚙️ Upgraded';
  toast(`${tier} ${w.name} Mk.${w.level} — +${dmgGain} dmg${pelletNote} • ammo refilled`);
  renderShop();
}
function shopBuyAmmoFor(w) {
  const price = weaponAmmoCost(w);
  if (!w.owned || w.reserve >= w.reserveMax || cash < price) return;
  cash -= price;
  if (w.id === equipped) saveEquipped();
  w.reserve = Math.min(w.reserveMax, w.reserve + w.ammoPack);
  if (w.id === equipped) loadEquipped();
  updateCashHUD();
  updateWeaponHUD();
  sfx.pickup();
  toast(`📦 +${w.ammoPack} ${w.name} rounds`);
  renderShop();
}

// per-frame: pulse the pad, and open/close the screen as the player enters/leaves
function updateShop(dt, t) {
  const active = started && !gameOver && !spectating && !!shopZone;
  shopPad.visible = active;
  if (active) {
    const here = inShopZone();
    shopPad.children[0].material.opacity = here ? 0.75 : 0.35 + 0.2 * (0.5 + 0.5 * Math.sin(t * 3));
    shopPad.rotation.y += dt * 0.5;
    if (here && !shopOpen) openShop();
    else if (!here && shopOpen) closeShop();
    // keep the open screen's prices/cash live
    if (shopOpen) shopCashEl.textContent = `💵 $${cash}`;
  } else if (shopOpen) {
    closeShop();
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
  const siren = round >= 6 ? Math.min(0.12, 0.025 + round * 0.008) : 0;
  const gasser = round >= 7 ? Math.min(0.13, 0.03 + round * 0.008) : 0;
  let acc = 0;
  if (r < (acc += brute)) return 'brute';
  if (r < (acc += runner)) return 'runner';
  if (r < (acc += bomber)) return 'bomber';
  if (r < (acc += spitter)) return 'spitter';
  if (r < (acc += siren)) return 'siren';
  if (r < (acc += gasser)) return 'gasser';
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
  } else if (type === 'siren') {
    // support unit: hangs back, screeches to disorient you + enrage the horde
    cfg = { color: 0xc94f9c, scale: 1.05, hp: baseHp + 2, speedBonus: -0.5, cashReward: 28, contactDmg: 6 };
  } else if (type === 'gasser') {
    // bursts into a lingering toxic cloud on death — don't stand where it falls
    cfg = { color: 0x6b7a55, scale: 1.0, hp: baseHp + 1, speedBonus: 0.1, cashReward: 24, contactDmg: 7 };
  } else {
    cfg = { color: ZOMBIE_COLORS[Math.floor(Math.random() * ZOMBIE_COLORS.length)], scale: 1, hp: baseHp, speedBonus: Math.min(2.2, round * 0.1), cashReward: 10, contactDmg: 7 };
  }
  addNPC({ ...cfg, x, z, zombie: true, type });
  zSpawned++;
  setOnline();
}

function spawnBoss() {
  const { x, z } = edgeSpawnPoint();
  const hp = 120 + round * 30;   // a real damage sponge — should take a sustained fight
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
  // bigger hits punch the screen harder, capped so a chip of damage still reads
  damageFlash = clamp(0.55 + amount * 0.03, 0.6, 1);
  vignette.style.opacity = String(damageFlash);
  updatePlayerHP();
  // in co-op a death only downs you — you respawn next round if a teammate lives
  if (playerHP <= 0) { if (mpActive() && anyTeammateAlive()) downPlayer(); else endGame(); }
}

// AAA-style hit feedback driven once per frame: the red "iris" punches in from
// the screen edges when hit (damageFlash decays), and once you're near death the
// edges stay lit and throb like a heartbeat so low HP is felt, not just read.
function updateDamageVignette(dt, t) {
  if (damageFlash > 0) damageFlash = Math.max(0, damageFlash - dt * 1.7);
  const hpFrac = playerHP / PLAYER_MAX_HP;
  // starts creeping in below ~55% HP and intensifies hard toward death; the
  // heartbeat also beats faster and harder the lower you get
  const lowf = clamp((0.55 - hpFrac) / 0.55, 0, 1);
  const pulse = 0.5 + 0.5 * Math.sin(t * (5 + lowf * 5));
  const beat = lowf * (0.35 + 0.55 * lowf) * (0.5 + 0.5 * pulse);
  const op = (gameOver || spectating) ? 0 : Math.max(damageFlash, beat);
  vignette.style.opacity = op.toFixed(3);
}

function endGame() {
  gameOver = true;
  started = false;
  firing = false;
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

function damageNPC(npc, dmg, point, headshot = false, attackerId = mpMyId(), dir = null) {
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
  spawnBloodBurst(point, dir);
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
  // loot drops
  if (hordeMode && npc.type === 'boss') {
    // boss: a generous spread of med packs + ammo scattered around the corpse
    const bx = npc.group.position.x, bz = npc.group.position.z;
    const meds = 3, boxes = 4;
    for (let k = 0; k < meds; k++) {
      const a = (k / meds) * Math.PI * 2 + Math.random() * 0.6;
      const r = 1.8 + Math.random() * 1.4;
      spawnMedpackAt(bx + Math.cos(a) * r, bz + Math.sin(a) * r);
    }
    for (let k = 0; k < boxes; k++) {
      const a = (k / boxes) * Math.PI * 2 + 0.5 + Math.random() * 0.6;
      const r = 2.4 + Math.random() * 1.8;
      spawnAmmoDrop(bx + Math.cos(a) * r, bz + Math.sin(a) * r, 12 + Math.floor(Math.random() * 8), true);
    }
    const candies = 3;
    for (let k = 0; k < candies; k++) {
      const a = (k / candies) * Math.PI * 2 + 1.0 + Math.random() * 0.6;
      const r = 2.0 + Math.random() * 1.6;
      spawnCandyDrop(bx + Math.cos(a) * r, bz + Math.sin(a) * r);
    }
  } else if (hordeMode) {
    // random ammo drop — scarce; bigger threats are a bit more generous
    const dropChance = npc.type === 'brute' ? 0.45 : 0.24;
    if (Math.random() < dropChance) {
      const amt = npc.type === 'brute' ? 16 : 6 + Math.floor(Math.random() * 6);
      spawnAmmoDrop(npc.group.position.x, npc.group.position.z, amt);
    }
    // rare candy bar — a quick burst of speed for whoever grabs it
    if (npc.type !== 'bomber' && Math.random() < 0.08) {
      spawnCandyDrop(npc.group.position.x, npc.group.position.z);
    }
  }
  setOnline();
  updateWeaponHUD();
  spawnBloodPool(npc.group.position.x, npc.group.position.z);
  spawnBloodBurst(point);
  // gas-mask penguins rupture into a lingering toxic cloud where they fall
  if (npc.type === 'gasser') spawnGasCloud(npc.group.position.x, npc.group.position.z);
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
  spawnMedpackAt(x, z);
}
// place a med pack at a specific point (used for boss loot — bypasses the cap)
function spawnMedpackAt(x, z) {
  const r = Math.hypot(x, z);
  if (r > 100) { const k = 100 / r; x *= k; z *= k; }
  // nudge out of any wall it landed in
  let tries = 0;
  while (collides({ x, z }) && tries < 10) { x += (Math.random() - 0.5) * 2.4; z += (Math.random() - 0.5) * 2.4; tries++; }
  const g = makeMedpack();
  const gy = groundHeightAt(x, z, 0);
  g.position.set(x, gy, z);
  world.add(g);
  medpacks.push({ id: nextNetId++, group: g, x, z, gy, bob: Math.random() * 6 });
}

function updateMedpacks(dt, t) {
  if (hordeMode && !gameOver) {
    medTimer -= dt;
    if (medTimer <= 0) { medTimer = 42 + Math.random() * 22; spawnMedpack(); }
  }
  for (let i = medpacks.length - 1; i >= 0; i--) {
    const m = medpacks[i];
    m.group.rotation.y += dt * 1.5;
    m.group.position.y = (m.gy || 0) + Math.sin(t * 2 + m.bob) * 0.18 + 0.1;
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
function spawnAmmoDrop(x, z, amount, force = false) {
  // hard cap on how much ammo can sit uncollected on the map — keeps it scarce
  // (boss loot ignores the cap so its reward always lands)
  if (!force) {
    if (groundAmmoTotal() >= MAP_AMMO_CAP) return;
    amount = Math.min(amount, MAP_AMMO_CAP - groundAmmoTotal());
    if (amount <= 0) return;
  }
  // pull edge/out-of-bounds kills back inside the wall so the drop is reachable
  const r = Math.hypot(x, z);
  if (r > 100) { const k = 100 / r; x *= k; z *= k; }
  const g = makeAmmoBox();
  const gy = groundHeightAt(x, z, 0);
  g.position.set(x, gy, z);
  world.add(g);
  ammoDrops.push({ id: nextNetId++, group: g, x, z, gy, amount, bob: Math.random() * 6, age: 0 });
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
    a.group.position.y = (a.gy || 0) + Math.sin(t * 2.4 + a.bob) * 0.14 + 0.06;
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
//  Candy bars — a rare zombie drop that grants a short speed boost
// =====================================================================
const candyDrops = [];
const CANDY_TTL = 60;   // seconds before an uncollected candy bar despawns
function makeCandyBar() {
  const g = new THREE.Group();
  const bar = mesh(new THREE.BoxGeometry(0.8, 0.28, 0.42), new THREE.MeshStandardMaterial({ color: 0xff3d8b, roughness: 0.45, emissive: 0xff1f6e, emissiveIntensity: 0.3 }));
  bar.position.y = 0.36; bar.castShadow = true; g.add(bar);
  for (const dx of [-0.22, 0.06]) {                 // bright wrapper stripes
    const st = mesh(new THREE.BoxGeometry(0.12, 0.31, 0.44), mat(0x32e0ff, 0.4), false, false);
    st.position.set(dx, 0.36, 0); g.add(st);
  }
  for (const ex of [-0.5, 0.5]) {                   // crimped wrapper ends
    const end = mesh(new THREE.BoxGeometry(0.18, 0.34, 0.5), mat(0xffe14a, 0.5), false, false);
    end.position.set(ex, 0.36, 0); g.add(end);
  }
  const glow = mesh(new THREE.TorusGeometry(0.55, 0.045, 8, 22), new THREE.MeshStandardMaterial({ color: 0x32e0ff, emissive: 0x18c0ff, emissiveIntensity: 1.3 }), false, false);
  glow.rotation.x = Math.PI / 2; glow.position.y = 0.1; g.add(glow);
  const beam = mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.5, 8), new THREE.MeshBasicMaterial({ color: 0x32e0ff, transparent: true, opacity: 0.22, depthWrite: false }), false, false);
  beam.position.y = 2.4; g.add(beam);
  return g;
}
function spawnCandyDrop(x, z) {
  const r = Math.hypot(x, z);
  if (r > 100) { const k = 100 / r; x *= k; z *= k; }   // keep it inside the wall
  const g = makeCandyBar();
  const gy = groundHeightAt(x, z, 0);
  g.position.set(x, gy, z);
  world.add(g);
  candyDrops.push({ id: nextNetId++, group: g, x, z, gy, bob: Math.random() * 6, age: 0 });
}
function updateCandyDrops(dt, t) {
  for (let i = candyDrops.length - 1; i >= 0; i--) {
    const c = candyDrops[i];
    c.age += dt;
    if (c.age > CANDY_TTL || Math.hypot(c.x, c.z) > 104) { world.remove(c.group); candyDrops.splice(i, 1); continue; }
    c.group.rotation.y += dt * 2.2;
    c.group.position.y = (c.gy || 0) + Math.sin(t * 2.6 + c.bob) * 0.16 + 0.08;
    c.group.visible = c.age < CANDY_TTL - 6 || Math.sin(c.age * 14) > 0;
    if (started && !gameOver && Math.hypot(player.group.position.x - c.x, player.group.position.z - c.z) < 1.9) {
      grantSpeedBoost();
      floatText('SUGAR RUSH!', new THREE.Vector3(c.x, 1.3, c.z), '#ff5fb0', 20);
      world.remove(c.group);
      candyDrops.splice(i, 1);
    }
  }
}
function removeCandyById(id) {
  for (let i = candyDrops.length - 1; i >= 0; i--) {
    if (candyDrops[i].id === id) { world.remove(candyDrops[i].group); candyDrops.splice(i, 1); return; }
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
const boostPill = document.createElement('div');
boostPill.className = 'status-pill';
boostPill.style.display = 'none';
boostPill.style.background = 'rgba(255,61,139,.55)';
statusBar.appendChild(elimPill);
statusBar.appendChild(ammoPill);
statusBar.appendChild(boostPill);
function updateBoostHUD() {
  if (speedBoostT > 0) { boostPill.style.display = ''; boostPill.innerHTML = `🍬 <span>${speedBoostT.toFixed(1)}s</span>`; }
  else boostPill.style.display = 'none';
}
function updateWeaponHUD() {
  const mag = reloading ? '· · ·' : ammo;
  const low = ammoReserve === 0 && ammo === 0;
  const icon = (typeof WEAPONS !== 'undefined' && WEAPONS[equipped]) ? WEAPONS[equipped].icon : '🔫';
  ammoPill.innerHTML = `${icon} <span>${mag}</span> <span style="opacity:.6">| ${ammoReserve}</span>`;
  ammoPill.style.color = low ? '#ff6b6b' : '';
  elimPill.innerHTML = `💀 <span>${eliminations}</span>`;
}
function setOnline() { ui.online.textContent = aliveZombies() + 1; }

// --- pistol model ---
const GUN_SKINS = [
  { slide: 0x23262b, barrel: 0x14161a, grip: 0x14161a, accent: 0x555b66, glow: 0x000000, glowI: 0 },
  { slide: 0x2b3b5f, barrel: 0x17213a, grip: 0x1b2742, accent: 0x58a6ff, glow: 0x1b75ff, glowI: 0.25 },
  { slide: 0x31245f, barrel: 0x17102f, grip: 0x24183f, accent: 0xb46cff, glow: 0x9b4dff, glowI: 0.45 },
  { slide: 0x5f2f16, barrel: 0x2b1309, grip: 0x3a1b0e, accent: 0xffb347, glow: 0xff8a1c, glowI: 0.65 },
  { slide: 0x123f38, barrel: 0x08211f, grip: 0x0d2f2b, accent: 0x6effd8, glow: 0x20ffd0, glowI: 0.85 },
  { slide: 0x571022, barrel: 0x220611, grip: 0x330916, accent: 0xff3f8e, glow: 0xff2a78, glowI: 1.05 },
  { slide: 0xf2d06b, barrel: 0x3a2705, grip: 0x5b3b09, accent: 0xffffff, glow: 0xffd23f, glowI: 1.25 },
];

function gunSkinForLevel(level) {
  return GUN_SKINS[Math.min(GUN_SKINS.length - 1, Math.max(0, level - 1))];
}

function applyGunSkin(gun, level = gunLevel) {
  const skin = gunSkinForLevel(level);
  gun.traverse((m) => {
    if (!m.isMesh || !m.userData.gunPart) return;
    const part = m.userData.gunPart;
    const color = skin[part] ?? skin.slide;
    m.material.color.setHex(color);
    if (m.material.emissive) {
      const glow = part === 'accent' ? skin.glow : 0x000000;
      m.material.emissive.setHex(glow);
      m.material.emissiveIntensity = part === 'accent' ? skin.glowI : 0;
    }
  });
}

function makePistol(scale = 1) {
  const g = new THREE.Group();
  const metal = mat(0x23262b, 0.4);
  const dark = mat(0x14161a, 0.5);
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x555b66, roughness: 0.28, metalness: 0.15, emissive: 0x000000, emissiveIntensity: 0 });
  const slide = mesh(new THREE.BoxGeometry(0.16, 0.26, 0.95), metal.clone()); slide.position.set(0, 0.1, 0.1); slide.userData.gunPart = 'slide'; g.add(slide);
  const barrel = mesh(new THREE.BoxGeometry(0.12, 0.16, 1.05), dark.clone()); barrel.position.set(0, 0.1, 0.15); barrel.userData.gunPart = 'barrel'; g.add(barrel);
  const grip = mesh(new THREE.BoxGeometry(0.15, 0.5, 0.28), dark.clone()); grip.position.set(0, -0.2, -0.28); grip.rotation.x = 0.32; grip.userData.gunPart = 'grip'; g.add(grip);
  const trigger = mesh(new THREE.BoxGeometry(0.1, 0.16, 0.1), dark.clone()); trigger.position.set(0, -0.05, -0.12); trigger.userData.gunPart = 'barrel'; g.add(trigger);
  // glowing accent rails make upgrades visually read like a skin/gradient tier
  for (const sx of [-1, 1]) {
    const rail = mesh(new THREE.BoxGeometry(0.035, 0.05, 0.72), accentMat.clone(), false, false);
    rail.position.set(sx * 0.1, 0.25, 0.12);
    rail.userData.gunPart = 'accent';
    g.add(rail);
  }
  const gripPlate = mesh(new THREE.BoxGeometry(0.17, 0.28, 0.035), accentMat.clone(), false, false);
  gripPlate.position.set(0, -0.18, -0.43);
  gripPlate.rotation.x = 0.32;
  gripPlate.userData.gunPart = 'accent';
  g.add(gripPlate);
  g.scale.setScalar(scale);
  g.children.forEach((m) => (m.castShadow = true));
  return g;
}

// pump shotgun — chunkier and longer than the pistol; uses the same gunPart tags
// so applyGunSkin() recolors it through the shared upgrade-tier palette.
function makeShotgun(scale = 1) {
  const g = new THREE.Group();
  const metal = mat(0x23262b, 0.4);
  const dark = mat(0x14161a, 0.5);
  const accentMat = new THREE.MeshStandardMaterial({ color: 0x555b66, roughness: 0.28, metalness: 0.15, emissive: 0x000000, emissiveIntensity: 0 });
  const recv = mesh(new THREE.BoxGeometry(0.2, 0.3, 0.66), metal.clone()); recv.position.set(0, 0.08, -0.02); recv.userData.gunPart = 'slide'; g.add(recv);
  const barrel = mesh(new THREE.BoxGeometry(0.14, 0.17, 1.5), dark.clone()); barrel.position.set(0, 0.14, 0.72); barrel.userData.gunPart = 'barrel'; g.add(barrel);
  const tube = mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 10), dark.clone()); tube.rotation.x = Math.PI / 2; tube.position.set(0, 0.0, 0.68); tube.userData.gunPart = 'barrel'; g.add(tube);
  // pump fore-grip (accent — slides visually as a tier color)
  const pump = mesh(new THREE.BoxGeometry(0.19, 0.15, 0.32), accentMat.clone(), false, false); pump.position.set(0, 0.0, 0.52); pump.userData.gunPart = 'accent'; g.add(pump);
  // shoulder stock + pistol grip
  const stock = mesh(new THREE.BoxGeometry(0.16, 0.32, 0.5), dark.clone()); stock.position.set(0, -0.04, -0.52); stock.rotation.x = 0.1; stock.userData.gunPart = 'grip'; g.add(stock);
  const grip = mesh(new THREE.BoxGeometry(0.14, 0.32, 0.18), dark.clone()); grip.position.set(0, -0.2, -0.18); grip.rotation.x = 0.34; grip.userData.gunPart = 'grip'; g.add(grip);
  // top rail accent for the upgrade glow
  const rail = mesh(new THREE.BoxGeometry(0.05, 0.05, 1.0), accentMat.clone(), false, false); rail.position.set(0, 0.27, 0.5); rail.userData.gunPart = 'accent'; g.add(rail);
  g.scale.setScalar(scale);
  g.children.forEach((m) => (m.castShadow = true));
  return g;
}

// (the pistol now lives on the weapon-shop counter — see the shop block above)

// --- guns held by the player (hidden until picked up). Both models live in a
// holder and we just toggle visibility on the equipped one, so swapping weapons
// is instant and the muzzle/recoil anchors stay valid. ---
const gunHolder = new THREE.Group();
gunHolder.position.set(0.55, 1.25, 0.5);
gunHolder.visible = false;
player.group.add(gunHolder);
const tpPistol = makePistol(0.85);
const tpShotgun = makeShotgun(0.85);
tpShotgun.visible = false;
gunHolder.add(tpPistol, tpShotgun);
const muzzlePoint = new THREE.Object3D();
muzzlePoint.position.set(0, 0.1, 0.85);
gunHolder.add(muzzlePoint);

// --- first-person viewmodel: a flipper-arm holding the gun (COD style) ---
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
// the guns themselves
const fpPistol = makePistol(0.95);
fpPistol.position.set(0, 0, -0.55);
fpPistol.rotation.y = Math.PI; // point it forward (away from camera)
const fpShotgun = makeShotgun(0.95);
fpShotgun.position.set(0, 0.02, -0.7);
fpShotgun.rotation.y = Math.PI;
fpShotgun.visible = false;
const fpMuzzle = new THREE.Object3D();
fpMuzzle.position.set(0, 0.1, -0.95);
fpViewmodel.add(fpArm, fpHand, fpPistol, fpShotgun, fpMuzzle);
// rest pose in the lower-right of the view
const FP_REST = new THREE.Vector3(0.28, -0.26, -0.5);
fpViewmodel.position.copy(FP_REST);
fpViewmodel.traverse((m) => { if (m.isMesh) { m.renderOrder = 999; m.material.depthTest = true; } });
let fpBob = 0;

// ---------------------------------------------------------------------
//  Weapon registry: each gun keeps its own persistent stats. The classic
//  pistol globals (ammo / MAG_SIZE / gunDamage / …) act as the LIVE mirror of
//  whatever's equipped; switching saves the current globals back to the record
//  and loads the next one's. Adding a gun = adding a registry entry (+ a model).
// ---------------------------------------------------------------------
const WEAPONS = {
  pistol: {
    id: 'pistol', icon: '🔫', name: 'Pistol', tag: 'Reliable semi-auto sidearm',
    cost: 0, maxLevel: GUN_MAX_LEVEL, owned: false, level: 1,
    damage: 1, magSize: 12, reserveMax: 96, ammo: 12, reserve: 36, upgradeCost: 500,
    pellets: 1, spread: 0, fireInterval: 0.25, falloff: { near: 16, far: 60, min: 0.4 },
    ammoPack: 40, ammoBaseCost: 120,
  },
  shotgun: {
    id: 'shotgun', icon: '💥', name: 'Shotgun', tag: 'Close-range spread cannon — devastating up close',
    cost: 1100, maxLevel: GUN_MAX_LEVEL, owned: false, level: 1,
    damage: 5, magSize: 5, reserveMax: 40, ammo: 5, reserve: 20, upgradeCost: 850,
    pellets: 8, spread: 0.12, fireInterval: 0.72, falloff: { near: 7, far: 24, min: 0.14 },
    ammoPack: 16, ammoBaseCost: 220,
  },
};
const WEAPON_ORDER = ['pistol', 'shotgun'];
let equipped = 'pistol';
// firing characteristics of the equipped gun, read by fire()/damageFalloff()
let curPellets = 1;
let curSpread = 0;
let curFalloff = WEAPONS.pistol.falloff;

function activeTPGun() { return equipped === 'shotgun' ? tpShotgun : tpPistol; }
function activeFPGun() { return equipped === 'shotgun' ? fpShotgun : fpPistol; }
function setActiveGunModel(id) {
  tpPistol.visible = id === 'pistol';
  tpShotgun.visible = id === 'shotgun';
  fpPistol.visible = id === 'pistol';
  fpShotgun.visible = id === 'shotgun';
}
// write the live globals back into the equipped weapon's record
function saveEquipped() {
  const w = WEAPONS[equipped];
  w.level = gunLevel; w.damage = gunDamage; w.magSize = MAG_SIZE;
  w.ammo = ammo; w.reserve = ammoReserve; w.reserveMax = RESERVE_MAX; w.upgradeCost = upgradeCost;
}
// load the equipped weapon's record into the live globals + swap visuals/HUD
function loadEquipped() {
  const w = WEAPONS[equipped];
  gunLevel = w.level; gunDamage = w.damage; MAG_SIZE = w.magSize;
  ammo = w.ammo; ammoReserve = w.reserve; RESERVE_MAX = w.reserveMax; upgradeCost = w.upgradeCost;
  hasGun = w.owned;
  curPellets = w.pellets; curSpread = w.spread; curFalloff = w.falloff; FIRE_INTERVAL = w.fireInterval;
  reloading = false; reloadT = 0;
  setActiveGunModel(equipped);
  gunHolder.visible = w.owned;
  applyGunSkin(activeTPGun(), gunLevel);
  applyGunSkin(activeFPGun(), gunLevel);
  updateWeaponHUD();
}
function ensureGunHUD() {
  ammoPill.style.display = '';
  elimPill.style.display = '';
  ui.crosshair.style.borderColor = 'rgba(255,70,70,.95)';
  ui.crosshair.style.boxShadow = '0 0 0 2px rgba(0,0,0,.2), 0 0 10px rgba(255,40,40,.6)';
  updateWeaponHUD();
}
// mark a weapon owned, top it up, equip it and reveal the HUD
function acquireWeapon(w) {
  w.owned = true;
  w.ammo = w.magSize;
  if (w.id === equipped) loadEquipped();
  else equipWeapon(w.id);
  ensureGunHUD();
  // hide the floating pistol pickup once the pistol is owned
  if (w.id === 'pistol' && gunPickupRec) gunPickupRec.obj.visible = false;
}
function equipWeapon(id) {
  const w = WEAPONS[id];
  if (!w || !w.owned || id === equipped) return;
  saveEquipped();
  equipped = id;
  loadEquipped();
  sfx.swap();
  toast(`${w.icon} ${w.name} Mk.${w.level}`);
}
function cycleWeapon() {
  const owned = WEAPON_ORDER.filter((k) => WEAPONS[k].owned);
  if (owned.length < 2) return;
  const i = owned.indexOf(equipped);
  equipWeapon(owned[(i + 1) % owned.length]);
}

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
// hold-to-fire: holding the shoot button auto-fires at a steady COD-like cadence
let firing = false;
let fireCooldown = 0;
let FIRE_INTERVAL = 0.25;     // per-weapon cadence; set by loadEquipped()
// reload timing (frame-driven so the FP animation + crosshair ring can track it)
let reloadT = 0;
const RELOAD_DUR = 0.9;

// reload progress ring drawn around the crosshair (replaces the old toast)
const RELOAD_CIRC = 2 * Math.PI * 16;
const reloadRing = document.createElement('div');
reloadRing.style.cssText = 'position:absolute;left:50%;top:50%;width:46px;height:46px;transform:translate(-50%,-50%);display:none;pointer-events:none';
reloadRing.innerHTML = `<svg width="46" height="46" viewBox="0 0 40 40" style="display:block">
  <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(0,0,0,.35)" stroke-width="3.6"/>
  <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="3"/>
  <circle id="__reload_arc" cx="20" cy="20" r="16" fill="none" stroke="#ffd23f" stroke-width="3.2" stroke-linecap="round"
    transform="rotate(-90 20 20)" stroke-dasharray="${RELOAD_CIRC}" stroke-dashoffset="${RELOAD_CIRC}"/>
</svg>
<div style="position:absolute;left:50%;top:100%;transform:translate(-50%,4px);font:800 9px 'Baloo 2',system-ui,sans-serif;color:#ffd23f;letter-spacing:.14em;text-shadow:0 1px 3px rgba(0,0,0,.85);white-space:nowrap">RELOADING</div>`;
ui.crosshair.appendChild(reloadRing);
const reloadArc = reloadRing.querySelector('#__reload_arc');
function updateReloadIndicator() {
  if (reloading) {
    const pr = clamp(reloadT / RELOAD_DUR, 0, 1);
    reloadArc.setAttribute('stroke-dashoffset', String(RELOAD_CIRC * (1 - pr)));
    reloadRing.style.display = 'block';
  } else if (reloadRing.style.display !== 'none') {
    reloadRing.style.display = 'none';
  }
}

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

const _ray = new THREE.Ray();
const _tmp = new THREE.Vector3();
// damage drop-off uses the equipped weapon's falloff band: full power up close,
// tapering to a floor at range. Shotguns fall off hard; the pistol stays useful.
function damageFalloff(dist) {
  const f = curFalloff;
  if (dist <= f.near) return 1;
  if (dist >= f.far) return f.min;
  const k = (dist - f.near) / (f.far - f.near); // 0→1 across the band
  return 1 - (1 - f.min) * k;
}

// Manual clicks fire immediately; holding uses a separate cooldown so fast
// tapping still rewards the player without turning held fire into a laser.
function requestFire(manual = false) {
  if (manual) {
    fire();
    fireCooldown = FIRE_INTERVAL;
  } else if (fireCooldown <= 0) {
    fireCooldown = FIRE_INTERVAL;
    fire();
  }
}

const _muzzleWorld = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _spreadA = new THREE.Vector3();
const _spreadB = new THREE.Vector3();
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
  const isShotgun = curPellets > 1;
  isShotgun ? sfx.shotgun() : sfx.shot();
  if (ammo === 0 && ammoReserve > 0) reloadGun(); // auto-reload when the mag runs dry
  recoil = isShotgun ? 0.95 : 0.5;
  muzzleTimer = isShotgun ? 0.08 : 0.05;

  const ar = aimRay();
  (firstPerson ? fpMuzzle : muzzlePoint).getWorldPosition(_muzzleWorld);
  muzzleFlash.position.copy(_muzzleWorld);
  muzzleFlash.scale.set(isShotgun ? 1.7 : 1.1, isShotgun ? 1.7 : 1.1, 1);
  muzzleFlash.visible = true;

  // build two axes perpendicular to the aim so each pellet scatters in a cone
  _aimDir.copy(ar.direction).normalize();
  _spreadA.set(0, 1, 0).cross(_aimDir);
  if (_spreadA.lengthSq() < 1e-4) _spreadA.set(1, 0, 0);
  _spreadA.normalize();
  _spreadB.copy(_aimDir).cross(_spreadA).normalize();

  const isClient = netRole() === 'client';
  // shotgun blasts spray a lot of blood; trim per-pellet bursts so it stays snappy
  const bloodPer = isShotgun ? 5 : 22;
  let headshotShown = false;
  for (let p = 0; p < curPellets; p++) {
    const dir = _aimDir.clone();
    if (curSpread > 0) {
      // gaussian-ish scatter biased toward center, mostly within the cone
      const a = (Math.random() + Math.random() - 1) * curSpread;
      const b = (Math.random() + Math.random() - 1) * curSpread;
      dir.addScaledVector(_spreadA, a).addScaledVector(_spreadB, b).normalize();
    }
    headshotShown = firePellet(ar.origin, dir, isClient, bloodPer, !headshotShown) || headshotShown;
  }
}

// one hitscan ray: find the nearest enemy it strikes, apply damage + FX + tracer.
// returns true if a headshot floattext was shown (so multi-pellet shots show one).
function firePellet(origin, dir, isClient, bloodPer, allowHsText) {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);
  const wallDist = raySolidDist(_ray, 120);
  let best = null, bestAlong = Infinity, bestCenter = null, bestScale = 1, bestType = '', bestNid = 0;
  if (isClient) {
    for (const [nid, g] of ghosts) {
      if (g.dead || g.predDead) continue;
      const p = g.pen.group.position;
      const s = g.scale || 1;
      const center = _tmp.set(p.x, p.y + 1.2 * s, p.z);
      const along = _ray.direction.dot(center.clone().sub(_ray.origin));
      if (along < 0.5 || along > 120 || along > wallDist) continue;
      const onRay = _ray.at(along, new THREE.Vector3());
      if (onRay.distanceTo(center) < 1.45 * s && along < bestAlong) {
        best = g; bestAlong = along; bestCenter = center.clone(); bestScale = s; bestType = g.type; bestNid = nid;
      }
    }
  } else {
    for (const npc of npcs) {
      if (npc.dead) continue;
      const s = npc.scale || 1;
      const center = _tmp.set(npc.group.position.x, npc.group.position.y + 1.2 * s, npc.group.position.z);
      const along = _ray.direction.dot(center.clone().sub(_ray.origin));
      if (along < 0.5 || along > 120 || along > wallDist) continue;
      const onRay = _ray.at(along, new THREE.Vector3());
      if (onRay.distanceTo(center) < 1.45 * s && along < bestAlong) {
        best = npc; bestAlong = along; bestCenter = center.clone(); bestScale = s; bestType = npc.type; bestNid = npc.netId;
      }
    }
  }

  let shownHs = false;
  let endPoint;
  if (best) {
    endPoint = bestCenter;
    const onRay = _ray.at(bestAlong, new THREE.Vector3());
    const groupY = best.group ? best.group.position.y : best.pen.group.position.y;
    const headshot = bestType !== 'boss' && onRay.y >= groupY + 1.7 * bestScale;
    const dmg = gunDamage * (headshot ? 2 : 1) * damageFalloff(bestAlong);
    if (isClient) {
      hitOut.push({ hid: ++localHitId, nid: bestNid, dmg, hs: headshot });
      if (hitOut.length > 48) hitOut.shift();
      predictGhostHit(best, dmg);
      spawnBloodBurst(bestCenter.clone(), _ray.direction.clone(), bloodPer);
      showHitMarker(false);
      sfx.hit();
      if (headshot && allowHsText) { floatText('HEADSHOT', bestCenter.clone(), '#ffd23f', 18); shownHs = true; }
    } else {
      damageNPC(best, dmg, bestCenter.clone(), headshot, mpMyId(), _ray.direction.clone());
      if (headshot && allowHsText) shownHs = true;
    }
  } else {
    endPoint = _ray.at(Math.min(wallDist, 80), new THREE.Vector3());
  }
  spawnTracer(_muzzleWorld, endPoint);
  return shownHs;
}

function reloadGun() {
  if (reloading || ammo === MAG_SIZE) return;
  if (ammoReserve <= 0) { sfx.dryFire(); toast('Out of ammo! Grab some from the fallen.'); return; }
  reloading = true;
  reloadT = 0;
  const reloadWpn = equipped;     // if they swap guns mid-reload, abandon this one
  updateWeaponHUD();
  sfx.reload();
  setTimeout(() => {
    if (!reloading || equipped !== reloadWpn) return;   // swapped or already resolved
    const need = MAG_SIZE - ammo;
    const take = Math.min(need, ammoReserve);
    ammo += take;
    ammoReserve -= take;
    reloading = false;
    updateWeaponHUD();
  }, RELOAD_DUR * 1000);
}

function spawnTracer(a, b) {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xfff2a8, transparent: true, opacity: 0.9 }));
  world.add(line);
  tracers.push({ line, life: 0 });
}

function spawnBloodBurst(point, dir = null, count = 22) {
  for (let i = 0; i < count; i++) {
    const r = 0.05 + Math.random() * 0.1;
    const b = mesh(new THREE.SphereGeometry(r, 6, 6), new THREE.MeshStandardMaterial({ color: 0x9e0606, roughness: 0.6 }), false, false);
    b.position.copy(point);
    const v = new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 6 + 1, (Math.random() - 0.5) * 7);
    world.add(b);
    bloodBits.push({ mesh: b, vel: v, life: 0 });
  }
  // throw splatter onto nearby walls/props in the direction the shot travelled
  splatBloodOnWorld(point, dir);
}

function spawnBloodPool(x, z) {
  const size = 1.4 + Math.random() * 1.2;
  const pool = mesh(new THREE.CircleGeometry(size, 20), new THREE.MeshBasicMaterial({ map: bloodTex, transparent: true, opacity: 0, depthWrite: false }), false, false);
  pool.rotation.x = -Math.PI / 2;
  pool.rotation.z = Math.random() * Math.PI * 2;
  pool.position.set(x, groundHeightAt(x, z, 0) + 0.05, z);
  world.add(pool);
  bloodPools.push({ mesh: pool, grow: 0 });
  // cap the number of pools to keep things performant
  if (bloodPools.length > 36) {
    const old = bloodPools.shift();
    world.remove(old.mesh);
  }
}

// --- world-reactive blood decals: wall splatter + walking blood trails -------
// Generic surface-aligned splat that fades away over its lifetime, so blood
// lands on whatever it hits (walls, props, terrain) and clutter self-cleans.
const bloodDecals = [];
const UP_V = new THREE.Vector3(0, 1, 0);
const _decalFrom = new THREE.Vector3(0, 0, 1);
const _decalN = new THREE.Vector3();
function addBloodDecal(pos, normal, size, ttl, maxOp = 0.85) {
  const m = mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshBasicMaterial({
      map: bloodTex, transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    }),
    false, false,
  );
  m.position.copy(pos).addScaledVector(normal, 0.03);    // float just off the surface
  m.quaternion.setFromUnitVectors(_decalFrom, _decalN.copy(normal).normalize());
  m.rotateOnAxis(_decalFrom, Math.random() * Math.PI * 2);   // random roll around the normal
  world.add(m);
  bloodDecals.push({ mesh: m, life: 0, ttl, fadeIn: 0.12, maxOp });
  if (bloodDecals.length > 90) {
    const o = bloodDecals.shift();
    world.remove(o.mesh); o.mesh.geometry.dispose();
  }
  return m;
}

// spray rays out from an impact point; wherever they strike a solid object, stamp
// an oriented splat on that surface. Biased along `dir` (the shot direction) when
// provided so blood throws the way the bullet was travelling.
const _splatRay = new THREE.Raycaster();
const _splatDir = new THREE.Vector3();
function splatBloodOnWorld(point, dir) {
  if (!solidRoots.length) return;
  for (let i = 0; i < 4; i++) {
    let dx, dz;
    if (dir) {
      const a = Math.atan2(dir.x, dir.z) + (Math.random() - 0.5) * 1.5;
      dx = Math.sin(a); dz = Math.cos(a);
    } else {
      const a = Math.random() * Math.PI * 2; dx = Math.sin(a); dz = Math.cos(a);
    }
    _splatDir.set(dx, (Math.random() - 0.65) * 0.5, dz).normalize();
    _splatRay.set(point, _splatDir);
    _splatRay.far = 3.6;
    const hits = _splatRay.intersectObjects(solidRoots, true);
    if (!hits.length) continue;
    const h = hits[0];
    const n = h.face ? _decalN.copy(h.face.normal).transformDirection(h.object.matrixWorld).clone() : UP_V.clone();
    addBloodDecal(h.point, n, 0.7 + Math.random() * 1.1, 13 + Math.random() * 9, 0.78);
  }
}

// drip a blood trail from a wounded penguin as it walks (host npcs + client
// ghosts both call this; bleeding is derived from replicated HP so it matches)
const _dripPos = new THREE.Vector3();
function bleedTrail(ent, grp, hp, maxHp, dt, active) {
  const frac = hp / Math.max(1, maxHp);
  if (!active || frac >= 0.55) { ent._lx = grp.position.x; ent._lz = grp.position.z; return; }
  const lx = ent._lx ?? grp.position.x, lz = ent._lz ?? grp.position.z;
  ent._dripDist = (ent._dripDist || 0) + Math.hypot(grp.position.x - lx, grp.position.z - lz);
  ent._lx = grp.position.x; ent._lz = grp.position.z;
  if (ent._dripDist < 1.1) return;
  ent._dripDist = 0;
  const sev = clamp((0.55 - frac) / 0.55, 0, 1);          // worse wound -> bigger, darker drip
  const gx = grp.position.x + (Math.random() - 0.5) * 0.3;
  const gz = grp.position.z + (Math.random() - 0.5) * 0.3;
  _dripPos.set(gx, groundHeightAt(gx, gz, 0) + 0.04, gz);
  addBloodDecal(_dripPos, UP_V, 0.3 + sev * 0.45, 11 + Math.random() * 8, 0.45 + sev * 0.4);
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
const FREEZE_TIME = 5;      // seconds locked in place
const FREEZE_DPS = 3;       // damage per second while frozen
let frozenTimer = 0;
let freezeHurtTick = 0;
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
  freezeHurtTick = 0;          // first damage tick lands immediately
  velocity.set(0, 0, 0);
  playerIce.visible = true;
  frostOverlay.style.opacity = '1';
  sfx.freeze();
  toast('🧊 Frozen solid! The cold is killing you!');
}

// ---------------------------------------------------------------------
//  Siren screech: disorients the player (woozy overlay + camera roll wobble
//  + slowed movement) and enrages nearby zombies. The disorient is a per-
//  machine effect (each player feels their own), so it stays multiplayer-safe.
// ---------------------------------------------------------------------
const DISORIENT_TIME = 3.2;     // seconds of woozy vision
const DISORIENT_SLOW = 0.55;    // movement speed multiplier while reeling
const ENRAGE_TIME = 5.0;        // seconds nearby zombies stay enraged
const ENRAGE_MULT = 1.55;       // speed multiplier for enraged zombies
const SCREECH_RANGE = 17;       // trigger distance
const SCREECH_RADIUS = 14;      // effect radius of the shockwave
const SCREECH_DMG = 8;          // chip damage when the blast connects
const SCREECH_KNOCK = 17;       // horizontal shove strength
const SCREECH_LIFT = 6.5;       // upward pop
let disorientT = 0;
let disorientRoll = 0;          // current camera roll offset (read by updateCamera)
const knockVel = new THREE.Vector3();   // external shove impulse, decays in move()

// boss ground pound
const POUND_RANGE = 9;          // how close the player must be to trigger a slam
const POUND_RADIUS = 10;        // shockwave radius
const POUND_WINDUP = 0.7;       // tell duration
const POUND_DMG = 18;
const STUN_TIME = 1.6;          // seconds the player is rooted
let stunnedT = 0;

const dizzyOverlay = document.createElement('div');
dizzyOverlay.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;mix-blend-mode:screen;background:radial-gradient(120% 120% at 50% 50%, rgba(220,90,200,.05) 20%, rgba(180,40,170,.4) 70%, rgba(120,10,120,.7));transition:opacity .15s';
document.body.appendChild(dizzyOverlay);

function disorientPlayer(intensity = 1) {
  if (gameOver || spectating || !started) return;
  disorientT = Math.max(disorientT, DISORIENT_TIME * intensity);
  toast('💫 Your head is spinning!');
}
// shove the player away from a point and pop them up a little (shockwave feel)
function knockbackPlayer(ox, oz, strength = SCREECH_KNOCK, lift = SCREECH_LIFT) {
  if (gameOver || spectating || !started) return;
  let dx = player.group.position.x - ox, dz = player.group.position.z - oz;
  const l = Math.hypot(dx, dz) || 1;
  knockVel.set((dx / l) * strength, 0, (dz / l) * strength);
  velY = Math.max(velY, lift);
  onGround = false;
}
// full local effect of a screech catching the player: shove + pop + dizzy + chip dmg
function screechHitLocalPlayer(ox, oz) {
  knockbackPlayer(ox, oz);
  disorientPlayer(1);
  damagePlayer(SCREECH_DMG);
}
// boss ground pound caught the local player: rooted in place + heavy chip damage
function stunPlayer(dur) {
  if (gameOver || spectating || !started) return;
  stunnedT = Math.max(stunnedT, dur);
  disorientT = Math.max(disorientT, dur);   // reuse the woozy screen/camera wobble
  toast('💥 Stunned!');
}
function groundPoundHitLocalPlayer() {
  stunPlayer(STUN_TIME);
  damagePlayer(POUND_DMG);
}
function updateDisorient(dt, t) {
  if (gameOver || spectating || !started) disorientT = 0;
  if (disorientT > 0) disorientT = Math.max(0, disorientT - dt);
  const k = clamp(disorientT / DISORIENT_TIME, 0, 1);
  // woozy screen pulse + a rolling camera tilt that eases off as it wears away
  dizzyOverlay.style.opacity = (k * (0.55 + 0.25 * Math.sin(t * 6))).toFixed(3);
  disorientRoll = k * 0.13 * Math.sin(t * 4.5);
}

// expanding shockwave ring VFX, stamped at a screech origin
const screechRings = [];
function spawnScreechRing(x, y, z, color = 0xff5ad0) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.5, 1.1, 40),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(x, y + 0.15, z);
  world.add(ring);
  screechRings.push({ mesh: ring, life: 0 });
}
function updateScreechRings(dt) {
  for (let i = screechRings.length - 1; i >= 0; i--) {
    const r = screechRings[i];
    r.life += dt;
    const s = 1 + r.life * 26;                 // races outward to ~screech radius
    r.mesh.scale.set(s, s, s);
    r.mesh.material.opacity = Math.max(0, 0.8 - r.life * 1.1);
    if (r.life > 0.75) { world.remove(r.mesh); r.mesh.geometry.dispose(); screechRings.splice(i, 1); }
  }
}

// enrage every living zombie within range of a screech (host authority).
// A red emissive tint + faster movement makes the buff readable and dangerous.
function enrageNearbyZombies(x, z, radius) {
  for (const n of npcs) {
    if (n.dead || !n.isZombie || n.type === 'boss') continue;
    if (Math.hypot(n.group.position.x - x, n.group.position.z - z) <= radius) n.enrageT = ENRAGE_TIME;
  }
}
// red glow that marks an enraged penguin (works for host npcs + client ghosts)
function setEnrageTint(pen, on) {
  const v = on ? 0.55 : 0;
  for (const part of [pen.parts.body, pen.parts.head]) {
    if (!part || !part.material || !part.material.emissive) continue;
    part.material.emissive.setHex(0xff2a2a);
    part.material.emissiveIntensity = v;
  }
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
    if (b.m.position.y <= groundHeightAt(b.m.position.x, b.m.position.z, 0) + 0.12 || b.life > 4) {
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
  group.position.set(x, groundHeightAt(x, z, 0), z);   // sit on the terrain, not buried at y=0
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
      group.position.set(x, groundHeightAt(x, z, 0), z);
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

// =====================================================================
//  Toxic gas clouds — a dying gas-mask penguin bursts into a cloud that
//  lingers on the map and poisons any player inside it. Host-authoritative
//  and replicated to clients like ice craters; each machine poisons only its
//  own local player, so it stays multiplayer-correct.
// =====================================================================
const GAS_LIFE = 13;        // seconds the cloud lingers
const GAS_R = 3.3;          // damage radius
const GAS_TICK = 6;         // damage per tick
const GAS_TICK_T = 0.8;     // seconds between ticks (~7.5 dps)
const gasClouds = [];
let nextGasId = 1;

const gasOverlay = document.createElement('div');
gasOverlay.style.cssText = 'position:fixed;inset:0;z-index:8;pointer-events:none;opacity:0;background:radial-gradient(120% 120% at 50% 60%, rgba(150,210,90,.05) 25%, rgba(95,175,55,.34) 74%, rgba(55,120,35,.6));transition:opacity .2s';
document.body.appendChild(gasOverlay);

function makeGasMesh() {
  const g = new THREE.Group();
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + Math.random();
    const r = GAS_R * (0.18 + Math.random() * 0.6);
    const m = new THREE.MeshStandardMaterial({ color: 0x86c25a, emissive: 0x3f6a26, emissiveIntensity: 0.3, transparent: true, opacity: 0.3, roughness: 1, depthWrite: false });
    const puff = mesh(new THREE.SphereGeometry(0.9 + Math.random() * 0.8, 12, 10), m, false, false);
    puff.position.set(Math.cos(a) * r, 0.5 + Math.random() * 1.0, Math.sin(a) * r);
    puff.userData.bob = Math.random() * 6;
    g.add(puff);
  }
  return g;
}
function setGasOpacity(group, o) {
  group.traverse((c) => { if (c.material) c.material.opacity = 0.3 * o; });
}
function animateGas(group, dt, t) {
  group.rotation.y += dt * 0.25;
  for (const c of group.children) {
    if (c.userData.bob != null) c.position.y += Math.sin(t * 1.4 + c.userData.bob) * dt * 0.25;
  }
}
function gasFade(life) {
  return life < 0.6 ? life / 0.6 : life > GAS_LIFE - 1.5 ? Math.max(0, (GAS_LIFE - life) / 1.5) : 1;
}
function spawnGasCloud(x, z) {
  const group = makeGasMesh();
  group.position.set(x, groundHeightAt(x, z, 0) + 0.1, z);
  world.add(group);
  gasClouds.push({ id: nextGasId++, x, z, group, life: 0 });
  sfx.gas();
}

// shared poison tick: chips the local player while they stand in any gas
let gasHurtTick = 0;
function tickGasDamage(inside, dt) {
  if (inside && started && !gameOver && !spectating) {
    gasOverlay.style.opacity = '1';
    gasHurtTick -= dt;
    if (gasHurtTick <= 0) { gasHurtTick = GAS_TICK_T; damagePlayer(GAS_TICK); }
  } else {
    gasOverlay.style.opacity = '0';
    gasHurtTick = 0;     // first tick lands immediately on re-entry
  }
}
function playerInGasList(list) {
  const p = player.group.position;
  for (const c of list) {
    if (c.life != null && gasFade(c.life) <= 0.2) continue;   // not yet thick / dissipating
    if (Math.hypot(p.x - c.x, p.z - c.z) < GAS_R) return true;
  }
  return false;
}
// HOST/SOLO: age + animate clouds and poison the local player
function updateGasClouds(dt, t) {
  for (let i = gasClouds.length - 1; i >= 0; i--) {
    const c = gasClouds[i];
    c.life += dt;
    animateGas(c.group, dt, t);
    setGasOpacity(c.group, gasFade(c.life));
    if (c.life >= GAS_LIFE) { world.remove(c.group); gasClouds.splice(i, 1); }
  }
  tickGasDamage(playerInGasList(gasClouds), dt);
}
// CLIENT: mirror the host's clouds and poison ourselves if we stand in one
const ghostGas = new Map();   // id -> { group, x, z }
function clientGas(dt, t) {
  const arr = getGlobal('gas') || [];
  const seen = new Set();
  for (const e of arr) {
    const [id, x, z] = e;
    seen.add(id);
    let gg = ghostGas.get(id);
    if (!gg) {
      const group = makeGasMesh();
      group.position.set(x, groundHeightAt(x, z, 0) + 0.1, z);
      world.add(group);
      gg = { group, x, z };
      ghostGas.set(id, gg);
    }
    animateGas(gg.group, dt, t);
  }
  for (const [id, gg] of ghostGas) {
    if (!seen.has(id)) { world.remove(gg.group); ghostGas.delete(id); }
  }
  tickGasDamage(playerInGasList([...ghostGas.values()]), dt);
}

function updateWeapons(dt) {
  // the pistol pickup spins/bobs via its Spin + Bob components now
  // hold-to-fire: keep firing at a steady cadence while the button is held
  fireCooldown = Math.max(0, fireCooldown - dt);
  if (reloading) reloadT += dt;
  if (firing && hasGun && started && !gameOver && !spectating) requestFire();

  // recoil + muzzle flash
  recoil = Math.max(0, recoil - dt * 4);
  gunHolder.rotation.x = -recoil;

  // first-person viewmodel: show only when zoomed in & armed (never while spectating)
  fpViewmodel.visible = firstPerson && hasGun && !spectating;
  if (fpViewmodel.visible) {
    if (reloading) {
      // reload animation: dip the gun down + roll it as if seating a fresh mag
      const pr = clamp(reloadT / RELOAD_DUR, 0, 1);
      const dip = Math.sin(pr * Math.PI);            // 0 → 1 → 0 over the reload
      fpViewmodel.position.set(FP_REST.x + 0.06 * dip, FP_REST.y - 0.24 * dip, FP_REST.z + 0.05 * dip);
      fpViewmodel.rotation.x = 0.8 * dip;
      fpViewmodel.rotation.z = -0.55 * dip;
    } else {
      const bobAmt = moving && onGround ? 1 : 0;
      fpBob += dt * (moving ? 10 : 4);
      const bx = Math.cos(fpBob) * 0.012 * bobAmt;
      const by = Math.abs(Math.sin(fpBob)) * 0.02 * bobAmt;
      fpViewmodel.position.set(FP_REST.x + bx, FP_REST.y + by - recoil * 0.05, FP_REST.z + recoil * 0.12);
      fpViewmodel.rotation.x = recoil * 0.5;
      fpViewmodel.rotation.z = 0;
    }
  }
  updateReloadIndicator();
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
  // blood droplets with gravity; when they land they leave a small ground mark
  for (let i = bloodBits.length - 1; i >= 0; i--) {
    const b = bloodBits[i];
    b.life += dt;
    b.vel.y -= 20 * dt;
    b.mesh.position.addScaledVector(b.vel, dt);
    const gy = groundHeightAt(b.mesh.position.x, b.mesh.position.z, 0) + 0.05;
    if (b.mesh.position.y < gy) {
      if (!b.landed) {                 // stamp a small splat where the drop hit
        b.landed = true;
        if (Math.random() < 0.5) addBloodDecal(b.mesh.position.clone().setY(gy), UP_V, 0.25 + Math.random() * 0.35, 10 + Math.random() * 8, 0.6);
      }
      b.mesh.position.y = gy;
      b.vel.set(0, 0, 0);
    }
    if (b.life > 2.5) { world.remove(b.mesh); bloodBits.splice(i, 1); }
  }
  // blood pools fade in
  for (const bp of bloodPools) {
    if (bp.grow < 1) { bp.grow = Math.min(1, bp.grow + dt * 3); bp.mesh.material.opacity = bp.grow * 0.92; }
  }
  // surface-aligned blood decals fade in, hold, then fade out + retire
  for (let i = bloodDecals.length - 1; i >= 0; i--) {
    const d = bloodDecals[i];
    d.life += dt;
    let op;
    if (d.life < d.fadeIn) op = (d.life / d.fadeIn) * d.maxOp;
    else op = d.maxOp * Math.max(0, 1 - (d.life - d.fadeIn) / (d.ttl - d.fadeIn));
    d.mesh.material.opacity = op;
    if (d.life >= d.ttl) { world.remove(d.mesh); d.mesh.geometry.dispose(); bloodDecals.splice(i, 1); }
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

// movement speed: running is the default — hold Shift to walk instead
const RUN_SPEED = 9;
const WALK_SPEED = 5;
// candy-bar sugar rush: a short, snappy speed boost when collected
const SPEED_BOOST_MULT = 1.55;
const SPEED_BOOST_DUR = 8;
let speedBoostT = 0;
function grantSpeedBoost() {
  speedBoostT = SPEED_BOOST_DUR;
  sfx.chomp();
  updateBoostHUD();
}

// jump / vertical physics
let velY = 0;
let onGround = true;
const GRAVITY = 32;
const JUMP_SPEED = 11.5;
const STEP_UP = 0.7;     // max ledge height you can step / climb onto (curbs, slopes)
const STEP_DOWN = 0.7;   // max drop you stay glued to the surface for (walking downhill)
const STEP_SMOOTH = 16;  // how fast the body eases onto a new ground height (bigger = snappier)
const MAX_SLOPE_DEG = 50;                                  // steepest surface you can ascend
const COS_MAX_SLOPE = Math.cos(MAX_SLOPE_DEG * Math.PI / 180);
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
    if (disorientRoll) camera.rotateZ(disorientRoll);   // woozy tilt while disoriented
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
    if (solidContains(s, desiredPos.x, desiredPos.z) && desiredPos.y < 6) {
      desiredPos.copy(target).add(offset.multiplyScalar(0.55));
      break;
    }
  }
  // never let the camera dip below the snow
  desiredPos.y = Math.max(desiredPos.y, 0.9);
  camera.position.lerp(desiredPos, 1 - Math.exp(-18 * lastDt));
  camera.lookAt(target);
  if (disorientRoll) camera.rotateZ(disorientRoll);   // woozy tilt while disoriented
}
// A collider only counts as a wall for an entity standing at feet height `fy`
// if its top rises more than a step above the feet (otherwise you step onto it)
// and its base is below head height (otherwise it's an overhang you walk under).
const ENTITY_HEIGHT = 1.8;
function blocksAt(s, fy) {
  if (s.top != null && s.top - fy <= STEP_UP) return false;       // low ledge → step over
  if (s.base != null && s.base - fy >= ENTITY_HEIGHT) return false; // overhead → walk under
  return true;
}
// point-in-collider test, supporting both box (hx/hz) and round (r) colliders.
// Round colliders are used for circular objects (snowman, snow giant) so they
// don't block in the empty corners a square box would.
function solidContains(s, x, z) {
  if (s.r != null) { const dx = x - s.x, dz = z - s.z; return dx * dx + dz * dz < s.r * s.r; }
  return Math.abs(x - s.x) < s.hx && Math.abs(z - s.z) < s.hz;
}

function collides(pos, ignoreBoundary = false) {
  // zombies ignore the outer wall so they can pour in from beyond the map edge
  if (!ignoreBoundary && Math.hypot(pos.x, pos.z) > 105) return true;
  const fy = pos.y || 0;
  for (const s of solid) {
    if (solidContains(s, pos.x, pos.z) && blocksAt(s, fy)) return true;
  }
  return false;
}

// True if a point is already overlapping a solid (used so NPCs can wiggle free
// instead of freezing permanently when they end up inside a collider).
function insideSolid(pos) {
  const fy = pos.y || 0;
  for (const s of solid) {
    if (solidContains(s, pos.x, pos.z) && blocksAt(s, fy)) return true;
  }
  return false;
}

// Player movement collision (one axis at a time). Blocks entering a solid from
// outside, but if you're already overlapping one (e.g. a collider was just
// enabled on top of you, or you spawned in it) it lets you move OUTWARD so you
// can always slide free — no permanent stuck-in-place.
function moveBlocked(from, to) {
  if (Math.hypot(to.x, to.z) > 105) return true; // outer map wall
  const fy = from.y || 0;
  for (const s of solid) {
    if (!blocksAt(s, fy)) continue;               // walkable ledge / overhead → not a wall
    if (!solidContains(s, to.x, to.z)) continue;
    if (!solidContains(s, from.x, from.z)) return true;   // crossing in from outside → wall
    // already inside: only block motion that pushes us deeper (toward the centre)
    if (s.r != null) {
      const dTo = (to.x - s.x) ** 2 + (to.z - s.z) ** 2;
      const dFrom = (from.x - s.x) ** 2 + (from.z - s.z) ** 2;
      if (dTo < dFrom - 1e-6) return true;
    } else {
      if (Math.abs(to.x - s.x) < Math.abs(from.x - s.x) - 1e-6) return true;
      if (Math.abs(to.z - s.z) < Math.abs(from.z - s.z) - 1e-6) return true;
    }
  }
  return false;
}

// ---- walkable surfaces: raycast straight down to find the ground height under
// a point so the player walks ON TOP of terrain (hill, dock, plaza, paths…)
// following the actual mesh, instead of floating on a flat y=0 plane.
const walkRoots = [];
const _downRay = new THREE.Raycaster();
const _downOrigin = new THREE.Vector3();
const _downDir = new THREE.Vector3(0, -1, 0);
const _nrmMat = new THREE.Matrix3();
const _nrm = new THREE.Vector3();
const _probe = { y: 0, normY: 1, hit: false };
// Cast straight down onto the walkable meshes and report the surface height plus
// how flat it is (normY = vertical component of the surface normal, 1 = flat,
// lower = steeper). Used for ground-following AND the max-slope limit.
function probeGround(x, z) {
  _probe.y = 0; _probe.normY = 1; _probe.hit = false;
  if (!walkRoots.length) return _probe;
  _downOrigin.set(x, 80, z);
  _downRay.set(_downOrigin, _downDir);
  _downRay.far = 200;
  const hits = _downRay.intersectObjects(walkRoots, true);
  if (!hits.length) return _probe;
  const h = hits[0];                                // nearest from above = highest surface
  _probe.y = h.point.y; _probe.hit = true;
  if (h.face) {
    _nrmMat.getNormalMatrix(h.object.matrixWorld);
    _nrm.copy(h.face.normal).applyMatrix3(_nrmMat).normalize();
    _probe.normY = Math.abs(_nrm.y);
  }
  return _probe;
}
function groundHeightAt(x, z, fallback = 0) {
  const g = probeGround(x, z);
  return g.hit ? g.y : fallback;
}

// ---- line-of-sight: the meshes of solid collision objects (walls, buildings,
// the shop, snowmen, etc.) used to block both gunfire and on-screen health bars
// so you can't shoot or see enemies through cover.
const solidRoots = [];
const _losRay = new THREE.Raycaster();
const _losDir = new THREE.Vector3();
const _hbTmp = new THREE.Vector3();
// nearest solid hit distance along a ray (Infinity if the shot is clear)
function raySolidDist(ray, maxDist) {
  if (!solidRoots.length) return Infinity;
  _losRay.set(ray.origin, ray.direction);
  _losRay.far = maxDist;
  const hits = _losRay.intersectObjects(solidRoots, true);
  return hits.length ? hits[0].distance : Infinity;
}
// true if a wall sits on the straight segment between two world points
function segmentBlocked(from, to) {
  if (!solidRoots.length) return false;
  _losDir.subVectors(to, from);
  const dist = _losDir.length();
  if (dist < 1e-3) return false;
  _losDir.multiplyScalar(1 / dist);
  _losRay.set(from, _losDir);
  _losRay.far = dist - 0.4;   // small bias so the target's own body doesn't count
  return _losRay.intersectObjects(solidRoots, true).length > 0;
}

// =====================================================================
//  NPC navigation grid — A* so zombies route AROUND buildings/obstacles
//  (a real path) while their local steering still handles fine, dynamic
//  avoidance (other penguins, jitter). Rebuilt only when the level
//  changes, so it's a cheap static occupancy grid.
// =====================================================================
const nav = { cell: 2.5, minX: -112, minZ: -112, cols: 0, rows: 0, blocked: null, R: 0.9 };
let _navG = null, _navCame = null, _navGen = null, _navGenId = 0;
let _navHeapI = null, _navHeapF = null, _navHeapSize = 0;
const NAV_DC = [1, -1, 0, 0, 1, 1, -1, -1];
const NAV_DR = [0, 0, 1, -1, 1, -1, 1, -1];
const SQRT2 = 1.4142135623730951;

function buildNavGrid() {
  nav.cols = Math.ceil((-nav.minX * 2) / nav.cell);
  nav.rows = nav.cols;
  const N = nav.cols * nav.rows;
  if (!nav.blocked || nav.blocked.length !== N) {
    nav.blocked = new Uint8Array(N);
    _navG = new Float32Array(N);
    _navCame = new Int32Array(N);
    _navGen = new Int32Array(N);
    _navHeapI = new Int32Array(N * 8 + 16);   // lazy-duplicate binary heap
    _navHeapF = new Float32Array(N * 8 + 16);
  }
  nav.blocked.fill(0);
  for (let r = 0; r < nav.rows; r++) {
    const cz = nav.minZ + (r + 0.5) * nav.cell;
    for (let c = 0; c < nav.cols; c++) {
      const cx = nav.minX + (c + 0.5) * nav.cell;
      for (const s of solid) {
        if (!blocksAt(s, 0)) continue;        // only ground-level walls block routing
        const hit = s.r != null
          ? ((cx - s.x) ** 2 + (cz - s.z) ** 2) < (s.r + nav.R) ** 2
          : (Math.abs(cx - s.x) < s.hx + nav.R && Math.abs(cz - s.z) < s.hz + nav.R);
        if (hit) { nav.blocked[r * nav.cols + c] = 1; break; }
      }
    }
  }
}
function navCellBlocked(c, r) {
  return c < 0 || r < 0 || c >= nav.cols || r >= nav.rows || nav.blocked[r * nav.cols + c] === 1;
}
// no blocked cell crosses the straight segment (for path smoothing + shortcuts)
function navClearLine(x0, z0, x1, z1) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (nav.cell * 0.5)));
  for (let i = 1; i < steps; i++) {
    const tt = i / steps;
    const c = Math.floor((x0 + (x1 - x0) * tt - nav.minX) / nav.cell);
    const r = Math.floor((z0 + (z1 - z0) * tt - nav.minZ) / nav.cell);
    if (navCellBlocked(c, r)) return false;
  }
  return true;
}
// like navClearLine, but also requires clearance to either side so a zombie
// won't try to thread a diagonal gap too narrow for its body (which is what made
// it abandon its A* route and grind on building corners). Used only for the
// "skip the path and beeline the player" decision.
function navClearWide(x0, z0, x1, z1) {
  if (!navClearLine(x0, z0, x1, z1)) return false;
  let px = z1 - z0, pz = -(x1 - x0);
  const pl = Math.hypot(px, pz) || 1; px = (px / pl) * 1.0; pz = (pz / pl) * 1.0;
  return navClearLine(x0 + px, z0 + pz, x1 + px, z1 + pz)
      && navClearLine(x0 - px, z0 - pz, x1 - px, z1 - pz);
}
function navNearestFree(c, r) {
  if (!navCellBlocked(c, r)) return c + r * nav.cols;
  for (let rad = 1; rad <= 8; rad++) {
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;  // ring only
      const nc = c + dc, nr = r + dr;
      if (!navCellBlocked(nc, nr)) return nc + nr * nav.cols;
    }
  }
  return -1;
}
function octile(c0, r0, c1, r1) {
  const dx = Math.abs(c0 - c1), dy = Math.abs(r0 - r1);
  return (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
}
function navHeapPush(idx, f) {
  let i = ++_navHeapSize;
  _navHeapI[i] = idx; _navHeapF[i] = f;
  while (i > 1) {
    const p = i >> 1;
    if (_navHeapF[p] <= _navHeapF[i]) break;
    const ti = _navHeapI[p]; _navHeapI[p] = _navHeapI[i]; _navHeapI[i] = ti;
    const tf = _navHeapF[p]; _navHeapF[p] = _navHeapF[i]; _navHeapF[i] = tf;
    i = p;
  }
}
function navHeapPop() {
  const top = _navHeapI[1];
  _navHeapI[1] = _navHeapI[_navHeapSize]; _navHeapF[1] = _navHeapF[_navHeapSize];
  _navHeapSize--;
  let i = 1;
  while (true) {
    let s = i; const l = i * 2, r = i * 2 + 1;
    if (l <= _navHeapSize && _navHeapF[l] < _navHeapF[s]) s = l;
    if (r <= _navHeapSize && _navHeapF[r] < _navHeapF[s]) s = r;
    if (s === i) break;
    const ti = _navHeapI[s]; _navHeapI[s] = _navHeapI[i]; _navHeapI[i] = ti;
    const tf = _navHeapF[s]; _navHeapF[s] = _navHeapF[i]; _navHeapF[i] = tf;
    i = s;
  }
  return top;
}
// A* on the occupancy grid. Returns smoothed world-space waypoints, or null if
// no route is found within the node budget (caller falls back to direct steer).
function navFindPath(sx, sz, tx, tz, maxNodes = 2600) {
  if (!nav.blocked) return null;
  const cols = nav.cols;
  let sc = clamp(Math.floor((sx - nav.minX) / nav.cell), 0, cols - 1);
  let sr = clamp(Math.floor((sz - nav.minZ) / nav.cell), 0, nav.rows - 1);
  let tc = clamp(Math.floor((tx - nav.minX) / nav.cell), 0, cols - 1);
  let tr = clamp(Math.floor((tz - nav.minZ) / nav.cell), 0, nav.rows - 1);
  let startI = sr * cols + sc, goalI = tr * cols + tc;
  if (navCellBlocked(tc, tr)) {
    const f = navNearestFree(tc, tr); if (f < 0) return null;
    goalI = f; tc = f % cols; tr = (f - tc) / cols;
  }
  if (navCellBlocked(sc, sr)) {
    const f = navNearestFree(sc, sr);
    if (f >= 0) { startI = f; sc = f % cols; sr = (f - sc) / cols; }
  }
  if (startI === goalI) return [{ x: tx, z: tz }];
  const gen = ++_navGenId;
  _navHeapSize = 0;
  _navGen[startI] = gen; _navG[startI] = 0; _navCame[startI] = -1;
  navHeapPush(startI, octile(sc, sr, tc, tr));
  let found = false, nodes = 0;
  while (_navHeapSize > 0 && nodes < maxNodes) {
    const cur = navHeapPop();
    if (cur === goalI) { found = true; break; }
    if (_navGen[cur] === gen && _navG[cur] === Infinity) continue;
    nodes++;
    const cc = cur % cols, cr = (cur - cc) / cols;
    const gc = _navG[cur];
    for (let k = 0; k < 8; k++) {
      const dc = NAV_DC[k], dr = NAV_DR[k];
      const nc = cc + dc, nr = cr + dr;
      if (navCellBlocked(nc, nr)) continue;
      if (dc !== 0 && dr !== 0 && (navCellBlocked(cc + dc, cr) || navCellBlocked(cc, cr + dr))) continue;
      const ni = nr * cols + nc;
      const ng = gc + (dc !== 0 && dr !== 0 ? SQRT2 : 1);
      if (_navGen[ni] !== gen || ng < _navG[ni]) {
        _navGen[ni] = gen; _navG[ni] = ng; _navCame[ni] = cur;
        navHeapPush(ni, ng + octile(nc, nr, tc, tr));
      }
    }
  }
  if (!found) return null;
  const cells = [];
  let p = goalI;
  while (p !== -1) { cells.push(p); if (p === startI) break; p = _navCame[p]; }
  cells.reverse();
  const pts = [];
  for (const ci of cells) {
    const c = ci % cols, r = (ci - c) / cols;
    pts.push({ x: nav.minX + (c + 0.5) * nav.cell, z: nav.minZ + (r + 0.5) * nav.cell });
  }
  pts.push({ x: tx, z: tz });
  return navSmooth(pts);
}
// string-pulling: drop intermediate waypoints we have clear line-of-sight past,
// so paths become straight diagonals instead of blocky grid steps
function navSmooth(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    for (; j > i + 1; j--) if (navClearLine(pts[i].x, pts[i].z, pts[j].x, pts[j].z)) break;
    out.push(pts[j]); i = j;
  }
  return out;
}
// pick where a chasing zombie should aim THIS frame: straight at the target if
// it has line-of-sight, otherwise the next waypoint of its A* route (recomputed
// on a short, jittered cooldown so the herd doesn't all solve on the same frame)
function npcSteerTarget(npc, pos, tgt, dt) {
  if (navClearWide(pos.x, pos.z, tgt.x, tgt.z)) { npc.path = null; npc.turnBias = 0; return tgt; }
  npc.pathCD = (npc.pathCD ?? 0) - dt;
  if (!npc.path || npc.pathI >= npc.path.length || npc.pathCD <= 0) {
    npc.pathCD = 0.35 + Math.random() * 0.4;
    npc.path = navFindPath(pos.x, pos.z, tgt.x, tgt.z);
    npc.pathI = 0;
  }
  const path = npc.path;
  if (!path || !path.length) return tgt;
  while (npc.pathI < path.length - 1) {
    const wp = path[npc.pathI];
    if (Math.hypot(pos.x - wp.x, pos.z - wp.z) < nav.cell) npc.pathI++;
    else break;
  }
  return path[Math.min(npc.pathI, path.length - 1)];
}

// COD-style crowd spacing: a steering vector pushing this zombie away from any
// others that are crowding its personal bubble, so the horde packs in close but
// doesn't stack on the exact same spot. Returns a (capped) world-space x/z nudge.
const _sep = { x: 0, z: 0 };
function npcSeparation(npc, pos) {
  let sx = 0, sz = 0;
  const myR = 0.75 * npc.scale;
  for (const o of npcs) {
    if (o === npc || o.dead || o.flying || o.state !== 'chase') continue;
    const dx = pos.x - o.group.position.x;
    const dz = pos.z - o.group.position.z;
    const want = myR + 0.75 * o.scale + 0.35;        // desired centre-to-centre gap
    const d2 = dx * dx + dz * dz;
    if (d2 >= want * want || d2 < 1e-5) continue;
    const d = Math.sqrt(d2);
    const w = (want - d) / want;                      // stronger the more they overlap
    sx += (dx / d) * w; sz += (dz / d) * w;
  }
  const l = Math.hypot(sx, sz);
  if (l > 1.3) { sx = sx / l * 1.3; sz = sz / l * 1.3; }
  _sep.x = sx; _sep.z = sz;
  return _sep;
}

// =====================================================================
//  Brute "roll charge"
// ---------------------------------------------------------------------
//  The big penguins occasionally plant their feet, wind up with a squash-and-
//  lean tell, then barrel-roll in a LOCKED straight line — only stopping when
//  they smash a wall, bowl the player over, or run out of steam. Returns true
//  while a charge is active, so the caller skips its normal chase steering.
// =====================================================================
const ROLL_SPEED = 18;
function rollHud(npc, pos) {
  npc.hb.sprite.position.set(pos.x, pos.y + 3.0 + npc.scale * 1.0, pos.z);
  npc.hb.sprite.visible = !segmentBlocked(camera.position, _hbTmp.set(pos.x, pos.y + 1.3 * npc.scale, pos.z));
}
function handleBruteRoll(npc, pos, tgt, distP, distLocal, reach, dt, t) {
  const rs = npc.rollState || 'none';
  const baseS = npc.scale;

  if (rs === 'none') {
    // launch a wind-up when off cooldown, grounded, at a chargeable range, with
    // a clear straight lane to the player (so it actually has room to barrel in)
    if (npc.onGround && (npc.rollCD ?? 0) <= 0 && distP > 6 && distP < 30 &&
        navClearWide(pos.x, pos.z, tgt.x, tgt.z)) {
      npc.rollState = 'windup';
      npc.rollTimer = 0.6;
      npc.moving = false;
      sfx.groan();
      broadcastChat(npc.group, 'RRRAAAH!', 3.0 + baseS * 1.15, npc.netId);
    }
    return false;
  }

  if (rs === 'windup') {
    npc.moving = false;
    npc.rollTimer -= dt;
    // keep tracking the player while coiling, lock the heading at launch
    npc.heading = Math.atan2(tgt.x - pos.x, tgt.z - pos.z);
    npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-14 * dt));
    const k = clamp(1 - npc.rollTimer / 0.6, 0, 1);     // 0 -> 1 across the windup
    const squash = Math.sin(k * Math.PI) * 0.28;        // bulge low, peaks mid-windup
    npc.group.scale.set(baseS * (1 + squash * 0.6), baseS * (1 - squash), baseS * (1 + squash * 0.6));
    npc.group.rotation.x = -0.35 * k;                   // rock back, coiling the spring
    npc.group.rotation.z = 0;
    if (npc.rollTimer <= 0) {
      npc.rollState = 'rolling';
      npc.rollTimer = 1.6;                              // hard time cap
      npc.rollDist = 0;
      npc.rollDir = { x: Math.sin(npc.heading), z: Math.cos(npc.heading) };
      npc.rollHit = false;
      npc.rollSpin = 0;
      npc.group.scale.setScalar(baseS);
      sfx.land();
    }
    npcGroundVertical(npc, dt);
    rollHud(npc, pos);
    return true;
  }

  if (rs === 'rolling') {
    npc.rollTimer -= dt;
    npc.moving = true;
    const step = ROLL_SPEED * dt;
    const look = 0.6 + baseS * 0.5;
    const probe = pos.clone();
    probe.x += npc.rollDir.x * look; probe.z += npc.rollDir.z * look;
    const hitWall = collides(probe, true);              // a solid wall straight ahead
    if (!hitWall) { pos.x += npc.rollDir.x * step; pos.z += npc.rollDir.z * step; npc.rollDist += step; }
    // somersault forward along the travel direction (local pitch under YXZ)
    npc.rollSpin += dt * 16;
    npc.group.rotation.y = npc.heading;
    npc.group.rotation.x = npc.rollSpin;
    npc.group.rotation.z = 0;
    // bowl the local player over (once per charge)
    if (!npc.rollHit && distLocal < reach + 0.7) {
      damagePlayer(16 + baseS * 5);
      npc.rollHit = true;
    }
    if (hitWall || npc.rollTimer <= 0 || npc.rollDist > 32 || npc.rollHit) {
      npc.rollState = 'recover';
      npc.rollTimer = hitWall ? 0.95 : 0.5;             // longer daze after eating a wall
      if (hitWall) sfx.land();
    }
    npcGroundVertical(npc, dt);
    rollHud(npc, pos);
    return true;
  }

  if (rs === 'recover') {
    npc.moving = false;
    npc.rollTimer -= dt;
    // ease the tumble to a stop landing upright, with a dizzy side wobble
    const upright = Math.round(npc.group.rotation.x / (Math.PI * 2)) * (Math.PI * 2);
    npc.group.rotation.x = THREE.MathUtils.lerp(npc.group.rotation.x, upright, 1 - Math.exp(-8 * dt));
    npc.group.rotation.z = Math.sin(t * 20) * 0.12 * clamp(npc.rollTimer / 0.95, 0, 1);
    npc.group.rotation.y = npc.heading;
    if (npc.rollTimer <= 0) {
      npc.rollState = 'none';
      npc.rollCD = 5 + Math.random() * 4;               // breather before the next charge
      npc.group.rotation.x = 0; npc.group.rotation.z = 0;
      npc.group.scale.setScalar(baseS);
    }
    npcGroundVertical(npc, dt);
    rollHud(npc, pos);
    return true;
  }
  return false;
}

// Siren screech: rear back during a wind-up, then unleash a shockwave that
// disorients the player and enrages the surrounding horde. Owns the siren's
// movement only during the wind-up (returns true); otherwise she chases normally.
const SCREECH_WINDUP = 0.75;
function handleSirenScreech(npc, pos, tgt, distP, dt, t) {
  const ss = npc.screechState || 'none';
  const baseS = npc.scale;
  if (ss === 'none') {
    npc.screechCD = (npc.screechCD ?? (3.5 + Math.random() * 3)) - dt;
    if (npc.onGround !== false && npc.screechCD <= 0 && distP < SCREECH_RANGE) {
      npc.screechState = 'windup';
      npc.screechTimer = SCREECH_WINDUP;
      npc.screeching = true;
      npc.moving = false;
      sfx.groan();
      broadcastChat(npc.group, 'AAAIEEE!', 3.2 + baseS * 1.1, npc.netId);
    }
    return false;
  }
  if (ss === 'windup') {
    npc.moving = false;
    npc.screechTimer -= dt;
    npc.heading = Math.atan2(tgt.x - pos.x, tgt.z - pos.z);
    npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-12 * dt));
    const k = clamp(1 - npc.screechTimer / SCREECH_WINDUP, 0, 1);
    const puff = Math.sin(k * Math.PI) * 0.16;              // chest swells as the scream builds
    npc.group.scale.set(baseS * (1 + puff), baseS * (1 + puff * 1.4), baseS * (1 + puff));
    npc.group.rotation.x = -0.2 * k;                        // rear back
    if (npc.screechTimer <= 0) {
      fireScreech(npc, pos);
      npc.screechState = 'none';
      npc.screechCD = 7 + Math.random() * 4;
      npc.screeching = false;
      npc.group.scale.setScalar(baseS);
      npc.group.rotation.x = 0;
    }
    npcGroundVertical(npc, dt);
    return true;
  }
  return false;
}
function fireScreech(npc, pos) {
  sfx.screech();
  spawnScreechRing(pos.x, groundHeightAt(pos.x, pos.z, 0), pos.z);
  // each machine hits its OWN player if inside the blast (host applies to itself
  // here; clients replay this from the screech feed): shove + pop + dizzy + dmg
  if (Math.hypot(player.group.position.x - pos.x, player.group.position.z - pos.z) <= SCREECH_RADIUS) {
    screechHitLocalPlayer(pos.x, pos.z);
  }
  enrageNearbyZombies(pos.x, pos.z, SCREECH_RADIUS);
  if (netRole() === 'host') {
    screechFeed.push({ seq: ++screechSeq, x: Math.round(pos.x * 10) / 10, z: Math.round(pos.z * 10) / 10, r: SCREECH_RADIUS });
    if (screechFeed.length > 8) screechFeed.shift();
  }
}

// Boss ground pound: when the player presses in close, the boss rears up and
// slams the ground, sending out a shockwave that stuns + hurts anyone nearby.
// Owns the boss only during the wind-up/slam (returns true); otherwise it keeps
// raining ice and chasing as usual.
function handleBossPound(npc, pos, tgt, distP, dt, t) {
  const ps = npc.poundState || 'none';
  const baseS = npc.scale;
  if (ps === 'none') {
    npc.poundCD = (npc.poundCD ?? (4 + Math.random() * 3)) - dt;
    if (npc.onGround !== false && npc.poundCD <= 0 && distP < POUND_RANGE) {
      npc.poundState = 'windup';
      npc.poundTimer = POUND_WINDUP;
      npc.pounding = true;
      npc.moving = false;
      sfx.groan();
      broadcastChat(npc.group, 'STOMP!', 4.6, npc.netId);
    }
    return false;
  }
  if (ps === 'windup') {
    npc.moving = false;
    npc.poundTimer -= dt;
    npc.heading = Math.atan2(tgt.x - pos.x, tgt.z - pos.z);
    npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-10 * dt));
    const k = clamp(1 - npc.poundTimer / POUND_WINDUP, 0, 1);
    npc.group.scale.set(baseS * (1 + 0.12 * k), baseS * (1 + 0.3 * k), baseS * (1 + 0.12 * k));   // rear up tall
    npc.group.rotation.x = -0.3 * k;
    if (npc.poundTimer <= 0) {
      fireBossPound(npc, pos);
      npc.poundState = 'recover';
      npc.poundTimer = 0.5;
      npc.pounding = false;
    }
    npcGroundVertical(npc, dt);
    return true;
  }
  if (ps === 'recover') {
    npc.moving = false;
    npc.poundTimer -= dt;
    const kk = clamp(npc.poundTimer / 0.5, 0, 1);
    npc.group.scale.set(baseS * (1 + 0.3 * kk), baseS * (1 - 0.2 * kk), baseS * (1 + 0.3 * kk));   // slam squash → ease back
    if (npc.poundTimer <= 0) {
      npc.poundState = 'none';
      npc.poundCD = 6 + Math.random() * 4;
      npc.group.scale.setScalar(baseS);
      npc.group.rotation.x = 0;
    }
    npcGroundVertical(npc, dt);
    return true;
  }
  return false;
}
function fireBossPound(npc, pos) {
  sfx.land();
  sfx.groan();
  spawnScreechRing(pos.x, groundHeightAt(pos.x, pos.z, 0), pos.z, 0xffd9a0);
  // each machine stuns its OWN player if inside the slam (host here; clients via feed)
  if (Math.hypot(player.group.position.x - pos.x, player.group.position.z - pos.z) <= POUND_RADIUS) {
    groundPoundHitLocalPlayer();
  }
  if (netRole() === 'host') {
    poundFeed.push({ seq: ++poundSeq, x: Math.round(pos.x * 10) / 10, z: Math.round(pos.z * 10) / 10, r: POUND_RADIUS });
    if (poundFeed.length > 8) poundFeed.shift();
  }
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
  if (shopOpen) return;   // free OS cursor for the storefront screen
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
  if (editorActive || shopOpen) return;
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
  if (editorActive || shopOpen) return;   // clicks belong to the storefront screen
  if (!started) return;
  sfx.resume();
  const onCanvas = e.target === renderer.domElement;
  // safety net: if we're in first-person without a mouse lock (e.g. just stepped
  // out of the shop), this click re-captures it so look resumes immediately.
  if (firstPerson && onCanvas && !dragging && !document.pointerLockElement) {
    document.body.requestPointerLock();
  }
  if (e.button === 2 && onCanvas) {
    // right button: begin camera orbit (reticle snaps to center while looking)
    dragging = true;
    mouseNDC.set(0, 0);
    ui.crosshair.style.left = '50%';
    ui.crosshair.style.top = '50%';
    document.body.requestPointerLock();
  } else if (e.button === 0 && (onCanvas || dragging || firstPerson)) {
    // left button: shoot / throw toward the reticle (center in first-person)
    // holding the button keeps auto-firing the pistol at a steady cadence
    if (hasGun) { firing = true; requestFire(true); }
    else throwSnowball();
  }
});
document.addEventListener('mouseup', (e) => {
  if (editorActive) { firing = false; return; }
  if (e.button === 0) firing = false;
  if (e.button === 2 && dragging) {
    dragging = false;
    if (document.pointerLockElement) document.exitPointerLock();
  }
});
// safety: stop auto-firing if the window loses focus
window.addEventListener('blur', () => { firing = false; });
document.addEventListener('keydown', (e) => {
  if (editorActive) return;
  keys.add(e.code);
  if (!started) return;
  if (e.code === 'Space') e.preventDefault();
  if (e.code === 'KeyR' && hasGun) reloadGun();
  if (e.code === 'KeyQ') cycleWeapon();
  if (e.code === 'KeyE') tryInteractGameObjects();
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

  // tick down the candy speed boost
  if (speedBoostT > 0) { speedBoostT = Math.max(0, speedBoostT - dt); updateBoostHUD(); }

  // ---- frozen in place (boss ice crater) — locked for 5s, taking 5 dmg/sec ----
  if (frozenTimer > 0) {
    frozenTimer = Math.max(0, frozenTimer - dt);
    velocity.set(0, 0, 0);
    knockVel.set(0, 0, 0);
    moving = false;
    velY -= GRAVITY * dt;
    let fy = player.group.position.y + velY * dt;
    const gy = groundHeightAt(player.group.position.x, player.group.position.z, 0);
    if (fy <= gy) { fy = gy; velY = 0; onGround = true; }
    player.group.position.y = fy;
    // tick damage once per second while frozen
    freezeHurtTick -= dt;
    if (freezeHurtTick <= 0) {
      freezeHurtTick += 1;
      damagePlayer(FREEZE_DPS);
      if (gameOver || spectating) return;   // the cold finished us off
    }
    if (frozenTimer === 0) { playerIce.visible = false; frostOverlay.style.opacity = '0'; }
    return;
  }

  // ---- stunned (boss ground pound) — rooted but no DoT; gravity still applies ----
  if (stunnedT > 0) {
    stunnedT = Math.max(0, stunnedT - dt);
    velocity.set(0, 0, 0);
    knockVel.set(0, 0, 0);
    moving = false;
    velY -= GRAVITY * dt;
    let fy = player.group.position.y + velY * dt;
    const gy = groundHeightAt(player.group.position.x, player.group.position.z, 0);
    if (fy <= gy) { fy = gy; velY = 0; onGround = true; }
    player.group.position.y = fy;
    return;
  }

  // ---- vertical physics (jump + gravity) ----
  // Ground height is resolved AFTER the horizontal move below, so the player
  // follows whatever surface they walk onto (hill, dock, …) like a Unity
  // character controller, instead of floating on a flat y=0 plane.
  if (keys.has('Space') && onGround) {
    velY = JUMP_SPEED;
    onGround = false;
    sfx.jump();
  }
  velY -= GRAVITY * dt;
  player.group.position.y += velY * dt;

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
    const walking = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const boost = speedBoostT > 0 ? SPEED_BOOST_MULT : 1;
    const woozy = disorientT > 0 ? DISORIENT_SLOW : 1;   // siren screech slows you
    const speed = (walking ? WALK_SPEED : RUN_SPEED) * boost * woozy;
    velocity.lerp(desired.multiplyScalar(speed), 1 - Math.exp(-12 * dt));
    const targetYaw = Math.atan2(velocity.x, velocity.z);
    player.group.rotation.y = lerpAngle(player.group.rotation.y, targetYaw, 1 - Math.exp(-12 * dt));
  }
  // apply horizontal velocity every frame so momentum carries while airborne.
  // moveBlocked() allows escaping a box you're already overlapping (so you can
  // never get permanently frozen inside a collider) while still walling you out.
  const cur = player.group.position;
  // A move onto a walkable surface is rejected if that surface is steeper than
  // the slope limit AND rises more than a step above us — i.e. it's a wall/cliff
  // you can't ascend (you can still walk along or down it). Small steps within
  // STEP_UP are always allowed, matching a Unity character controller.
  const blockedBySlope = (x, z) => {
    const g = probeGround(x, z);
    return g.hit && g.normY < COS_MAX_SLOPE && (g.y - cur.y) > STEP_UP;
  };
  // combine input velocity with any external knockback impulse (siren shockwave),
  // then bleed the impulse off so the shove is a quick burst, not permanent drift
  const vx = velocity.x + knockVel.x, vz = velocity.z + knockVel.z;
  const tryX = cur.clone(); tryX.x += vx * dt;
  if (!moveBlocked(cur, tryX) && !blockedBySlope(tryX.x, cur.z)) cur.x = tryX.x;
  const tryZ = cur.clone(); tryZ.z += vz * dt;
  if (!moveBlocked(cur, tryZ) && !blockedBySlope(cur.x, tryZ.z)) cur.z = tryZ.z;
  knockVel.multiplyScalar(Math.exp(-6 * dt));

  // ---- ground following with smooth step/slope easing ----
  // The body eases toward the surface height instead of teleporting, so small
  // steps and slope changes feel smooth rather than a hard snap. Crisp landings
  // are preserved because gravity carries us down until we're within a step.
  const groundY = groundHeightAt(cur.x, cur.z, 0);
  if (velY > 0 && cur.y > groundY) {
    onGround = false;                             // rising through a jump
  } else if (cur.y - groundY > STEP_DOWN) {
    onGround = false;                             // well above ground → falling
  } else {
    onGround = true; velY = 0;                    // standing on / stepping onto the surface
    const k = 1 - Math.exp(-STEP_SMOOTH * dt);
    cur.y += (groundY - cur.y) * k;
    if (Math.abs(groundY - cur.y) < 0.015) cur.y = groundY;
  }
  if (onGround && wasAir) sfx.land();
  wasAir = !onGround;

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
  const roll = Math.sin(phase) * 0.1 * speed;
  pen.group.rotation.z = roll;
  // counter-roll the head so it stays roughly level — without this the whole
  // body tips to one side each step and the waddle reads as lopsided/limping
  if (pen.parts.head) pen.parts.head.rotation.z = -roll * 0.55;
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
  firing = false;
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
  // if we respawn still zoomed into first-person, recapture the mouse so look
  // works immediately (a click also re-grabs it as a fallback).
  if (camDist <= FP_DIST && !document.pointerLockElement) {
    const r = document.body.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  }
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

  // holder with both gun models; we toggle the one matching their equipped weapon
  const gunHolderR = new THREE.Group();
  gunHolderR.position.set(0.55, 1.25, 0.5);
  gunHolderR.visible = false;
  const rPistol = makePistol(0.85);
  const rShotgun = makeShotgun(0.85);
  rShotgun.visible = false;
  applyGunSkin(rPistol, s.gl ?? 1);
  applyGunSkin(rShotgun, s.gl ?? 1);
  gunHolderR.add(rPistol, rShotgun);
  const rMuzzle = new THREE.Object3D();   // barrel tip, for tracers + flash origin
  rMuzzle.position.set(0, 0.1, 0.95);
  gunHolderR.add(rMuzzle);
  pen.group.add(gunHolderR);

  // each remote gets its own muzzle-flash sprite so their shots read at a distance
  const rFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  rFlash.scale.set(1.1, 1.1, 1);
  rFlash.visible = false;
  world.add(rFlash);

  rp = {
    pen, tag, gunHolder: gunHolderR, rPistol, rShotgun, gun: rPistol, muzzle: rMuzzle,
    flash: rFlash, flashT: 0, recoil: 0, reloading: false, gunBaseY: 1.25,
    wpn: 'pistol', gunLevel: s.gl ?? 1, phase: 0, lastFire: s.fireSeq || 0, lastEmote: s.emoteSeq || 0,
    color, name: s.name, down: false,
  };
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
  if (rp.flash) world.remove(rp.flash);
  remotePlayers.delete(id);
}

// replay a remote player's shot for observers: tracer(s) + a kick + muzzle flash,
// so other clients' guns visibly recoil and flash instead of silently teleporting
// bullets. Shotguns spray a few spread tracers to sell the blast.
function remoteFire(rp) {
  const muzzle = new THREE.Vector3();
  (rp.muzzle || rp.gun).getWorldPosition(muzzle);
  const ry = rp.pen.group.rotation.y;
  const p = rp.lookPitch || 0;
  const cp = Math.cos(p);
  const baseDir = new THREE.Vector3(Math.sin(ry) * cp, -Math.sin(p), Math.cos(ry) * cp);
  const shotgun = rp.wpn === 'shotgun';
  const shots = shotgun ? 5 : 1;
  for (let i = 0; i < shots; i++) {
    const dir = baseDir.clone();
    if (shotgun) {
      dir.x += (Math.random() - 0.5) * 0.2;
      dir.y += (Math.random() - 0.5) * 0.13;
      dir.z += (Math.random() - 0.5) * 0.2;
      dir.normalize();
    }
    spawnTracer(muzzle, muzzle.clone().add(dir.multiplyScalar(70)));
  }
  rp.recoil = shotgun ? 0.95 : 0.5;
  rp.flash.position.copy(muzzle);
  rp.flash.scale.set(shotgun ? 1.7 : 1.1, shotgun ? 1.7 : 1.1, 1);
  rp.flash.visible = true;
  rp.flashT = shotgun ? 0.08 : 0.05;
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
    gl: gunLevel,
    wpn: equipped,
    rl: reloading,
    down: spectating,
    frozen: frozenTimer > 0,
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
    const remoteGunLevel = s.gl ?? 1;
    if (remoteGunLevel !== rp.gunLevel) {
      rp.gunLevel = remoteGunLevel;
      applyGunSkin(rp.rPistol, remoteGunLevel);
      applyGunSkin(rp.rShotgun, remoteGunLevel);
    }
    const remoteWpn = s.wpn === 'shotgun' ? 'shotgun' : 'pistol';
    if (remoteWpn !== rp.wpn) {
      rp.wpn = remoteWpn;
      rp.rPistol.visible = remoteWpn === 'pistol';
      rp.rShotgun.visible = remoteWpn === 'shotgun';
      rp.gun = remoteWpn === 'shotgun' ? rp.rShotgun : rp.rPistol;
    }
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
    rp.gunHolder.visible = !!s.hasGun && !rp.down;

    if (s.fireSeq && s.fireSeq !== rp.lastFire) {
      rp.lastFire = s.fireSeq;
      remoteFire(rp);
    }
    if (s.emoteSeq && s.emoteSeq !== rp.lastEmote) {
      rp.lastEmote = s.emoteSeq;
      showEmote(g, s.emote || '👋', 3.0);
    }

    // gun kick + reload dip + fading muzzle flash — replicated so teammates and
    // the host actually SEE this player's weapon recoil and reload, not just a tracer
    rp.recoil = Math.max(0, (rp.recoil || 0) - dt * 4);
    const reloadingNow = !!s.rl && !!s.hasGun && !rp.down;
    if (reloadingNow) {
      const kk = 1 - Math.exp(-10 * dt);
      rp.gunHolder.rotation.x = THREE.MathUtils.lerp(rp.gunHolder.rotation.x, 0.7, kk);
      rp.gunHolder.position.y = THREE.MathUtils.lerp(rp.gunHolder.position.y, rp.gunBaseY - 0.22, kk);
    } else {
      rp.gunHolder.rotation.x = -rp.recoil;
      rp.gunHolder.position.y = THREE.MathUtils.lerp(rp.gunHolder.position.y, rp.gunBaseY, 1 - Math.exp(-14 * dt));
    }
    if (rp.flashT > 0) {
      rp.flashT -= dt;
      rp.flash.material.rotation = Math.random() * Math.PI;
      if (rp.flashT <= 0) rp.flash.visible = false;
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
const TYPE_LIST = ['shambler', 'runner', 'brute', 'bomber', 'spitter', 'boss', 'peaceful', 'siren', 'gasser'];
const TYPE_IDX = Object.fromEntries(TYPE_LIST.map((t, i) => [t, i]));
const CONTACT_DMG = { shambler: 7, runner: 5, brute: 14, spitter: 6, boss: 22, bomber: 0, peaceful: 0, siren: 6, gasser: 7 };

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

// is the player nearest to (x,z) — the boss's ice target — currently frozen?
// (each machine reports its own frozen flag, so this holds in multiplayer too)
function nearestPlayerFrozen(x, z) {
  let bd = Infinity, frozen = false, found = false;
  if (!spectating) { bd = (player.group.position.x - x) ** 2 + (player.group.position.z - z) ** 2; frozen = frozenTimer > 0; found = true; }
  if (mpActive()) {
    eachRemote((id, s) => {
      if (s.x == null || s.down) return;
      const d = (s.x - x) ** 2 + (s.z - z) ** 2;
      if (d < bd) { bd = d; frozen = !!s.frozen; found = true; }
    });
  }
  return found && frozen;
}

// ---------- HOST: serialize + broadcast the world ----------
let bannerSeq = 0;
let bannerText = '';
const killFeed = [];
let killSeq = 0;
const chatFeed = [];        // zombie taunts → mirrored to every client
let chatSeq = 0;
const screechFeed = [];     // siren screeches → each client rings + disorients itself
let screechSeq = 0;
const poundFeed = [];       // boss ground pounds → each client rings + stuns itself
let poundSeq = 0;
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
    // brute roll-charge phase rides along in bits 3-4 so clients can render the
    // wind-up squash + tumbling roll and apply the heavy charge hit themselves
    const rollCode = n.rollState === 'windup' ? 1 : n.rollState === 'rolling' ? 2 : n.rollState === 'recover' ? 3 : 0;
    arr.push([
      n.netId,
      Math.round(n.group.position.x * 100) / 100,
      Math.round(n.group.position.z * 100) / 100,
      Math.round(n.group.rotation.y * 100) / 100,
      TYPE_IDX[n.isZombie ? n.type : 'peaceful'] ?? 0,
      Math.max(0, Math.ceil(n.hp)),
      n.maxHp,
      Math.round(n.scale * 100) / 100,
      (n.dead ? 1 : 0) | (n.moving ? 2 : 0) | (n.isZombie ? 4 : 0) | (rollCode << 3) |
        (n.screeching ? 32 : 0) | (n.enrageT > 0 ? 64 : 0) | (n.pounding ? 128 : 0),
      n.color,
      Math.round(n.group.position.y * 100) / 100,   // vertical pos so ghosts climb terrain too
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
  setGlobal('candy', candyDrops.map((c) => [c.id, Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10]));
  setGlobal('kf', killFeed);
  setGlobal('cf', chatFeed);
  setGlobal('scr', screechFeed);
  setGlobal('pound', poundFeed);
  setGlobal('craters', iceCraters.map((c) => [c.id, Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10, craterArmed(c.life) ? 1 : 0]));
  setGlobal('gas', gasClouds.map((c) => [c.id, Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10]));
  setGlobal('env', { tod: Math.round(dayTime * 1000) / 1000, wx: Math.round(weatherCur * 100) / 100 });
}

// ---------- HOST: process incoming client inputs ----------
const clientHitDone = new Map();   // pid -> highest hit id already applied
const clientPickSeq = new Map();
function hostReadInputs() {
  eachRemoteState('hx', (pid, data) => {
    if (!data || !data.hits) return;
    let lastHid = clientHitDone.get(pid) || 0;
    let maxHid = lastHid;
    for (const h of data.hits) {
      const hid = h.hid || 0;
      if (hid <= lastHid) continue;        // already applied this exact shot
      if (hid > maxHid) maxHid = hid;
      const n = npcByNet(h.nid);
      if (n && !n.dead) {
        const pt = new THREE.Vector3(n.group.position.x, n.group.position.y + 1.2, n.group.position.z);
        damageNPC(n, h.dmg, pt, h.hs, pid);
      }
    }
    clientHitDone.set(pid, maxHid);
  });
  eachRemoteState('pkq', (pid, data) => {
    const last = clientPickSeq.get(pid) || 0;
    if (!data || data.seq <= last) return;
    clientPickSeq.set(pid, data.seq);
    for (const req of data.reqs) {
      if (req.kind === 'med') removeMedById(req.id);
      else if (req.kind === 'candy') removeCandyById(req.id);
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
  const g = {
    pen, hb, type, scale, color, dead: false, deathT: 0, phase: Math.random() * 6,
    atkCD: 0, contactDmg: CONTACT_DMG[type] ?? 7, zombie,
    // --- client-side prediction state ---
    hostHp: 1, maxHp: 1, prevHp: null, predDmg: 0, predDead: false, predAge: 0, fxSpawned: false,
    snapX: 0, snapZ: 0, snapT: 0, vx: 0, vz: 0,
  };
  ghosts.set(nid, g);
  return g;
}

// CLIENT PREDICTION: a connecting player owns its own shots. Rather than wait a
// full round-trip for the host to confirm damage, we subtract predicted damage
// from the ghost immediately and down it on the spot when our shots would kill
// it. clientReconcile then folds in the host's authoritative HP so the two stay
// in lock-step (and a mis-prediction self-heals if the host disagrees).
function predictGhostHit(g, dmg) {
  if (!g || g.dead || g.predDead) return;
  g.predDmg += dmg;
  if (g.hostHp - g.predDmg <= 0) predictGhostDeath(g);
}
function predictGhostDeath(g) {
  if (g.predDead || g.dead) return;
  g.predDead = true;
  g.predAge = 0;
  g.hb.sprite.visible = false;
  if (!g.fxSpawned) {
    const grp = g.pen.group;
    spawnBloodBurst(new THREE.Vector3(grp.position.x, grp.position.y + 1.0, grp.position.z));
    spawnBloodPool(grp.position.x, grp.position.z);
    g.fxSpawned = true;
  }
}
function clientReconcile(dt, t) {
  const arr = getGlobal('z') || [];
  const seen = new Set();
  for (const e of arr) {
    const [nid, x, z, ry, ti, hp, maxHp, scale, flags, color, y = 0] = e;
    seen.add(nid);
    const dead = !!(flags & 1), mv = !!(flags & 2), zombie = !!(flags & 4);
    const rollCode = (flags >> 3) & 3;   // 0 none, 1 windup, 2 rolling, 3 recover
    const screeching = !!(flags & 32), enraged = !!(flags & 64), pounding = !!(flags & 128);
    const type = TYPE_LIST[ti] || 'shambler';
    let g = ghosts.get(nid);
    const justCreated = !g;
    if (!g) g = createGhost(nid, type, scale, color, zombie);
    // keep live attributes in sync — peaceful townsfolk become zombies mid-game
    g.zombie = zombie;
    g.type = type;
    g.contactDmg = CONTACT_DMG[type] ?? 7;
    const grp = g.pen.group;

    // ---- reconcile predicted HP with the host's authoritative value ----
    g.maxHp = maxHp;
    // every point of damage the host confirms shrinks our pending prediction so
    // the two never double-count (host + this client + other clients all stack)
    if (g.prevHp != null && hp < g.prevHp) g.predDmg = Math.max(0, g.predDmg - (g.prevHp - hp));
    g.prevHp = hp;
    g.hostHp = hp;
    const dispHp = Math.max(0, hp - g.predDmg);
    const downed = g.dead || g.predDead;

    // ---- dead-reckoning: extrapolate toward where the host says it's heading
    // so fast movers sit on their true position instead of trailing the snapshot
    if (justCreated) { g.snapX = x; g.snapZ = z; g.snapT = t; g.vx = 0; g.vz = 0; }
    else if (x !== g.snapX || z !== g.snapZ) {
      const dts = Math.max(0.02, t - g.snapT);
      g.vx = clamp((x - g.snapX) / dts, -9, 9);
      g.vz = clamp((z - g.snapZ) / dts, -9, 9);
      g.snapX = x; g.snapZ = z; g.snapT = t;
    }
    const lead = downed ? 0 : 0.05;
    const k = justCreated ? 1 : 1 - Math.exp(-14 * dt);
    grp.position.x += (x + g.vx * lead - grp.position.x) * k;
    grp.position.z += (z + g.vz * lead - grp.position.z) * k;
    grp.position.y += (y - grp.position.y) * k;   // follow terrain height (mounds, hills, jumps)
    grp.rotation.y = lerpAngle(grp.rotation.y, ry, k);

    if (dead && justCreated) { g.dead = true; g.deathT = 1; }  // arrived already dead — no FX
    else if (dead && !g.dead) {
      // host confirmed the kill — clear any prediction and play death FX once
      g.dead = true; g.deathT = g.predDead ? 0.0001 : 0; g.predDead = false;
      g.hb.sprite.visible = false;
      if (!g.fxSpawned) {
        const pt = new THREE.Vector3(grp.position.x, grp.position.y + 1.0, grp.position.z);
        spawnBloodBurst(pt);
        spawnBloodPool(grp.position.x, grp.position.z);
        g.fxSpawned = true;
      }
      if (type === 'bomber') explodeAt(grp.position);   // explosion stays host-confirmed
    } else if (!dead) {
      // PREDICTION: our own shots have drained its HP — drop it instantly.
      if (!g.predDead && zombie && dispHp <= 0) predictGhostDeath(g);
      // safety: if the host never confirms (a lost packet / mis-predict), revive
      // the ghost rather than leaving a phantom corpse lying around.
      if (g.predDead) {
        g.predAge += dt;
        if (g.predAge > 1.0) { g.predDead = false; g.predDmg = 0; g.fxSpawned = false; }
      }
    }
    // track roll state for client-side rendering + charge-hit detection
    g.rolling = rollCode === 2;
    if (rollCode === 2 && !g.wasRolling) g.rollHit = false;  // a fresh charge began
    g.wasRolling = rollCode === 2;

    if (downed) {
      g.deathT += dt;
      grp.rotation.z = lerpAngle(grp.rotation.z, Math.PI / 2, 1 - Math.exp(-9 * dt));
    } else if (rollCode === 1) {
      // wind-up: crouch low + rock back (mirrors the host's tell)
      g.windupK = Math.min(1, (g.windupK || 0) + dt / 0.6);
      const squash = Math.sin(g.windupK * Math.PI) * 0.28;
      grp.scale.set(scale * (1 + squash * 0.6), scale * (1 - squash), scale * (1 + squash * 0.6));
      grp.rotation.x = -0.35 * g.windupK;
      grp.rotation.z = 0;
    } else if (rollCode === 2) {
      // rolling: somersault forward along the locked heading
      g.windupK = 0;
      g.rollSpin = (g.rollSpin || 0) + dt * 16;
      grp.scale.setScalar(scale);
      grp.rotation.x = g.rollSpin;
      grp.rotation.z = 0;
    } else if (rollCode === 3) {
      // recover: settle upright with a dizzy wobble
      const upright = Math.round(grp.rotation.x / (Math.PI * 2)) * (Math.PI * 2);
      grp.rotation.x = THREE.MathUtils.lerp(grp.rotation.x, upright, 1 - Math.exp(-8 * dt));
      grp.rotation.z = Math.sin(t * 20) * 0.1;
      grp.scale.setScalar(scale);
    } else if (screeching) {
      // siren wind-up: rear back + swell as she screams (mirrors the host tell)
      g.windupK = Math.min(1, (g.windupK || 0) + dt / SCREECH_WINDUP);
      const puff = Math.sin(g.windupK * Math.PI) * 0.16;
      grp.scale.set(scale * (1 + puff), scale * (1 + puff * 1.4), scale * (1 + puff));
      grp.rotation.x = -0.2 * g.windupK;
      grp.rotation.z = 0;
    } else if (pounding) {
      // boss wind-up: rear up tall before the slam (mirrors the host tell)
      g.poundK = Math.min(1, (g.poundK || 0) + dt / POUND_WINDUP);
      grp.scale.set(scale * (1 + 0.12 * g.poundK), scale * (1 + 0.3 * g.poundK), scale * (1 + 0.12 * g.poundK));
      grp.rotation.x = -0.3 * g.poundK;
      grp.rotation.z = 0;
    } else {
      if (grp.rotation.x) grp.rotation.x = 0;   // clear any leftover tumble
      g.windupK = 0; g.rollSpin = 0; g.poundK = 0;
      grp.scale.setScalar(scale);
      g.phase += dt * (mv ? 11 : 1.5);
      animatePenguin(g.pen, mv ? 1 : 0.2, t, g.phase);
      // wounded ghosts drip a blood trail too (predicted HP keeps it responsive)
      if (zombie) bleedTrail(g, grp, dispHp, maxHp, dt, mv);
    }
    // mirror the screech-enrage red glow on client ghosts
    if (enraged !== g._enr) { setEnrageTint(g.pen, enraged); g._enr = enraged; }
    if (!downed && zombie && type !== 'boss') {
      g.hb.set(dispHp / Math.max(1, maxHp));   // shows predicted damage instantly
      g.hb.sprite.position.set(grp.position.x, grp.position.y + 3.0 + scale * 1.0, grp.position.z);
      // hide the bar when a wall sits between the camera and the enemy
      g.hb.sprite.visible = !segmentBlocked(camera.position, _hbTmp.set(grp.position.x, grp.position.y + 1.3 * scale, grp.position.z));
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
    if (g.dead || g.predDead || !g.zombie) continue;   // predicted-dead can't hurt us
    const p = g.pen.group.position;
    const reach = 1.2 + g.scale * 0.9;
    const d = Math.hypot(player.group.position.x - p.x, player.group.position.z - p.z);
    // a charging brute bowls us over for a big one-time hit per charge
    if (g.rolling) {
      if (!g.rollHit && d < reach + 0.7) { damagePlayer(16 + g.scale * 5); g.rollHit = true; }
      continue;
    }
    if (g.type === 'spitter' || g.type === 'bomber') continue;
    if (d < reach) {
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

// client replays siren screeches: rings + disorienting its own player if in blast
let lastScreechSeq = 0;
let screechSynced = false;
function clientReadScreech() {
  const sf = getGlobal('scr');
  if (!sf || !sf.length) return;
  let maxSeq = lastScreechSeq;
  for (const e of sf) if (e.seq > maxSeq) maxSeq = e.seq;
  if (!screechSynced) { screechSynced = true; lastScreechSeq = maxSeq; return; }
  for (const e of sf) {
    if (e.seq <= lastScreechSeq) continue;
    sfx.screech();
    spawnScreechRing(e.x, groundHeightAt(e.x, e.z, 0), e.z);
    if (Math.hypot(player.group.position.x - e.x, player.group.position.z - e.z) <= (e.r || SCREECH_RADIUS)) {
      screechHitLocalPlayer(e.x, e.z);
    }
  }
  lastScreechSeq = maxSeq;
}

// client replays boss ground pounds: shockwave ring + stunning its own player if in blast
let lastPoundSeq = 0;
let poundSynced = false;
function clientReadPound() {
  const pf = getGlobal('pound');
  if (!pf || !pf.length) return;
  let maxSeq = lastPoundSeq;
  for (const e of pf) if (e.seq > maxSeq) maxSeq = e.seq;
  if (!poundSynced) { poundSynced = true; lastPoundSeq = maxSeq; return; }
  for (const e of pf) {
    if (e.seq <= lastPoundSeq) continue;
    sfx.land();
    spawnScreechRing(e.x, groundHeightAt(e.x, e.z, 0), e.z, 0xffd9a0);
    if (Math.hypot(player.group.position.x - e.x, player.group.position.z - e.z) <= (e.r || POUND_RADIUS)) {
      groundPoundHitLocalPlayer();
    }
  }
  lastPoundSeq = maxSeq;
}

function updateBossBarFromNet() {
  const b = getGlobal('boss');
  if (b) { bossBar.style.display = 'block'; bossFill.style.width = (b.hp / Math.max(1, b.max) * 100) + '%'; }
  else bossBar.style.display = 'none';
}

// ---------- CLIENT: pickups (request removal from host, apply locally) ----------
const ghostMeds = new Map();
const ghostAmmo = new Map();
const ghostCandy = new Map();
let pickSeq = 0;
const pickOut = [];
function flushPick() { setMyState('pkq', { seq: ++pickSeq, reqs: pickOut.slice(-20) }, true); }
function clientPickups(dt, t) {
  const meds = getGlobal('meds') || [];
  const mseen = new Set();
  for (const [id, x, z] of meds) {
    mseen.add(id);
    let grp = ghostMeds.get(id);
    if (!grp) { grp = makeMedpack(); grp.userData = { x, z, gy: groundHeightAt(x, z, 0) }; grp.position.set(x, grp.userData.gy, z); world.add(grp); ghostMeds.set(id, grp); }
    grp.rotation.y += dt * 1.5;
    grp.position.y = (grp.userData.gy || 0) + Math.sin(t * 2 + id) * 0.18 + 0.1;
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
    if (!grp) { grp = makeAmmoBox(); grp.userData = { x, z, amount, gy: groundHeightAt(x, z, 0) }; grp.position.set(x, grp.userData.gy, z); world.add(grp); ghostAmmo.set(id, grp); }
    grp.rotation.y += dt * 1.8;
    grp.position.y = (grp.userData.gy || 0) + Math.sin(t * 2.4 + id) * 0.14 + 0.06;
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

  const candy = getGlobal('candy') || [];
  const cseen = new Set();
  for (const [id, x, z] of candy) {
    cseen.add(id);
    let grp = ghostCandy.get(id);
    if (!grp) { grp = makeCandyBar(); grp.userData = { x, z, gy: groundHeightAt(x, z, 0) }; grp.position.set(x, grp.userData.gy, z); world.add(grp); ghostCandy.set(id, grp); }
    grp.rotation.y += dt * 2.2;
    grp.position.y = (grp.userData.gy || 0) + Math.sin(t * 2.6 + id) * 0.16 + 0.08;
    if (started && !gameOver && !grp.userData.claimed &&
        Math.hypot(player.group.position.x - grp.userData.x, player.group.position.z - grp.userData.z) < 1.9) {
      grp.userData.claimed = true;
      grantSpeedBoost();
      floatText('SUGAR RUSH!', new THREE.Vector3(grp.userData.x, 1.3, grp.userData.z), '#ff5fb0', 20);
      pickOut.push({ kind: 'candy', id }); flushPick();
    }
  }
  for (const [id, grp] of ghostCandy) if (!cseen.has(id)) { world.remove(grp); ghostCandy.delete(id); }
}

// ---------- CLIENT: outgoing hits ----------
let hitSeq = 0;
let localHitId = 0;     // monotonic id stamped on every shot that connects
let lastSentHid = 0;
const hitOut = [];      // rolling window of recent hits (host dedupes by hid)
function flushHits() {
  // re-send the recent-hit window until a new hit appears; the per-hit `hid`
  // lets the host process each shot exactly once even if it samples our state
  // at a lower rate, so no hits (and no predicted kills) are ever lost.
  if (localHitId === lastSentHid || !hitOut.length) return;
  lastSentHid = localHitId;
  setMyState('hx', { seq: ++hitSeq, hits: hitOut.slice() }, true);
}

// when becoming a client, the host owns the world — drop our local entities
function enterClientMode() {
  for (const n of npcs) { world.remove(n.group); world.remove(n.tag); world.remove(n.hb.sprite); }
  npcs.length = 0;
  for (const m of medpacks) world.remove(m.group); medpacks.length = 0;
  for (const a of ammoDrops) world.remove(a.group); ammoDrops.length = 0;
  for (const c of candyDrops) world.remove(c.group); candyDrops.length = 0;
  for (const s of spits) world.remove(s.m); spits.length = 0;
  for (const b of iceBalls) world.remove(b.m); iceBalls.length = 0;
  for (const c of iceCraters) world.remove(c.group); iceCraters.length = 0;
  for (const c of gasClouds) world.remove(c.group); gasClouds.length = 0;
}

// =====================================================================
//  NPC behavior
// =====================================================================
const _toP = new THREE.Vector3();
const _perp = new THREE.Vector3();

// gravity + ground-following for a penguin, so NPCs walk on terrain/slopes and
// land from jumps exactly like the player. Climbs walkable surfaces (hills,
// mounds, docks) by snapping up to them; falls when there's air underfoot.
function npcGroundVertical(npc, dt) {
  const pos = npc.group.position;
  npc.velY = (npc.velY ?? 0) - GRAVITY * dt;
  pos.y += npc.velY * dt;
  const gy = groundHeightAt(pos.x, pos.z, 0);
  if (npc.velY <= 0 && pos.y - gy <= STEP_DOWN) {
    pos.y = gy; npc.velY = 0; npc.onGround = true;     // on / stepping onto the surface
  } else {
    npc.onGround = false;                              // airborne (jumping / falling)
  }
  // keep the shadow pinned to the ground (it's a child of the group, so without
  // this it rides up with the body on jumps) and shrink it with jump height
  if (npc.parts && npc.parts.shadow) {
    const h = pos.y - gy;
    npc.parts.shadow.position.y = 0.02 - h;
    const s = clamp(1 - h * 0.18, 0.45, 1);
    npc.parts.shadow.scale.set(s, s, s);
  }
}

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

    // siren screech enrage: speed buff for a few seconds, with a red glow tell
    if (npc.enrageT > 0) {
      npc.enrageT -= dt;
      if (!npc._enrTint) { setEnrageTint(npc, true); npc._enrTint = true; }
    } else if (npc._enrTint) { setEnrageTint(npc, false); npc._enrTint = false; }

    // a penguin tossed by the boss: ballistic arc, then resume the chase sprinting
    if (npc.flying) {
      npc.fvy -= ICE_GRAV * dt;
      pos.x += npc.fvx * dt; pos.z += npc.fvz * dt; pos.y += npc.fvy * dt;
      npc.group.rotation.x += dt * 7;
      const landY = groundHeightAt(pos.x, pos.z, 0);
      if (pos.y <= landY) {
        pos.y = landY; npc.flying = false; npc.velY = 0; npc.group.rotation.x = 0;
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

      // big brutes periodically wind up and barrel-roll in a straight line; while
      // a charge is in progress this fully owns the brute's movement + animation
      if (npc.type === 'brute') {
        npc.rollCD = (npc.rollCD ?? (3 + Math.random() * 3)) - dt;
        if (handleBruteRoll(npc, pos, tgt, distP, distLocal, reach, dt, t)) continue;
      }

      // sirens hang back and periodically scream — disorients you + enrages the horde
      if (npc.type === 'siren') {
        if (handleSirenScreech(npc, pos, tgt, distP, dt, t)) continue;
      }

      // boss slams the ground when you crowd it — shockwave that stuns + hurts
      if (npc.type === 'boss') {
        if (handleBossPound(npc, pos, tgt, distP, dt, t)) continue;
      }

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
          // don't pile ice onto a player who's already trapped — hold fire and
          // retry shortly so the volley resumes right after they thaw out
          if (nearestPlayerFrozen(pos.x, pos.z)) {
            npc.iceTimer = 0.5;
          } else {
            npc.iceTimer = 4.5 + Math.random() * 2;
            const volley = 3 + Math.floor(round / 5);
            for (let q = 0; q < volley; q++) {
              const ox = (Math.random() - 0.5) * 9, oz = (Math.random() - 0.5) * 9;
              spawnIceBall(new THREE.Vector3(pos.x, pos.y + 3.6, pos.z), tgt.x + ox, tgt.z + oz);
            }
            sfx.groan();
          }
        }
        npc.throwTimer = (npc.throwTimer ?? 6) - dt;
        if (npc.throwTimer <= 0 && distP < 58 && aliveZombies() < HORDE_CAP) {
          npc.throwTimer = 6.5 + Math.random() * 3;
          throwPenguin(pos, tgt);
        }
      }

      // approach (1), hold (0) or back away (-1)
      let approach = 1;
      if (npc.type === 'spitter' || npc.type === 'siren') approach = distP > 13 ? 1 : distP < 8 ? -1 : 0;
      else if (distP < reach) approach = 0;

      const sep = npcSeparation(npc, pos);            // crowd spacing nudge

      if (approach === 0) {
        npc.moving = false;
        // gently declump while attacking so the swarm surrounds the player in a
        // ring instead of all piling onto the exact same point
        if ((sep.x || sep.z)) {
          const ns = pos.clone(); ns.x += sep.x * 1.8 * dt; ns.z += sep.z * 1.8 * dt;
          if (!collides(ns, true)) { pos.x = ns.x; pos.z = ns.z; }
        }
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
        // desired heading toward the player (or away), plus a weaving sway offset.
        // When advancing, aim along the A* route so we round buildings instead of
        // grinding into them; retreating spitters still just back straight off.
        npc.swayPhase += dt * npc.swayFreq;
        let aimX = tgt.x, aimZ = tgt.z;
        if (approach > 0) { const st = npcSteerTarget(npc, pos, tgt, dt); aimX = st.x; aimZ = st.z; }
        // blend the crowd-separation nudge into the travel direction so they
        // spread out laterally while still flowing toward the player
        let dirX = aimX - pos.x, dirZ = aimZ - pos.z;
        const dl = Math.hypot(dirX, dirZ) || 1; dirX /= dl; dirZ /= dl;
        if (approach > 0) { dirX += sep.x * 0.6; dirZ += sep.z * 0.6; }
        let baseAng = Math.atan2(dirX, dirZ);
        if (approach < 0) baseAng += Math.PI; // retreat
        const swayOff = Math.sin(npc.swayPhase) * npc.sway * 0.18;
        // occasional lunges (bursts of speed)
        npc.lungeTimer -= dt;
        if (npc.lungeTimer <= 0) { npc.lunge = 0.5; npc.lungeTimer = 3 + Math.random() * 5; }
        let sp = npc.speed;
        if (npc.lunge > 0) { npc.lunge -= dt; sp *= 1.9; }
        if (npc.enrageT > 0) sp *= ENRAGE_MULT;     // screech-enraged zombies charge faster
        // probe several candidate headings and take a clear one so they steer
        // AROUND buildings instead of grinding into corners. Two key details:
        //  - look a fixed distance ahead (not just this frame's tiny step) so a
        //    wall is detected early enough to turn before grinding it; and
        //  - remember which way we last turned (turnBias) and try that side
        //    first, so a zombie commits to rounding a corner one way instead of
        //    flip-flopping left/right (which looked like it spun a full 360).
        const look = Math.max(sp * dt, 0.6 + npc.scale * 0.35);
        const bias = npc.turnBias >= 0 ? 1 : -1;
        const cands = npc.stuck > 0.6
          ? [bias * 1.4, bias * 2.2, bias * 0.8, -bias * 1.4, -bias * 2.2, -bias * 0.8, Math.PI]
          : [0, bias * 0.45, bias * 0.95, -bias * 0.45, bias * 1.5, -bias * 0.95, -bias * 1.5];
        let movedAny = false, chosenOff = 0;
        // if we're somehow stuck inside a collider, move regardless so we escape
        const trapped = insideSolid(pos);
        for (const off of cands) {
          const ang = baseAng + swayOff + off;
          const sa = Math.sin(ang), ca = Math.cos(ang);
          const probe = pos.clone(); probe.x += sa * look; probe.z += ca * look;
          if (trapped || !collides(probe, true)) {
            const step = Math.min(sp * dt, look);
            pos.x += sa * step; pos.z += ca * step;
            npc.heading = ang; movedAny = true; chosenOff = off;
            break;
          }
        }
        if (movedAny) {
          npc.stuck = Math.max(0, npc.stuck - dt * 2);
          if (chosenOff > 0.1) npc.turnBias = 1;
          else if (chosenOff < -0.1) npc.turnBias = -1;
        } else npc.stuck += dt;
        npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-9 * dt));
      }

      // COD-style leap: hop up toward a player perched somewhere higher, or to
      // vault when shoving against an obstacle. Height of the jump adapts to how
      // far up the player is so they can actually reach ledges/hilltops.
      npc.jumpCD = (npc.jumpCD ?? 0) - dt;
      if (npc.onGround && npc.type !== 'boss' && npc.jumpCD <= 0) {
        const above = player.group.position.y - pos.y;
        if ((above > 1.0 && distLocal < 8) || (npc.stuck > 0.5 && above > 0.4)) {
          const need = Math.min(Math.max(above + 0.6, 1.4), 5.5);
          npc.velY = Math.sqrt(2 * GRAVITY * need);     // just enough to clear it
          npc.onGround = false;
          npc.stuck = 0;
          npc.jumpCD = 0.9 + Math.random() * 0.5;
        }
      }
      // gravity + terrain following (also resolves the jump arc + landing)
      npcGroundVertical(npc, dt);

      // wounded penguins drip a blood trail as they move
      if (npc.isZombie) bleedTrail(npc, npc.group, npc.hp, npc.maxHp, dt, npc.moving && npc.onGround);

      // forward lurch + faster, jerky waddle (tuck legs while airborne)
      const lurch = npc.onGround ? (npc.moving ? 0.2 : 0) : -0.3;
      npc.group.rotation.x = THREE.MathUtils.lerp(npc.group.rotation.x, lurch, 1 - Math.exp(-8 * dt));
      npc.phase += dt * (9 + npc.speed * 1.5);
      animatePenguin(npc, npc.moving ? 1 : 0.2, t, npc.phase);
      npc.hb.sprite.position.set(pos.x, pos.y + 3.0 + npc.scale * 1.0, pos.z);
      // hide the bar when a wall sits between the camera and the enemy
      npc.hb.sprite.visible = !segmentBlocked(camera.position, _hbTmp.set(pos.x, pos.y + 1.3 * npc.scale, pos.z));
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
      // move freely if already overlapping a collider, so we never freeze
      if (insideSolid(pos) || !collides(np)) pos.copy(np);
      else npc.target = pickWanderTarget();
      npc.heading = Math.atan2(step.x, step.z);
      npc.group.rotation.y = lerpAngle(npc.group.rotation.y, npc.heading, 1 - Math.exp(-8 * dt));
    }
    npcGroundVertical(npc, dt);                         // walk on terrain/slopes too
    npc.phase = npc.phase + dt * 8 * (npc.moving ? 1 : 0);
    animatePenguin(npc, npc.moving ? 1 : 0, t, npc.phase);
    npc.tag.position.set(pos.x, pos.y + 3.0, pos.z);
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

}

let lastDt = 0.016;
// =====================================================================
//  Level system — additive editor layer loaded from a committed JSON map.
//  The hardcoded town above is the immutable base; placed objects live in
//  `editorLayer` and contribute collision via rebuildSolid(). The same
//  town.json ships to every client, so no runtime sync is needed.
// =====================================================================
const editorLayer = new THREE.Group();
editorLayer.name = 'editorLayer';
world.add(editorLayer);

const placedObjects = [];   // [{ id, def, obj }]
let placedSeq = 0;
let baseSolid = null;       // snapshot of the hardcoded collision boxes

function applyDefTransform(obj, def) {
  obj.position.set(def.position?.x ?? 0, def.position?.y ?? 0, def.position?.z ?? 0);
  obj.rotation.set(def.rotation?.x ?? 0, def.rotation?.y ?? 0, def.rotation?.z ?? 0);
  obj.scale.set(def.scale?.x ?? 1, def.scale?.y ?? 1, def.scale?.z ?? 1);
}

// "smart" collision: derive an object's footprint from its actual mesh
// bounding box (in world space) rather than a hand-tuned value. This tracks
// the real geometry, scale and rotation, so the collider matches what you see.
const PLAYER_MARGIN = 0.35;   // small padding for the player's body radius
// WALKABLE = surfaces you stand ON. The player raycasts straight down onto
// these and follows the real mesh, so domes/slopes (hill, snow mounds, igloo
// roofs) are CLIMBED exactly instead of hitting an offset box wall. They never
// produce a blocking collider.
const WALKABLE = new Set(['ground', 'plazafloor', 'lake', 'hill', 'path', 'dock', 'snowmound', 'igloo']);
// NO_COLLIDE = overhead / flat decor (hanging lights, bunting, floating signs)
// that should neither block nor be stood on.
const NO_COLLIDE = new Set(['lightstring', 'bunting', 'labelsign']);
const _fpBox = new THREE.Box3();
const _fpTmp = new THREE.Box3();
const _fpWorld = new THREE.Vector3();
function meshFootprint(rec) {
  const def = rec.def;
  const meta = CATALOG[def.type];
  const collide = def.collide ?? (meta ? meta.collide : false);
  if (!collide || !rec.obj || WALKABLE.has(def.type) || NO_COLLIDE.has(def.type)) return null;
  rec.obj.updateWorldMatrix(true, true);
  // Read the real mesh extents — used for the vertical span (top/base) so the
  // step-up / overhang logic is accurate, and as the X/Z fallback.
  _fpBox.makeEmpty();
  let has = false;
  rec.obj.traverse((m) => {
    if (!m.isMesh || !m.geometry) return;          // meshes only — ignore sprites/labels
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    _fpTmp.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld);
    _fpBox.union(_fpTmp); has = true;
  });
  if (!has) return null;

  // Prefer the hand-authored footprint: it's the intended collision shape,
  // tight to the structure (a building's WALLS) and ignores oversized decorative
  // geometry like the roof cone or the awning that the raw mesh bbox would
  // wrongly include. Fall back to the mesh bbox only if no footprint is defined.
  rec.obj.getWorldPosition(_fpWorld);
  let cx = _fpWorld.x, cz = _fpWorld.z, hx, hz;
  const fp = meta && meta.footprint && meta.footprint({ ...(meta.params || {}), ...(def.params || {}) });
  // round collider: a circular footprint (no boxy corners) for spherical props
  if (fp && fp.r != null) {
    const sxz = Math.max(Math.abs(rec.obj.scale.x), Math.abs(rec.obj.scale.z));
    const r = fp.r * sxz + PLAYER_MARGIN;
    if (r <= 0) return null;
    return { x: cx, z: cz, r, base: _fpBox.min.y, top: _fpBox.max.y };
  }
  if (fp) {
    const lhx = fp.hx * Math.abs(rec.obj.scale.x);
    const lhz = fp.hz * Math.abs(rec.obj.scale.z);
    // grow the rotated rectangle's AABB so a turned building still fits snugly
    const yaw = rec.obj.rotation.y || 0;
    const c = Math.abs(Math.cos(yaw)), s = Math.abs(Math.sin(yaw));
    hx = lhx * c + lhz * s;
    hz = lhx * s + lhz * c;
  } else {
    hx = (_fpBox.max.x - _fpBox.min.x) / 2;
    hz = (_fpBox.max.z - _fpBox.min.z) / 2;
    cx = (_fpBox.min.x + _fpBox.max.x) / 2;
    cz = (_fpBox.min.z + _fpBox.max.z) / 2;
  }
  if (hx <= 0 || hz <= 0) return null;
  return {
    x: cx,
    z: cz,
    hx: hx + PLAYER_MARGIN,
    hz: hz + PLAYER_MARGIN,
    base: _fpBox.min.y,   // bottom of the mesh (overhangs don't block)
    top: _fpBox.max.y,    // top of the mesh (low ledges are step-overs)
  };
}

// recompute the collision list + walkable surfaces from base + placed objects
function rebuildSolid() {
  if (!baseSolid) baseSolid = solid.slice();
  solid.length = 0;
  walkRoots.length = 0;
  solidRoots.length = 0;
  for (const s of baseSolid) solid.push(s);
  for (const rec of placedObjects) {
    const fp = meshFootprint(rec);
    if (fp) solid.push(fp);
    // blocking colliders double as line-of-sight occluders for shots + health bars
    if (fp && rec.obj) solidRoots.push(rec.obj);
    if (rec.obj && WALKABLE.has(rec.def.type)) walkRoots.push(rec.obj);
  }
  buildNavGrid();   // refresh the A* occupancy grid from the new collider layout
  syncSceneRefs();
}

// resolve gameplay objects (shop counter, pistol pickup) from the placed set
// so the buy/upgrade logic tracks them wherever the editor puts them.
function syncSceneRefs() {
  shopRec = placedObjects.find((r) => r.def.type === 'shop') || null;
  gunPickupRec = placedObjects.find((r) => r.def.type === 'gunpickup') || null;
  if (gunPickupRec) gunPickupRec.obj.visible = !WEAPONS.pistol.owned;
  computeShopZone();
}

// curated context handed to every component script (decoupled from internals).
// NOTE: we deliberately do NOT pass the whole THREE namespace here — doing so
// makes it a runtime value and defeats three.js tree-shaking in the prod
// bundle. Components import the specific three classes they need directly.
const gameCtx = {
  scene, world, toast, sfx,
  get player() { return player; },
  netRole,
};

// collect emissive meshes tagged for twinkling into the shared animation list
function collectTwinkles(rec) {
  rec.twinkles = [];
  rec.obj.traverse?.((m) => {
    if (m.isMesh && m.material && m.userData.twinkle) {
      const entry = { mat: m.material, base: m.userData.twinkle.base, amp: m.userData.twinkle.amp ?? 0.5, phase: Math.random() * 6 };
      twinkles.push(entry);
      rec.twinkles.push(entry);
    }
  });
}
function releaseTwinkles(rec) {
  if (!rec.twinkles) return;
  for (const e of rec.twinkles) { const i = twinkles.indexOf(e); if (i >= 0) twinkles.splice(i, 1); }
  rec.twinkles = [];
}

// (re)build the component script instances attached to a placed object
function instantiateComponents(rec) {
  destroyComponents(rec);
  rec.components = [];
  const go = { id: rec.id, def: rec.def, object3d: rec.obj };
  for (const c of (rec.def.components || [])) {
    const meta = COMPONENTS[c.type];
    if (!meta) continue;
    const params = { ...meta.params, ...(c.params || {}) };
    try {
      const inst = meta.create(go, params, gameCtx);
      if (inst) { rec.components.push(inst); inst.start?.(); }
    } catch (e) { console.error(`[component:${c.type}] create failed`, e); }
  }
}
function destroyComponents(rec) {
  if (!rec.components) return;
  for (const inst of rec.components) { try { inst.onDestroy?.(); } catch (e) { /* ignore */ } }
  rec.components = [];
}

// tick all component update() hooks (runs in game + editor preview)
function updateGameObjects(dt, t) {
  for (const rec of placedObjects) {
    if (!rec.components) continue;
    for (const inst of rec.components) inst.update?.(dt, t);
  }
}

// fire the nearest interactable GameObject's script when the player presses E
function tryInteractGameObjects() {
  const px = player.group.position.x, pz = player.group.position.z;
  let best = null, bestD = Infinity;
  for (const rec of placedObjects) {
    if (!rec.components) continue;
    for (const inst of rec.components) {
      if (typeof inst.onInteract !== 'function') continue;
      if (inst.canInteract && !inst.canInteract()) continue;
      const r = inst.interactRadius ?? 3;
      const d = Math.hypot(px - rec.obj.position.x, pz - rec.obj.position.z);
      if (d <= r && d < bestD) { best = inst; bestD = d; }
    }
  }
  if (best) { best.onInteract(player); return true; }
  return false;
}

function spawnDef(def) {
  if (!def.id) def.id = `obj_${Date.now().toString(36)}_${(placedSeq++).toString(36)}`;
  if (!def.components) def.components = [];
  const obj = makeObject(def.type, def.params);
  if (!obj) return null;
  applyDefTransform(obj, def);
  obj.userData.placedId = def.id;
  editorLayer.add(obj);
  const rec = { id: def.id, def, obj, components: [], twinkles: [] };
  placedObjects.push(rec);
  collectTwinkles(rec);
  instantiateComponents(rec);
  return rec;
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

function removeRecord(rec) {
  const i = placedObjects.indexOf(rec);
  if (i >= 0) placedObjects.splice(i, 1);
  destroyComponents(rec);
  releaseTwinkles(rec);
  editorLayer.remove(rec.obj);
  disposeObj(rec.obj);
}

function clearLevel() {
  for (const rec of placedObjects.slice()) {
    destroyComponents(rec);
    releaseTwinkles(rec);
    editorLayer.remove(rec.obj);
    disposeObj(rec.obj);
  }
  placedObjects.length = 0;
}

function loadLevel(data) {
  clearLevel();
  const objs = (data && data.objects) || [];
  for (const def of objs) spawnDef(JSON.parse(JSON.stringify(def)));
  rebuildSolid();
}

function getLevelData() {
  return { version: 1, objects: placedObjects.map((r) => r.def) };
}

// rebuild an object's visual + components after its params change (editor)
function refreshObject(rec) {
  releaseTwinkles(rec);
  destroyComponents(rec);
  editorLayer.remove(rec.obj);
  disposeObj(rec.obj);
  rec.obj = makeObject(rec.def.type, rec.def.params);
  applyDefTransform(rec.obj, rec.def);
  rec.obj.userData.placedId = rec.def.id;
  editorLayer.add(rec.obj);
  collectTwinkles(rec);
  instantiateComponents(rec);
  return rec.obj;
}

// load the committed map for everyone (host, client, solo, prod) at startup.
// ---- register builders that depend on factories living in main.js ----
// (the keeper penguin, the pistol pickup, and floating location label signs)
registerType('keeper', {
  label: 'Keeper (NPC)', category: 'Gameplay', collide: false,
  params: { color: 0x39304a, tag: '🔫 Gunther' },
  schema: [{ key: 'tag', label: 'Name tag', type: 'text', default: '🔫 Gunther' }, { key: 'color', label: 'Color', type: 'color', default: 0x39304a }],
  footprint: () => ({ hx: 0.9, hz: 0.9 }),
  build(p) {
    const g = new THREE.Group();
    const peng = makePenguin({ color: p.color, hat: 'cap', scale: 1.1 });
    g.add(peng.group);
    if (p.tag) {
      const tag = makeNameTag(p.tag, 0xffcf5a);
      tag.position.set(0, 3.0, 0);
      g.add(tag);
    }
    return g;
  },
});
registerType('gunpickup', {
  label: 'Pistol Pickup', category: 'Gameplay', collide: false,
  params: {}, schema: [], footprint: () => ({ hx: 0.6, hz: 0.6 }),
  build() {
    const g = new THREE.Group();
    const gun = makePistol(1.2);
    gun.position.set(0, 0.25, 0);
    gun.rotation.set(0, 0.5, 0.2);
    g.add(gun);
    const glow = mesh(new THREE.TorusGeometry(0.7, 0.05, 8, 24), new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffc21a, emissiveIntensity: 1.3 }), false, false);
    glow.rotation.x = Math.PI / 2;
    g.add(glow);
    return g;
  },
});
registerType('labelsign', {
  label: 'Label Sign', category: 'Props', collide: false,
  params: { text: 'Sign', bg: 'rgba(15,70,104,.92)', height: 2.4 },
  schema: [{ key: 'text', label: 'Text', type: 'text', default: 'Sign' }, { key: 'height', label: 'Size', type: 'number', default: 2.4, min: 0.5, max: 8, step: 0.1 }],
  footprint: () => null,
  build(p) {
    const sprite = makeLabelSprite(p.text || 'Sign', { bg: p.bg });
    const h = p.height || 2.4;
    sprite.scale.set(h * sprite.userData.aspect, h, 1);
    const g = new THREE.Group();
    g.add(sprite);
    return g;
  },
});

// If town.json hasn't been authored yet, fall back to the built-in town so
// the world isn't empty and the editor opens with editable props.
loadLevel(townLevel && townLevel.objects && townLevel.objects.length ? townLevel : defaultTown());

// Townsfolk are spawned before the level (so collision wasn't known yet) at
// y=0. Now that the walkable surfaces exist, rest them on the real ground —
// and relocate any that ended up perched on an elevated prop (igloo dome, snow
// mound) to a nearby flat spot, so none appear to drop out of the sky on load.
function settleNPCsToGround() {
  for (const npc of npcs) {
    let x = npc.group.position.x, z = npc.group.position.z;
    if (groundHeightAt(x, z, 0) > 0.4) {
      for (let tries = 0; tries < 20; tries++) {
        const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 30;
        const nx = Math.cos(a) * r, nz = Math.sin(a) * r;
        if (!collides({ x: nx, z: nz }) && groundHeightAt(nx, nz, 0) <= 0.4) { x = nx; z = nz; break; }
      }
    }
    npc.group.position.set(x, groundHeightAt(x, z, 0), z);
    npc.velY = 0; npc.onGround = true;
  }
}
settleNPCsToGround();

// ---- dev-only editor bootstrap (excluded from production builds) ----
let editorActive = false;
function setEditorActive(v) {
  editorActive = v;
  if (v) {
    keys.clear();
    if (document.pointerLockElement) document.exitPointerLock();
  }
}
let editorInstance = null;
if (import.meta.env.DEV) {
  const editorAPI = {
    THREE, scene, camera, renderer, world, editorLayer,
    placedObjects, CATALOG, PALETTE, CATEGORIES, defaultDef, mergedParams, makeObject,
    COMPONENTS, COMPONENT_TYPES, defaultComponent,
    spawnDef, removeRecord, rebuildSolid, applyDefTransform, getLevelData, loadLevel,
    refreshObject, instantiateComponents,
    setEditorActive, isMultiplayer: () => mpActive(), toast,
  };
  import('./editor/editor.js')
    .then((m) => { editorInstance = m.initEditor(editorAPI); })
    .catch((e) => console.error('[editor] failed to load', e));
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  lastDt = dt;
  const t = clock.elapsedTime;

  // editor mode: pause the whole game sim, let the editor drive the camera.
  // Component scripts still tick so behaviors (Spin/Bob/Glow) can be previewed.
  if (editorActive && editorInstance) {
    updateGameObjects(dt, t);
    editorInstance.update(dt);
    renderer.render(scene, camera);
    return;
  }

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
    // lean slightly into the run so it reads as forward momentum, not a wobble
    const leanX = moving ? 0.12 * playerSpeed : 0;
    player.group.rotation.x = THREE.MathUtils.lerp(player.group.rotation.x, leanX, 1 - Math.exp(-12 * dt));
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
    clientReadScreech();
    clientReadPound();
    clientCraters();
    clientGas(dt, t);
    updateBossBarFromNet();
    flushHits();
  } else {
    // SOLO or HOST: run the full local simulation.
    updateHorde(dt);
    updateNPCs(dt, t);
    updateMedpacks(dt, t);
    updateAmmoDrops(dt, t);
    updateCandyDrops(dt, t);
    updateIceBalls(dt);
    updateIceCraters(dt);
    updateGasClouds(dt, t);
    updateBossBar();
    if (role === 'host') {
      hostReadInputs();
      bcastAcc += dt;
      if (bcastAcc >= 0.05) { bcastAcc = 0; hostBroadcast(); }  // ~20 Hz world snapshot
    }
  }
  updateDamageVignette(dt, t);
  updateDisorient(dt, t);
  updateScreechRings(dt);
  updateGameObjects(dt, t);
  updateShop(dt, t);
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
