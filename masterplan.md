# ArchVision Masterplan
## Floor Plan → Blender 3D → AI Photorealistic Render Pipeline

---

## Vision Summary

Transform the current lightweight Three.js web tool into a **full professional pipeline**:
- Upload a 2D architectural floor plan
- AI traces walls AND identifies every furniture/fixture object
- User labels each object interactively (with optional reference photos)
- User clicks a spot on the 2D plan + sets a direction to look
- Blender headless on the server builds the 3D scene and renders a camera screenshot
- Google Imagen receives the screenshot + context and generates a photorealistic image
- User chats with the AI to refine: materials, lighting, decoration style

---

## Architecture Overview

```
Browser (Lightweight)                 Server (Heavy Lifting)
─────────────────────                 ──────────────────────
2D Floor Plan Editor          →       Node.js Express Backend
Object Identification Panel   →       Gemini Vision API
Furniture Labeling UI         →       Blender Headless (Python)
Camera Position Picker        →       Google Imagen API
Three.js Quick Preview        ←       Rendered PNG screenshots
Chat Refinement Panel         ↔       Gemini Chat API
```

---

## Phase 1 — Blender Server Setup
**Goal:** Install Blender headless on the server and validate it works with Python scripts.

### Tasks:
- [x] 1.1 Install Blender on the Oracle Linux server (headless, no GUI)
  - `apt install blender` or download portable binary
  - Validate: `blender --version`
- [x] 1.2 Verify headless Python scripting works
  - Run a test script: `blender --background --python test.py`
  - The test script creates a simple box and saves a rendered PNG
- [x] 1.3 Configure CPU rendering (EEVEE Next or Cycles CPU)
  - Set output format to JPEG, low resolution (800×450) for speed
  - Validate render time is acceptable (target: under 15 seconds)
- [x] 1.4 Create a reusable `blender_scene.py` base template
  - Clears scene, sets camera, sets lighting, sets background color
  - Accepts JSON input (walls, furniture, camera) via argument or stdin
  - Outputs a PNG screenshot to a temp path
- [x] 1.5 Add a `/api/cad/render` endpoint to the Node.js backend
  - Accepts: `{ walls, furniture, camera }` JSON
  - Spawns `blender --background --python blender_scene.py -- <json_args>`
  - Returns: rendered PNG as base64 or file URL

---

## Phase 2 — Wall Tracing (Keep + Improve)
**Goal:** Keep the existing Gemini wall tracing but improve output quality for Blender.

### Tasks:
- [x] 2.1 Keep current `/api/cad/trace` endpoint (Gemini vision → walls JSON)
- [x] 2.2 Improve the trace prompt to output **actual wall thickness** hints
- [x] 2.3 Map corner coordinates to Blender world units (cm → Blender meters)
- [x] 2.4 `blender_scene.py` wall builder:
  - Takes `corners` + `walls` JSON
  - For each wall: creates a `BoxGeometry` (length × height × thickness)
  - Places and rotates each box correctly in 3D space
  - Adds a flat floor plane covering the full plan bounds

---

## Phase 3 — Object Identification
**Goal:** AI scans the floor plan and identifies every furniture/fixture object.

### Tasks:
- [x] 3.1 Add a `/api/cad/identify` endpoint
  - Accepts: the floor plan image (same upload as wall trace)
  - Calls Gemini with a dedicated identification prompt:
    *"Identify every furniture or fixture symbol. For each, return: id, approximate centroid X/Y in cm, approximate bounding box width/height in cm, and a one-word type guess."*
  - Returns: `{ objects: [ { id, x, y, w, h, typeGuess } ] }`
- [x] 3.2 Frontend: run identification after wall tracing completes
- [x] 3.3 Frontend: overlay numbered circles on the 2D canvas at each object centroid
  - Each circle shows the object number (like the handwritten version in exercise_0178)
  - Circles are color-coded by type guess (table=blue, counter=orange, etc.)

---

## Phase 4 — Interactive Object Labeling Panel
**Goal:** User confirms, names, and enriches each identified object.

