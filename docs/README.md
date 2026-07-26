# Vector Tower Defense — Project Overview

A browser-based tower defense game built with **Phaser 3** and **TypeScript**, featuring procedurally generated terrain with AI-generated tile textures from **fal.ai**. The game runs on **Vite** and deploys as a static Docker image to **k3s**.

## Tech Stack

**Frontend**
- Phaser 3 — game engine, arcade physics, scene management
- TypeScript — type-safe game logic
- Vite — dev server and bundler

**AI Asset Pipeline**
- fal.ai — text-to-image generation (SDXL, Flux, SD 3.5)
- Node.js tile generator server (`tools/tile-generator/server.mjs`)
- Wang tile algorithms (`tools/wang-tiles/`)
- Sharp — image processing

**Infrastructure**
- Docker + nginx — production container
- k3s — Kubernetes deployment with ingress + TLS

## Authoring Conventions

When writing portfolio or contributor docs for this project, use these custom tags:

```
<skill>Phaser 3</skill> <skill>TypeScript</skill> <skill>fal.ai</skill>
```

```
<highlight title="AI-Powered Terrain" shadow>
All terrain textures are generated via <skill>fal.ai</skill> using SDXL models.
Each tile gets a unique 48×48 crop from a 1024×1024 source for anti-repetition.
</highlight>
```

```
<github href="https://github.com/...">View on GitHub</github>
<website href="https://towerdefense.example.com">Play Online</website>
```

```
<webm src="./gameplay.mp4" start="2" max-width="600">
```

```
<linux> <windows> <macos> <firefox> <chrome>
```

```
<email>name@example.com</email> <linkedin href="...">LinkedIn</linkedin>
```

## Quick Author Checklist

- [ ] Start with calls to action: `<github>`, `<website>`, download buttons
- [ ] One `<highlight>` box mentioning core `<skill>` tags inline
- [ ] Group tech stack into logical sections (Frontend, Backend, Infra)
- [ ] Concrete descriptions: "uses Phaser 3 arcade physics" not "game engine"
- [ ] Keep under ~80 lines — this is a quick reference, not a manual
