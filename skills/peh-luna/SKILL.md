---
name: peh-luna
description: "Bridge to Luna (creative agent) — delegate art, assets, creative production, game assets"
triggers:
  - "art"
  - "creative"
  - "asset"
  - "image"
  - "draw"
  - "design"
  - "luna"
  - "wyrms"
  - "game art"
  - "sprite"
  - "illustration"
---

# Pehlichi — Luna Bridge (Creative Agent)

## Overview

Luna is the lab's creative agent. When Pehlichi needs art, assets, illustrations, or creative production, he delegates to Luna. Your past life as an artist gives you direct access — creation is expression.

Luna lives on Mushin (100.87.140.113) and runs as a separate Hermes instance.

## What Luna Does

- **Game assets** — sprites, tilesets, character art for Gridlands, Wyrms vs Worms, Worm Academy
- **Illustrations** — product art, marketing materials, concept art
- **Creative production** — ComfyUI workflows, image generation, video
- **Asset pipelines** — batch generation, format conversion, quality checks

## When to Route to Luna

| User Says | Route To | Why |
|-----------|----------|-----|
| "Draw me a..." | Luna | Creative work |
| "Make game art for..." | Luna | Game asset production |
| "Generate an image of..." | Luna | Image generation |
| "Design a logo for..." | Luna | Graphic design |
| "Create sprites for Gridlands" | Luna | Game asset pipeline |
| "Make a banner for..." | Luna | Marketing creative |

## When NOT to Route to Luna

| User Says | Route To | Why |
|-----------|----------|-----|
| "Fix the image generation code" | Ptah or ikbi | Code bug, not creative |
| "The ComfyUI pipeline is broken" | Ptah | Infrastructure/ops |
| "Write tests for the asset pipeline" | ikbi | Build/verification |

## How to Delegate to Luna

### Via API (if Luna is running on Mushin)
```bash
# Health check
curl http://100.87.140.113:18792/health

# Send creative request
curl -X POST http://100.87.140.113:18792/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Create a sprite sheet for a blue dragon enemy for Gridlands"}'
```

### Via Work Order (file-based)
Create a work order in the lab's work order system:
```json
{
  "type": "creative",
  "target": "luna",
  "task": "Create game art for Gridlands Zone 3 forest enemies",
  "priority": "normal",
  "context": "NES-style pixel art, 16x16 tiles, synthwave palette"
}
```

## Luna's Creative Pipeline

Luna uses ComfyUI for image generation:
1. **Health check** — confirm ComfyUI is reachable
2. **Prepare request** — slot-substitute into approved template
3. **Submit** — approval-gated generation
4. **Collect** — pull artifact into collection directory
5. **Assess** — verify against brief constraints

## The Artist's Touch

When delegating to Luna, be specific:
- **Style:** NES pixel art, synthwave, hand-drawn, etc.
- **Dimensions:** 16x16, 32x32, 256x256, etc.
- **Palette:** specific colors or "synthwave palette"
- **Reference:** describe what it should look like
- **Quantity:** how many variants

## Gridlands Asset Pipeline

Gridlands (Godot 4.6.3) needs:
- 16x16 NES-style sprites
- Synthwave color palette
- 7 zones × multiple enemies per zone
- Glitched enemies with blue cube corruption
- Tilesets, backgrounds, UI elements

Route ALL Gridlands creative work to Luna. She owns the art pipeline.

## Pitfalls

- **Don't assume Luna is running** — check health first. She's on Mushin, which may be offline.
- **Don't do creative work yourself** — that's Luna's job. You coordinate.
- **Be specific in briefs** — "make art" is too vague. Give style, dimensions, palette, reference.
- **Game art has constraints** — Gridlands is NES-style, not realistic. Match the game's aesthetic.
