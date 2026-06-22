# Penguin Town 3D

A tiny original Three.js browser world made as a starting point for a cozy snowy penguin social game. It intentionally does **not** use Club Penguin's name, map, characters, art, music, or other assets.

## Run it

1. Install a recent Node.js LTS release.
2. In this folder, run:

```bash
npm install
npm run dev
```

3. Open the local URL Vite prints (normally `http://localhost:5173`).

## Controls

- Click **Enter the town**
- **WASD / arrow keys:** walk
- **Shift:** sprint
- **Mouse:** orbit camera
- **Esc:** release the mouse

## What's included

- Snowy town plaza, café lane, sled hill, dock/pond
- Original low-poly penguin avatar
- Buildings, signs, roads, docks, pine trees, falling snow
- Basic collision against buildings and map boundary
- Third-person camera and simple animation

## Good next upgrades

- Replace procedural buildings with Blender `.glb` assets
- Add room entrances / scene loading
- Add emotes, clothing, inventory, furniture, and igloos
- Use Colyseus or Socket.io for multiplayer rooms
- Add a backend for accounts, chat moderation, saves, and cosmetics
