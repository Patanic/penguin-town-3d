// One-off migration: append the new data-driven environment + gameplay
// GameObjects (systemObjects) into the existing committed town.json, keeping
// any props/edits already authored there. Re-runnable (skips existing ids).
import { readFileSync, writeFileSync } from 'node:fs';
import { systemObjects } from '../src/world/defaultTown.js';

const url = new URL('../src/levels/town.json', import.meta.url);
const town = JSON.parse(readFileSync(url, 'utf8'));
const existing = new Set(town.objects.map((o) => o.id));

let added = 0;
for (const o of systemObjects()) {
  if (!existing.has(o.id)) { town.objects.push(o); added++; }
}

writeFileSync(url, JSON.stringify(town, null, 2) + '\n');
console.log(`merge-town: added ${added} objects; total now ${town.objects.length}`);
