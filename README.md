# Vector Tower Defense

A browser-based tower defense game with **AI-generated terrain textures**. Every grass, water, sand, and path tile is generated via [fal.ai](https://fal.ai) text-to-image models and assembled into seamless Wang tile sets using advanced edge-matching algorithms.

![Phaser 3](https://img.shields.io/badge/Phaser_3-3.60-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178c6)
![Vite](https://img.shields.io/badge/Vite-8.0-646cff)
![License](https://img.shields.io/badge/License-MIT-green)

## Features

- **AI-generated terrain** — Tile textures are created by SDXL and Flux models via fal.ai, with a built-in browser UI for prompt crafting and batch generation
- **Crop-based anti-repetition** — Each grid cell receives a unique 48×48 crop from a 1024×1024 source texture, eliminating visible tiling patterns
- **Wang tile edge matching** — 16-tile sets generated with Cohen et al. (2003) search-based algorithm for seamless corner/boundary blending
- **Layered corner-bitmask transitions** — Procedural alpha-blended overlays connect grass, water, sand, and path terrains without hard edges
- **Full tower defense gameplay** — Hero unit, multiple tower types with evolutions, ability combos, synergy system, wave manager, and economy
- **One-command deploy** — Docker container with nginx deploys to k3s with TLS via Let's Encrypt

## Quick Start

```bash
npm install

# Run the game (Vite dev server on port 5173)
npm run dev

# Run the AI tile generator (Node.js server on port 3456)
export FAL_AI_KEY=your-api-key
npm run tiles
```

Generate tiles in the browser at `http://localhost:3456`, then reload the game at `http://localhost:5173` to see them in action.

## Tech Stack

**Game Engine**
- Phaser 3 — 2D game framework with arcade physics, scene management, and tilemaps
- TypeScript — full type coverage across game logic, entities, and systems
- Vite — fast dev server with HMR and production bundling

**AI Asset Pipeline**
- fal.ai — cloud inference for SDXL, Flux Schnell, Flux Dev, and Stable Diffusion 3.5
- Node.js tile generator — browser UI at port 3456 for prompt crafting, model selection, and batch generation
- Wang tile tools — multiple algorithms (quadrant swap, Cohen search-based, diamond, quilt) for generating seamless 16-tile edge sets
- Sharp — server-side image processing for tile generation and blending

**Infrastructure**
- Docker + nginx Alpine — static production container
- k3s — Kubernetes deployment with ingress, TLS certificates, and namespace isolation
- GitHub Actions ready — build-push-deploy pipeline defined in VS Code tasks

## Project Structure

```
src/
  scenes/          BootScene, MenuScene, GameScene, GameOverScene
  entities/        Tower, Enemy, Hero, Projectile, Barricade
  systems/         MapGenerator, WaveManager, TerrainTransition, BlobTileset,
                   AbilitySystem, ComboSystem, SynergySystem, EconomyManager,
                   CityDecorator, CityRoadNetwork, WeatherSystem, SoundSystem
  data/            Towers, enemies, abilities, waves, synergies (data-driven)
  ui/              HUD, BottomBar
  utils/           TileColorExtractor, constants, helpers
tools/
  tile-generator/  Browser UI + Node.js proxy server for fal.ai image generation
  wang-tiles/      Wang tile set generators (7 algorithm variants)
k8s/               Kubernetes manifests (deployment, service, ingress, namespace)
public/assets/tiles/   AI-generated and procedural tile textures
```

## AI Tile Pipeline

The tile generation workflow is a two-tool pipeline:

1. **Generator** (`tools/tile-generator/`) — A dark-themed browser UI backed by a Node.js server that proxies requests to fal.ai. Supports multiple models (Fast SDXL, Flux Schnell, Flux Dev, SD 3.5) with live pricing. Generated images are saved as 1024x1024 PNGs to `public/assets/tiles/`.

2. **Game** (`src/`) — On boot, `BootScene` loads any AI-generated PNGs found in the tiles folder. `TileColorExtractor` samples pixel data to build palettes for procedural transition tiles. `BootScene` slices AI textures into crop sub-textures and `GameScene` picks per-cell variants (Wang tiles > crop variants > base) to eliminate repetition. Missing tiles fall back to procedural generation automatically.

Transition tiles (grass-to-water edges) are always procedural — they use corner-bitmask polygon fills with alpha blending so they blend seamlessly into whichever AI texture is loaded.

## Building & Deployment

```bash
# Build for production
npm run build

# Docker
docker build -t towerdefense .

# Deploy to k3s (requires kubeconfig)
bash scripts/deploy.sh
```

## License

MIT