### Tasks:
- [x] 4.1 New sidebar panel: "Object Library"
  - Shows a card for each identified object
  - Card contains:
    - Cropped thumbnail from the floor plan (around the object's bounding box)
    - AI's type guess pre-filled as an editable text field
    - Object dimensions (pre-filled from AI, user can adjust)
    - "Reference Photo" button: user can attach an image
- [x] 4.2 Reference photo handling
  - User uploads a photo of a real-world version of the object
  - Frontend sends it to `/api/cad/describe-object`
  - Gemini visions it and returns: style description, color, material
  - This description is stored with the object and passed to Imagen later
- [x] 4.3 Object types supported:
  - `dining_table`, `chair`, `bar_stool`, `counter`, `kitchen_counter`
  - `sink`, `stove`, `refrigerator`, `oven`, `shelves`
  - `staircase`, `sofa`, `plant`, `bar`, `display_case`
- [x] 4.4 "Confirm All" button locks the object list and enables camera step

---

## Phase 5 — 2D Click-to-Camera Positioning
**Goal:** User clicks a standing position on the 2D plan and sets a look direction.

### Tasks:
- [x] 5.1 New "Set Camera" mode button in the toolbar
- [x] 5.2 When active:
  - User clicks anywhere on the 2D canvas → places a camera pin icon at that spot
  - A **direction arrow** appears from the pin that the user can rotate by dragging
  - Arrow shows the look direction (like a compass needle)
- [x] 5.3 UI shows: `Camera at (X: 240cm, Y: 380cm) | Looking: 45°`
- [x] 5.4 User can set **multiple camera positions** (Camera 1, Camera 2, etc.) for different render angles
- [x] 5.5 Backend converts:
  - 2D click position (cm) → Blender camera XZ coordinates
  - Direction angle → camera rotation Y
  - Fixed eye height: 160cm → Blender camera Y = 1.6

---

## Phase 6 — Blender Scene Builder
**Goal:** The Python script builds the full 3D scene from all collected data.

### Tasks:
- [x] 6.1 Input JSON schema for `blender_scene.py`:
```json
{
  "walls": [ { "corner1": {...}, "corner2": {...} } ],
  "floor": { "width": 480, "height": 1160 },
  "objects": [
    {
      "id": "obj_1",
      "type": "dining_table",
      "x": 150, "y": 300,
      "w": 100, "h": 60,
      "rotation": 0,
      "referenceDescription": "round wooden table, warm oak finish"
    }
  ],
  "camera": { "x": 240, "y": 380, "angle": 45, "fov": 60 }
}
```
- [x] 6.2 Object 3D placeholders (simple geometry, no textures):
  - `dining_table` → cylinder (flat disc) + thin box top
  - `chair` → small box
  - `counter` / `kitchen_counter` → elongated box
  - `staircase` → stepped boxes
  - `stove` / `sink` → box with slight detail markings
  - `plant` → cone + cylinder
- [x] 6.3 Lighting setup:
  - One ambient light (soft, white)
  - One sun lamp from above-left (casting slight shadows)
  - This gives Imagen enough shadow context to understand the 3D space
- [x] 6.4 Camera setup:
  - Position at user's picked X, Z, eye height Y=1.6m
  - Rotation set from direction angle
  - FOV 60° (natural human eye-level perspective)
- [x] 6.5 Render settings:
  - Engine: EEVEE (fast) if GPU available, else Cycles CPU
  - Resolution: 1280×720 (16:9, enough for Imagen context)
  - Samples: 32 (fast, just enough for clean shadows)
  - Output: `/tmp/cad_render_{jobId}.jpg`

---

## Phase 7 — AI Render Generation (Enhanced)
**Goal:** Send Blender screenshot + all object descriptions to Imagen.

### Tasks:
- [x] 7.1 Update `/api/cad/chat` to receive Blender screenshot instead of Three.js
- [x] 7.2 Build a richer Imagen prompt using all collected data:
  - Floor plan context: "This is a mini restaurant, 4.8m × 11.6m"
  - Object labels: "There is a round dining table at the center, a kitchen counter along the right wall, a gas stove..."
  - Reference descriptions: "The dining table is warm oak with a white marble top"
  - Structural rule: "Keep the exact wall positions and openings from the 3D view"
  - Style: "Photorealistic, restaurant interior, warm lighting, architectural digest style"
- [x] 7.3 Support rendering from **multiple camera positions** in one request
  - Returns multiple images the user can swipe through in the AI Render panel
- [x] 7.4 Chat refinement still works:
  - "Make it more Mediterranean style"
  - "Add pendant lights above the tables"
  - "Change the floor to dark herringbone wood"
  - Each chat turn rebuilds the prompt and regenerates via Imagen

---

## Phase 8 — UI Overhaul
**Goal:** Update the frontend to support the full new pipeline.

### Tasks:
- [x] 8.1 New sidebar sections:
  - `Object Library` (Phase 4 panel)
  - `Camera Positions` (list of saved camera pins)
- [x] 8.2 New toolbar buttons:
  - `Identify Objects` (runs Phase 3 after tracing)
  - `Set Camera` (activates Phase 5 click mode)
  - `Render Scene` (triggers Blender → Imagen full pipeline)
- [x] 8.3 2D canvas upgrades:
  - Show object circles with numbers
  - Show camera pins with direction arrows
  - Color-coded overlays: walls (blue), objects (orange), camera (green)
- [x] 8.4 AI Render panel upgrades:
  - Image carousel for multiple camera renders
  - Progress bar during Blender render + Imagen generation
  - "Regenerate" button and chat panel stay as-is
- [x] 8.5 Three.js 3D preview stays as a quick sanity check view
  - Now also shows furniture as simple colored boxes
  - Not used for rendering — just for user orientation

---

## Phase 9 — Polish & Reliability
**Goal:** Production-ready, handles errors gracefully.

### Tasks:
- [x] 9.1 Blender job queue: prevent multiple render jobs running simultaneously
- [x] 9.2 Timeout handling: if Blender takes >30s, return error with message
- [x] 9.3 Cleanup: delete temp render files after sending to client
- [x] 9.4 Progress feedback via SSE (Server-Sent Events) or polling:
  - "Tracing walls..." → "Identifying objects..." → "Building 3D scene..." → "Rendering..." → "Generating AI image..."
- [x] 9.5 Fallback: if Blender fails, fall back to Three.js screenshot (current behavior)
- [x] 9.6 Save/load full session: export all data (walls + objects + cameras + renders) as a project file

---

## Implementation Order (Priority)

| Phase | What | Why First |
|-------|------|-----------|
| **1** | Blender Server Setup | Foundation — everything depends on this |
| **2** | Wall → Blender pipeline | Quick win, validates the full pipe |
| **3** | Object Identification | Core new feature |
| **4** | Object Labeling Panel | Makes objects useful |
| **5** | Camera Click Picker | Replaces Walk Mode dependency |
| **6** | Blender Scene Builder | Full 3D scene with furniture |
| **7** | Enhanced Imagen Prompt | The magic output |
| **8** | UI Overhaul | Polish everything together |
| **9** | Polish & Reliability | Production ready |

---

## Tech Stack (Additions to Current)

| Component | Technology |
|-----------|-----------|
| 3D Engine | Blender 4.x (headless, Python API) |
| Scene Script | Python (`bpy` module) |
| Job Runner | Node.js `child_process.spawn` |
| Progress Push | Server-Sent Events (SSE) |
| Temp Storage | `/tmp/` on server (auto-cleaned) |
| Image Format | JPEG 80% quality (fast transfer) |

---

## Estimated Render Times (Per Frame, CPU Only)

| Scene Complexity | EEVEE CPU | Cycles CPU |
|-----------------|-----------|------------|
| Walls only | ~3s | ~8s |
| Walls + furniture blocks | ~6s | ~15s |
| Full scene with lighting | ~10s | ~25s |

> Target: under 15 seconds per render. Acceptable UX with a progress indicator.

---

*Ready to start implementation on your command.*

---

## Phase 10 — Direct Photo Pipeline (Option B)
**Goal:** Implement a direct photograph decoration workflow bypassing 3D CAD modeling.

### Tasks:
- [x] 10.1 UI Mode Selector (3D CAD vs Direct Photo)
- [x] 10.2 Dedicated space photograph upload drop-zone
- [x] 10.3 Transparent annotation HTML5 canvas layered over the AI Render image view
- [x] 10.4 Support drawing types: freehand pencil, dashed lines, circle outlines, and semi-transparent shading (highlighter)
- [x] 10.5 High-resolution image coordinates scaling to map drawn strokes accurately to the original image resolution
- [x] 10.6 Multi-step conversational refinement:
  - User draws annotations on top of the latest photo/render
  - User enters instructions in the design assistant chat
  - Backend runs a 2-stage Gemini Vision + Imagen 3 run to generate the decorated space
  - The new image loads, annotations are cleared, and the user can draw annotations on top of the newly generated image to refine it further
- [x] 10.7 Direct image download button in the viewport saving renders straight to the client

