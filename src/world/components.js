// =====================================================================
//  Component (script) registry — the start of a Unity-style GameObject
//  system. A placed object def can carry a `components` array; each entry
//  is `{ type, params }`. At spawn time the runtime instantiates the
//  matching script via `create(go, params, ctx)`, which returns an
//  instance exposing optional lifecycle hooks:
//
//    start()            — once, after the object + components are created
//    update(dt, t)      — every frame (also runs in the editor for preview)
//    onInteract(player) — when the player interacts nearby (E)
//    onDestroy()        — cleanup when the object/component is removed
//
//  `go` is the GameObject handle: { id, def, object3d }.
//  `ctx` is the curated game context injected by main.js (player, toast,
//  sfx, netRole, …). Components import the specific three.js classes they
//  need directly (rather than receiving the whole namespace) so the bundler
//  can tree-shake three properly. Components are intentionally decoupled
//  from main.js internals so new behaviors can be added independently.
// =====================================================================
import { Color } from 'three';

const num = (key, label, def, min, max, step = 0.1) => ({ key, label, type: 'number', default: def, min, max, step });
const opt = (key, label, options, def) => ({ key, label, type: 'select', options, default: def });
const bool = (key, label, def) => ({ key, label, type: 'bool', default: def });

export const COMPONENTS = {
  Spin: {
    label: 'Spin',
    params: { speed: 1, axis: 'y' },
    schema: [num('speed', 'Speed', 1, -12, 12, 0.1), opt('axis', 'Axis', ['x', 'y', 'z'], 'y')],
    create(go, p) {
      return {
        update(dt) { go.object3d.rotation[p.axis] += p.speed * dt; },
      };
    },
  },

  Bob: {
    label: 'Bob (float)',
    params: { amp: 0.5, speed: 1.5 },
    schema: [num('amp', 'Amplitude', 0.5, 0, 6, 0.1), num('speed', 'Speed', 1.5, 0, 10, 0.1)],
    create(go, p) {
      const baseY = go.object3d.position.y;
      let t = Math.random() * Math.PI * 2;
      return {
        update(dt) { t += dt; go.object3d.position.y = baseY + Math.sin(t * p.speed) * p.amp; },
        onDestroy() { go.object3d.position.y = baseY; },
      };
    },
  },

  Glow: {
    label: 'Glow (pulse)',
    params: { color: 0xffd97a, intensity: 1.2, speed: 2 },
    schema: [
      { key: 'color', label: 'Color', type: 'color', default: 0xffd97a },
      num('intensity', 'Intensity', 1.2, 0, 4, 0.1), num('speed', 'Speed', 2, 0, 12, 0.1),
    ],
    create(go, p) {
      const targets = [];
      go.object3d.traverse?.((m) => {
        if (m.isMesh && m.material && 'emissive' in m.material) targets.push(m.material);
      });
      const col = new Color(p.color);
      let t = 0;
      for (const mtl of targets) mtl.emissive = col.clone();
      return {
        update(dt) {
          t += dt;
          const f = (Math.sin(t * p.speed) * 0.5 + 0.5) * p.intensity;
          for (const mtl of targets) mtl.emissiveIntensity = f;
        },
        onDestroy() { for (const mtl of targets) mtl.emissiveIntensity = 0; },
      };
    },
  },

  Shimmer: {
    label: 'Shimmer (water)',
    params: { amp: 0.06, speed: 1.5, base: 0.82 },
    schema: [num('amp', 'Amount', 0.06, 0, 0.5, 0.01), num('speed', 'Speed', 1.5, 0, 8, 0.1), num('base', 'Opacity', 0.82, 0, 1, 0.02)],
    create(go, p) {
      const targets = [];
      go.object3d.traverse?.((m) => {
        // prefer meshes explicitly tagged as water; fall back to any transparent mesh
        if (m.isMesh && m.material && (m.userData.shimmer || m.material.transparent)) targets.push(m.material);
      });
      for (const mtl of targets) mtl.transparent = true;
      let t = Math.random() * Math.PI * 2;
      return {
        update(dt) {
          t += dt;
          const o = p.base + Math.sin(t * p.speed) * p.amp;
          for (const mtl of targets) mtl.opacity = o;
        },
      };
    },
  },

  Interactable: {
    label: 'Interactable',
    params: { radius: 3.5, message: 'Hello, penguin!', once: false },
    schema: [
      num('radius', 'Radius', 3.5, 0.5, 20, 0.5),
      { key: 'message', label: 'Message', type: 'text', default: 'Hello, penguin!' },
      bool('once', 'Fire once', false),
    ],
    create(go, p, ctx) {
      let fired = false;
      return {
        get interactRadius() { return p.radius; },
        canInteract() { return !(p.once && fired); },
        onInteract() {
          if (p.once && fired) return;
          fired = true;
          ctx.toast?.(p.message);
          ctx.sfx?.emote?.();
        },
      };
    },
  },
};

export const COMPONENT_TYPES = Object.keys(COMPONENTS);

export function defaultComponent(type) {
  const meta = COMPONENTS[type];
  return { type, params: { ...(meta ? meta.params : {}) } };
}
