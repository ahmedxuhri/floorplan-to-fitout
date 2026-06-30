# ArchVision — Full Codebase Review & Spatial Consistency Strategy

> **Date:** June 29, 2026
> **Scope:** Complete pipeline review — from 2D floor plan upload to AI-generated photorealistic renders — with focus on solving the multi-view spatial consistency problem.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [The Core Problem — Diagnosed](#the-core-problem--diagnosed)
3. [Architecture Deep Dive](#architecture-deep-dive)
4. [Root Cause Analysis — Why Rotating the Camera Breaks Everything](#root-cause-analysis--why-rotating-the-camera-breaks-everything)
5. [Solution Strategy — Three Tiers](#solution-strategy--three-tiers)
6. [Tier 1 — Immediate Wins (No New Infrastructure)](#tier-1--immediate-wins-no-new-infrastructure)
7. [Tier 2 — Structural Upgrade (Depth-Conditioned Generation)](#tier-2--structural-upgrade-depth-conditioned-generation)
8. [Tier 3 — The Correct Architecture (3D-First, AI-Second)](#tier-3--the-correct-architecture-3d-first-ai-second)
9. [Codebase Quality Observations](#codebase-quality-observations)
10. [Recommended Roadmap](#recommended-roadmap)

---

## Executive Summary

Your project has a well-thought-out vision and a surprisingly complete implementation across 10 phases. The pipeline from 2D floor plan → AI wall tracing → object identification → interactive labeling → Blender 3D scene → AI photorealistic rendering is functional and architecturally sound.

**However, your core dissatisfaction is well-founded and stems from a fundamental architectural limitation:**

> You are using a **2D image generation model** (Imagen via `generate_image`) to solve a **3D spatial consistency** problem. No amount of prompt engineering, reference images, or human-in-the-loop corrections can overcome this, because the AI model has no geometric memory between invocations. Each camera angle triggers an independent image generation that "hallucinates" a new scene from scratch.

The good news: you already have 80% of the right infrastructure. The Blender scene is the key asset. The fix is not to rebuild — it's to **restructure how the Blender output is consumed** and to **add depth-conditioned control** to the generation pipeline.

---

## The Core Problem — Diagnosed

### What Works

| Pipeline Step | Status | Quality |
|:---|:---|:---|
| Floor plan upload & display | ✅ Working | Good |
| AI wall tracing (Gemini Vision) | ✅ Working | Good with human correction |
| Object identification (Gemini Vision) | ✅ Working | Reasonable — dimensions approximate |
| Interactive object labeling | ✅ Working | Excellent UX |
| Camera click-to-place | ✅ Working | Good |
| Blender 3D scene construction | ✅ Working | **Strong** — PBR materials, proper geometry |
| Three.js quick preview | ✅ Working | Useful for orientation |
| First AI render (single angle) | ✅ Working | Generally good |
| **Rotating camera → second angle** | ❌ **Broken** | **Completely inconsistent** |
| Chat refinement consistency | ⚠️ Fragile | Degrades over turns |
| Direct Photo mode | ✅ Working | Good for single-shot edits |

### What Breaks

When you move the camera to a different angle:
1. **Furniture changes style** — the AI re-imagines every piece from scratch
2. **Materials shift** — wood tones, floor patterns, wall colors all change
3. **Objects appear/disappear** — items behind the camera may re-appear, or visible items may vanish
4. **Proportions warp** — room dimensions feel different between views
5. **Lighting changes** — the mood/atmosphere is entirely different per angle

---

## Architecture Deep Dive

### Current Data Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Current Pipeline                                │
│                                                                        │
│  2D Floor Plan                                                         │
│       │                                                                │
│       ▼                                                                │
│  Gemini Vision ──► Wall JSON + Object JSON ──► User Labels/Edits      │
│                                                    │                   │
│                                                    ▼                   │
│                                          Blender 3D Scene Builder      │
│                                          (blender_scene.py)            │
│                                                    │                   │
│                              ┌─────────────────────┼──────────────┐    │
│                              │                     │              │    │
│                              ▼                     ▼              ▼    │
│                         Camera A             Camera B        Camera C  │
│                         Render               Render          Render    │
│                              │                     │              │    │
│                              ▼                     ▼              ▼    │
│                      ┌──────────────┐  ┌──────────────┐ ┌──────────┐  │
│                      │   Imagen     │  │   Imagen     │ │  Imagen  │  │
│                      │(independent) │  │(independent) │ │(indepen.)│  │
│                      └──────────────┘  └──────────────┘ └──────────┘  │
│                              │                     │              │    │
│                              ▼                     ▼              ▼    │
│                         Image A              Image B         Image C   │
│                     (looks great)        (different room!) (chaos!)    │
└─────────────────────────────────────────────────────────────────────────┘
```

> [!CAUTION]
> **The critical flaw:** Each Imagen call is stateless. Images A, B, and C share NO geometric or visual memory. The Blender render provides spatial hints, but Imagen treats them as loose suggestions, not hard constraints.

### File-by-File Analysis

#### `server.js` (1,531 lines)

The server is well-organized with clear endpoint separation. Key observations:

- **AI invocation method**: All AI calls go through `runAgyCommand()` which spawns the `agy` CLI as a child process. This means every AI call is a fresh context — there is no persistent memory of previously generated imagery.
- **The `/chat` endpoint (line 431–584)**: This is the heart of the problem. It sends 3 reference images (Blender render, 2D plan, Three.js screenshot) + a text prompt to the AI. The AI generates an `imagePrompt` text, then a *second* AI call uses `generate_image` with that prompt + reference images. But `generate_image` is fundamentally text-to-image with loose reference conditioning — it does NOT lock geometry.
- **No scene state persistence between renders**: When Camera B is selected, the entire pipeline re-runs from scratch. The Blender render is regenerated (good), but the AI render is a completely new generation with no link to Camera A's output.
- **Sequential render queue (`blenderBusy` flag, line 14)**: Only one Blender render at a time. This is fine for now but will bottleneck multi-view workflows.

#### `blender_scene.py` (1,236 lines)

This is actually the **strongest part of the codebase**. Observations:

- **Excellent PBR material system** (lines 46–304): Wood, marble, steel, fabric, leather, glass, ceramic, tile, wall, foliage — all with procedural textures, proper roughness/specular values, and bump mapping. This is professional-grade.
- **Detailed furniture builders** (lines 508–872): Each furniture type (dining table, chair, bar stool, sofa, counter, stove, refrigerator, etc.) is built from multiple primitives with realistic proportions. This is *much* better than simple placeholder boxes.
- **Smart camera clipping** (lines 947–972): Walls too close to the camera or behind it are hidden — clever and necessary.
- **Door/window opening detection** (lines 976–1076): Walls are split into segments to accommodate openings. Sophisticated.
- **Proper coordinate mapping** (lines 306–314): Plan coordinates are correctly transformed to Blender world coordinates.
- **Render settings** (lines 1217–1226): Cycles CPU at 32 samples with denoising — reasonable for a structural reference render.

> [!IMPORTANT]
> **The Blender scene is geometrically accurate.** This is your most valuable asset. The problem is NOT that the 3D scene is bad — it's that the AI generation pipeline doesn't respect it strictly enough.

#### `index.js` (4,224 lines)

The frontend is monolithic but functional:

- **State management**: Global variables (`corners`, `walls`, `identifiedObjects`, `cameraPositions`, `lastBlenderRender`, etc.) — no framework, pure vanilla JS.
- **Camera system** (around lines 2500–2650): The render pipeline captures 3 screenshots (Blender render, 2D plan canvas, Three.js viewport) and sends all three as context. This is the right instinct — more context helps. But the AI still can't enforce geometric consistency from flat images alone.
- **Object position descriptions** (lines 2544–2570): Screen-space position hints (left/center/right) are computed and passed to the AI. This is a helpful heuristic but insufficient for precise spatial placement.
- **Chat refinement** (lines 3026–3091): Sends `lastBlenderRender` as context for ongoing chat. But `lastBlenderRender` gets overwritten with the AI's output image (line 3080), so spatial reference degrades over conversation turns.

#### `index.html` / `index.css`

Well-structured dark-theme UI with clear section separation. The dual-mode (CAD vs Direct Photo) switching is clean. CSS is comprehensive at ~30KB. No major issues here.

---

## Root Cause Analysis — Why Rotating the Camera Breaks Everything

The root cause can be stated precisely:

### 1. No Geometric Lock Between AI Generations

Imagen (and any text-to-image diffusion model) does not have a "geometry buffer." When you provide a Blender render as a reference image, the AI interprets it as a **style reference** and **composition guide**, not as a **hard spatial constraint**. The model is free to:
- Move furniture
- Change proportions
- Alter materials
- Re-imagine the lighting

### 2. Text Prompts Cannot Encode 3D Geometry

Your prompt engineering is extensive (lines 456–496 in server.js) — you specify wall positions, occlusion rules, and screen-space coordinates. But natural language is fundamentally unable to encode precise 3D spatial relationships. Saying "a table on the left" is ambiguous — the AI doesn't know if "left" means 1 meter or 5 meters from the wall.

### 3. Each Render is a New "Dream"

Diffusion models work by starting from noise and iteratively denoising. Each generation is a stochastic process — even with the same prompt and seed, different reference images (different camera angles) will produce wildly different results because the noise-to-signal path is different.

### 4. No Cross-View Attention Mechanism

Research models like MVRoom and SyncDreamer use **epipolar attention** — a mechanism that forces the model to check "what does this pixel look like from the other view?" during generation. Your current pipeline has no such mechanism. Each view is generated in complete isolation.

### 5. Blender Render Quality is "Too Good" to be a Control Signal

Paradoxically, your Blender renders are detailed enough that the AI treats them as a "competing vision" rather than a structural skeleton. A plain depth map or edge drawing would actually constrain the AI more effectively, because there's less for the model to disagree with.

---

## Solution Strategy — Three Tiers

> [!NOTE]
> These tiers are ordered by implementation complexity. You can implement Tier 1 immediately, Tier 2 within 1–2 weeks, and Tier 3 is the long-term correct architecture. Each tier is additive — they build on each other.

---

## Tier 1 — Immediate Wins (No New Infrastructure)

### 1A. Export Depth Maps from Blender (Not Just Color Renders)

**What:** Add a depth pass render to `blender_scene.py` alongside the color render.

**Why:** Depth maps are the universal language of 3D-to-2D spatial constraint. A depth map encodes exact spatial relationships without any ambiguity about style, color, or material. When fed to the AI as a reference, it says "this is where things ARE in 3D space" rather than "this is what things LOOK LIKE."

**How:**

```python
# Add after the main render (line ~1233 in blender_scene.py)

# ─── Depth Pass Render ───
scene.use_nodes = True
tree = scene.node_tree
tree.nodes.clear()

rl = tree.nodes.new('CompositorNodeRLayers')
normalize = tree.nodes.new('CompositorNodeNormalize')
output = tree.nodes.new('CompositorNodeOutputFile')
output.base_path = ''
output.file_slots[0].path = output_path.replace('.jpg', '_depth.png')
output.format.file_format = 'PNG'
output.format.color_depth = '16'
output.format.color_mode = 'BW'

tree.links.new(rl.outputs['Depth'], normalize.inputs[0])
tree.links.new(normalize.outputs[0], output.inputs[0])

bpy.ops.render.render(write_still=False)
```

Modify the `/blender-render` endpoint to return both the color render and the depth map. Send both to the AI.

### 1B. Add Normal Map Export

**What:** Alongside depth, render a normal map pass.

**Why:** Normal maps encode surface orientation — they tell the AI which direction each surface faces. This prevents the AI from "flattening" walls or rotating furniture faces incorrectly. Normal maps are more robust than depth maps for preserving edges and fine geometric detail.

### 1C. Freeze the "Style Anchor" From the First Render

**What:** When the first successful AI render is generated, extract a "style descriptor" and lock it for all subsequent renders from different angles.

**How:**

1. After the first AI render succeeds, make a Gemini Vision call:
   ```
   "Analyze this interior render and extract: exact floor material and color,
   exact wall material and color, lighting temperature and mood, furniture
   style vocabulary, and color palette. Return as a structured JSON style sheet."
   ```

2. Store this "style sheet" in session state.

3. For ALL subsequent renders (Camera B, Camera C, chat refinements), prepend the style sheet to the prompt:
   ```
   "MANDATORY STYLE LOCK — The following style parameters are FIXED and MUST NOT
   change across any view angle: [style sheet JSON]. Any deviation from these
   exact materials, colors, and lighting is UNACCEPTABLE."
   ```

**Impact:** This won't give you geometric consistency, but it will significantly reduce the "different room" feeling by locking colors, materials, and mood.

### 1D. Pass ALL Previous Renders as Context

**What:** When generating Camera B's render, include Camera A's AI output as a reference image alongside the Blender render.

**How:** Modify the `/chat` endpoint to accept an optional `previousRenders` array. When building the `generate_image` prompt, include:

```
"These are previously generated renders of the SAME room from different angles.
You MUST maintain identical furniture styles, materials, colors, and lighting.
Previous render from Camera A: [image path]
Now generate the view from Camera B using the Blender reference."
```

> [!WARNING]
> `generate_image` currently accepts a maximum of 3 ImagePaths. You're already using all 3 slots (Blender render, 2D plan, Three.js screenshot). You'll need to prioritize: **drop the Three.js screenshot** and replace it with the previous AI render. The Three.js preview adds the least value since the Blender render is strictly superior.

### 1E. Fix the lastBlenderRender Overwrite Bug

**What:** On line 3080 of `index.js`, the AI-generated image overwrites `lastBlenderRender`:
```javascript
lastBlenderRender = result.imageUrl;
```

This means that in subsequent chat turns, the "Blender render" reference is actually the previous AI hallucination, not the actual Blender output. Each turn drifts further from geometric truth.

**Fix:** Keep `lastBlenderRender` always pointing to the actual Blender output. Store the AI render in a separate variable (`lastAIRender`).

```javascript
// Line 3080 — Change from:
lastBlenderRender = result.imageUrl;

// To:
lastAIRender = result.imageUrl;
// And send lastAIRender separately in subsequent chat calls
```

---

## Tier 2 — Structural Upgrade (Depth-Conditioned Generation)

### 2A. Replace Imagen with Depth-Conditioned Diffusion (ControlNet)

**What:** Instead of using `generate_image` (which is essentially Imagen with loose reference conditioning), switch to a model that natively supports **ControlNet Depth** conditioning.

**Why:** ControlNet Depth takes your Blender depth map and uses it as a **hard spatial constraint** during the diffusion process. The model physically cannot generate pixels that violate the depth structure. This is the single most impactful change you can make.

**Options (ranked by ease of integration):**

| Provider | Model | ControlNet Support | API Complexity | Cost |
|:---|:---|:---|:---|:---|
| **Fal.ai** | FLUX.1 + ControlNet Depth | ✅ Native | Low (REST API) | ~$0.03/image |
| **Replicate** | SDXL + ControlNet | ✅ Native | Low (REST API) | ~$0.02/image |
| **Self-hosted** | ComfyUI + SDXL | ✅ Full control | Medium (Docker) | GPU cost only |
| **Vertex AI Imagen** | Imagen 4 | ❌ No ControlNet | Already using | $0.04/image |

**Recommended:** Start with **Fal.ai** — it has the simplest API, supports FLUX with ControlNet Depth out of the box, and requires zero infrastructure changes.

**Implementation outline:**

```javascript
// New function in server.js
async function generateWithDepthControl(colorRender, depthMap, stylePrompt, previousRender) {
  const response = await fetch('https://fal.run/fal-ai/flux/dev/image-to-image', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${process.env.FAL_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt: stylePrompt,
      image_url: colorRender,        // Blender color render as style reference
      controlnet: {
        path: "depth",               // ControlNet depth adapter
        image_url: depthMap,          // Blender depth render as spatial lock
        conditioning_scale: 0.85     // How strictly to follow depth (0.0-1.0)
      },
      strength: 0.75,                // How much to transform (lower = closer to input)
      num_inference_steps: 30,
      guidance_scale: 7.5
    })
  });
  return response.json();
}
```

### 2B. Multi-ControlNet: Depth + Normal + Canny Edges

**What:** Use multiple ControlNet adapters simultaneously for maximum spatial constraint.

**How:** ComfyUI and Fal.ai both support chaining multiple ControlNets:

```
Input: Blender Depth Map → ControlNet Depth (weight 0.8)
     + Blender Normal Map → ControlNet Normal (weight 0.5)
     + Blender Edge Render → ControlNet Canny (weight 0.3)
     + Text Prompt (style description)
     = Output: Photorealistic image locked to 3D geometry
```

**Impact:** With triple ControlNet conditioning, the AI cannot deviate from the Blender scene's geometry. This solves ~90% of the multi-view consistency problem because the geometry is literally locked by three independent spatial signals.

### 2C. Add a Blender Edge/Line Render Pass

**What:** Render a black-on-white edge pass from Blender (using Freestyle or Grease Pencil).

**Why:** Canny edge ControlNet is the most reliable at preserving architectural lines — wall edges, furniture outlines, door frames. It prevents the "melting walls" effect.

```python
# Add Freestyle edge rendering to blender_scene.py
scene.render.use_freestyle = True
scene.render.line_thickness = 1.5
# Configure freestyle line set for silhouette + crease edges
```

### 2D. IP-Adapter for Style Transfer Across Views

**What:** Use IP-Adapter (Image Prompt Adapter) to inject the style from Camera A's render into Camera B's generation.

**Why:** IP-Adapter extracts high-level visual features (color palette, material textures, lighting mood) from a reference image and injects them into the generation process. Unlike text prompts, this operates in visual feature space — it's much more precise.

**How:** Both ComfyUI and Fal.ai support IP-Adapter alongside ControlNet. The workflow becomes:

```
Camera A render (AI output)  → IP-Adapter (style injection)
Camera B Blender depth map   → ControlNet Depth (spatial lock)
Camera B Blender normal map  → ControlNet Normal (surface lock)
Text prompt (scene description) → Base model
= Camera B AI render (consistent with Camera A)
```

---

## Tier 3 — The Correct Architecture (3D-First, AI-Second)

> [!IMPORTANT]
> This is the architecture used by professional visualization studios in 2026. It fundamentally solves multi-view consistency by making the 3D scene the **single source of truth** and using AI only for **texture/material enhancement**.

### 3A. Upgrade Blender Scene to Production-Quality Rendering

**What:** Instead of using Blender as a "sketch" for AI to reinterpret, make the Blender renders beautiful enough to use directly (or with minimal AI enhancement).

**How:**
1. **Replace procedural materials with PBR texture sets**: Use free texture libraries (Poly Haven, AmbientCG) to apply real-world PBR textures (albedo + roughness + normal + displacement).
2. **Upgrade lighting**: Add HDRI environment maps for realistic ambient lighting. Your current 3-light setup (sun + 2 area fills) is good for structure but flat for photorealism.
3. **Increase render quality**: With denoising, even Cycles CPU at 64–128 samples produces near-photorealistic results in ~30–45 seconds per frame.
4. **Add post-processing in Blender's compositor**: Bloom, color grading, vignette, lens distortion — these "film look" effects close the gap between 3D render and photography.

**Impact:** If the Blender render is 90% photorealistic, the AI only needs to add 10% enhancement (softening edges, adding subtle atmosphere). This dramatically reduces the AI's ability to deviate from the scene.

### 3B. AI as Texture/Style Enhancer, Not Scene Generator

**What:** Change the AI's role from "generate a room from a sketch" to "make this already-good render look photorealistic."

**How:** Use img2img with **low denoising strength** (0.2–0.4) instead of generating from scratch. The pipeline becomes:

```
Blender high-quality render (Camera X)
    ↓
img2img (denoising strength 0.3)  ← "Photorealistic interior, warm lighting, 8K"
    ↓
Final output (95% Blender geometry + 5% AI texture enhancement)
```

At denoising strength 0.3, the AI can refine textures and add atmosphere but **cannot move furniture or change geometry**. This is the key insight.

### 3C. 3D Gaussian Splatting for Free-View Navigation

**What:** Instead of rendering individual camera angles, build a 3D Gaussian Splat from multi-view renders and let the user freely navigate.

**Why:** This eliminates the multi-view problem entirely. There are no "camera angles" — there's a continuous 3D representation that the user can explore from any position.

**Workflow:**

1. After the Blender scene is constructed, render 50–100 images from a systematic camera path (orbit + grid).
2. Train a 3DGS model using an open-source tool (Lichtfeld Studio, or PostShot free tier).
3. Display the splat in the browser using a WebGL viewer (SuperSplat, or Three.js with a Gaussian Splat loader).
4. The user gets a real-time, photorealistic walkthrough — no per-angle AI generation needed.

**Open-source tools:**
- **Autoshot** (Blender addon): Automates multi-view camera path + image export
- **Lichtfeld Studio**: Open-source 3DGS training
- **SuperSplat**: Web-based splat viewer/editor
- **3DGS Render Blender Addon** (KIRI Innovations): View splats inside Blender

### 3D. The Hybrid "Stylize Then Splat" Pipeline

The ultimate architecture combines Tier 2 and Tier 3:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Target Architecture                                 │
│                                                                        │
│  2D Floor Plan → AI Trace → User Edit → Blender 3D Scene              │
│                                              │                         │
│                              ┌────────────────┼────────────────┐       │
│                              │                │                │       │
│                              ▼                ▼                ▼       │
│                         View 1            View 2          View N       │
│                     Color + Depth     Color + Depth   Color + Depth    │
│                              │                │                │       │
│                              ▼                ▼                ▼       │
│                    ┌───────────────────────────────────────────────┐    │
│                    │     ControlNet Depth + IP-Adapter             │    │
│                    │     (Style locked from View 1's AI output)    │    │
│                    │     Denoising strength: 0.3–0.5              │    │
│                    └───────────────────────────────────────────────┘    │
│                              │                │                │       │
│                              ▼                ▼                ▼       │
│                         Styled 1          Styled 2        Styled N     │
│                     (consistent style, locked geometry)                │
│                              │                │                │       │
│                              └───────┬────────┘                │       │
│                                      ▼                                 │
│                          3D Gaussian Splatting Training                 │
│                                      │                                 │
│                                      ▼                                 │
│                          Interactive Free-View Walkthrough              │
│                          (WebGL, any angle, real-time)                  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Codebase Quality Observations

### Strengths

1. **Blender scene builder is excellent.** The PBR materials, furniture builders, wall opening detection, and camera clipping logic are production-quality code. This is a significant engineering asset.

2. **Smart human-in-the-loop design.** The wall correction UI, object labeling panel, and camera placement system are well-designed. You correctly identified that AI alone can't handle spatial tasks and added human verification at every critical step.

3. **Session management and SSE progress feedback** provide a professional UX — users know what's happening at each pipeline stage.

4. **The Direct Photo pipeline (Phase 10)** is a smart alternative workflow and well-implemented.

### Issues to Address

#### Critical

| Issue | Location | Impact |
|:---|:---|:---|
| `lastBlenderRender` is overwritten with AI output | `index.js:3080` | Spatial reference degrades over chat turns |
| No depth/normal map export from Blender | `blender_scene.py` | No structural control signal for AI |
| Each AI render is stateless | `server.js:528–561` | No consistency across views |
| Three.js screenshot uses a reference slot | `server.js:539` | Wastes one of 3 available image slots on low-value data |
| `generate_image` has no depth conditioning | Architectural | Fundamental limitation |

#### Moderate

| Issue | Location | Impact |
|:---|:---|:---|
| 85s timeout for `agy` CLI | `server.js:103` | Complex scenes may timeout |
| Sequential Blender renders | `server.js:14` | Bottleneck for multi-view generation |
| No validation of Blender exit status detail | `server.js:960–974` | Silent failures possible |
| Monolithic 155KB `index.js` | `cad/index.js` | Difficult to maintain/extend |
| All state in global variables | `cad/index.js:1–70` | Risk of state bugs |

#### Minor

| Issue | Location | Impact |
|:---|:---|:---|
| Temp file cleanup is in `finally` blocks but not comprehensive | `server.js` various | Disk space leak over time |
| Python resize uses string interpolation in shell | `server.js:319` | Potential path injection (minor, internal only) |
| No input validation on floor plan dimensions | `server.js:927–928` | Could crash Blender with bad values |

---

## Recommended Roadmap

### Phase A — Quick Fixes (1–3 days)

> **Goal:** Improve consistency with zero infrastructure changes.

- [ ] **A.1** Fix the `lastBlenderRender` overwrite bug (`index.js:3080`)
- [ ] **A.2** Extract style anchor from first AI render and lock it for subsequent renders
- [ ] **A.3** Pass previous AI renders as reference images for new camera angles
- [ ] **A.4** Drop Three.js screenshot from reference images; replace with previous AI render
- [ ] **A.5** Strengthen prompt with explicit material/color specifications from the style anchor

### Phase B — Depth Control (1–2 weeks)

> **Goal:** Add geometric locking via depth-conditioned generation.

- [ ] **B.1** Add depth pass render to `blender_scene.py`
- [ ] **B.2** Add normal map pass render to `blender_scene.py`
- [ ] **B.3** Add Freestyle edge pass render to `blender_scene.py`
- [ ] **B.4** Integrate Fal.ai or Replicate API for ControlNet Depth generation
- [ ] **B.5** Replace `generate_image` calls with depth-conditioned API calls
- [ ] **B.6** Add IP-Adapter support for cross-view style transfer
- [ ] **B.7** Implement multi-view batch generation (generate all cameras in one pipeline run)

### Phase C — Production Quality (2–4 weeks)

> **Goal:** Make Blender renders beautiful enough to minimize AI intervention.

- [ ] **C.1** Download and integrate PBR texture sets for all materials (Poly Haven)
- [ ] **C.2** Add HDRI environment lighting to Blender scene
- [ ] **C.3** Upgrade render settings (128 samples, better denoising)
- [ ] **C.4** Add Blender compositor post-processing (color grading, bloom)
- [ ] **C.5** Switch AI role from "generator" to "enhancer" (img2img, low denoising)
- [ ] **C.6** Implement 3D Gaussian Splatting pipeline for free-view walkthrough

### Phase D — Polish (ongoing)

- [ ] **D.1** Refactor `index.js` into modular ES modules
- [ ] **D.2** Add comprehensive input validation
- [ ] **D.3** Implement proper job queue (Redis/Bull) for render pipeline
- [ ] **D.4** Add automated tests for coordinate transformations
- [ ] **D.5** Implement project gallery and comparison views

---

> [!TIP]
> **Start with Phase A.1 and A.5** — fixing the `lastBlenderRender` overwrite and adding a style anchor will give you the most noticeable improvement with the least effort. Then move to **Phase B.1–B.5** for the transformative change (depth-conditioned generation).

---

*This review was prepared after a full read of all source files (`server.js`, `blender_scene.py`, `index.js`, `index.html`, `index.css`, `masterplan.md`) and extensive research into the state of the art in multi-view consistent AI generation (MVRoom, ControlNet, 3D Gaussian Splatting, IP-Adapter, ComfyUI workflows, and depth-conditioned diffusion models) as of June 2026.*
