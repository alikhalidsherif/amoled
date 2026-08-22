# AMOLED / `.amo` System — Master Implementation Plan

> **Status:** Approved plan, ready for implementation.
> **How to use this file:** Implement one phase at a time, top to bottom. Do not skip ahead.
> Each phase ends with acceptance criteria that must pass before starting the next phase.
> After each phase (or any suspicious change), return to the reviewing agent with a diff summary.

---

## Table of contents

- [0. Context — what exists today](#0-context)
- [1. What we are building](#1-goal)
- [2. Non-negotiable architectural rules](#2-rules)
- [3. Decided technical choices](#3-decisions)
- [4. Final repository shape](#4-repo-shape)
- [5. The `.amo` format v1 specification](#5-format)
- [6. Implementation phases](#6-phases)
  - [Phase 1 — Refactor boundaries](#phase-1)
  - [Phase 2 — `.amo` v1 format](#phase-2)
  - [Phase 3 — Player + first real scene](#phase-3)
  - [Phase 4 — Animation & central clock](#phase-4)
  - [Phase 5 — Expression language](#phase-5)
  - [Phase 6 — Compositing](#phase-6)
  - [Phase 7 — Per-scene AMOLED configuration](#phase-7)
  - [Phase 8 — Quality negotiation system](#phase-8)
  - [Phase 9 — Generator](#phase-9)
  - [Phase 10 — GPU procedural scenes](#phase-10)
- [7. Testing strategy](#7-testing)
- [8. Conventions for all new code](#8-conventions)
- [9. Known risks and traps](#9-risks)

---

<a name="0-context"></a>
## 0. Context — what exists today

This repository (`px.ali.et`) is a **standalone Diamond PenTile AMOLED subpixel
simulator**: plain browser JavaScript, no bundler, no package.json, global-scope
IIFEs attaching to a `window.AMOLED` namespace, loaded in fixed script order by
`index.html`. Deployed as static files via nginx-alpine Docker.

### Key existing files and their roles

| File | Role |
|---|---|
| `src/config.js` | `AMOLED.DEFAULT_ENGINE_CONFIG` — frozen global defaults object |
| `src/frame-buffer.js` | `AMOLED.FrameBuffer` — immutable packed-RGB buffer wrapper |
| `src/diamond-pentile-geometry.js` | `AMOLED.DiamondPentileGeometry` — CPU lattice builder (`rebuild()`, `subpixels[]`, `metrics`, `latticeOriginX/Y`) |
| `src/amoled-gpu-renderer.js` | `AMOLED.GPUPentileSimulator` — WebGL2 physical-emitter pipeline (the main renderer) |
| `src/amoled-renderer.js` | `AMOLED.AMOLEDRenderer` — Canvas 2D fallback (approximate) |
| `src/patterns.js` | `AMOLED.createTestPattern(w,h)` — placeholder content generator |
| `src/media-loader.js` | `AMOLED.ClientMediaLoader` — image/GIF/video decode + playback via `setInterval` |
| `src/gifuct.js` | Vendored gifuct-js GIF decoder (`global.gifuct`) |
| `src/app.js` | Demo app wiring: UI bindings, adaptive quality governor, test GIF loading |
| `index.html` | Loads scripts in dependency order; contains demo UI panel |
| `tests/lattice-parity.js` | Node script verifying CPU lattice == shader analytic lattice. **MUST KEEP PASSING** |

### The two boundaries everything depends on

The renderers expose an identical interface:

```js
sim.loadFrameBuffer(width, height, rgbData)  // packed RGB Uint8ClampedArray, w*h*3
sim.updateConfig(partialConfig)              // runtime parameter mutation
sim.requestRender()                          // coalesced rAF render
sim.getStats()                               // engine/grid/frame info
sim.destroy()
```

Everything new in this plan feeds those methods. **They are stable API. Do not break them.**

### Facts that matter (from the codebase audit)

1. The GPU pipeline is 5 passes: emission (supersampled, HDR RGBA16F when
   `EXT_color_buffer_float`) → bloom extraction (quarter res) → separable blur ×2 →
   composite + sRGB encode to screen. All intermediate math is linear-light.
2. Rendering is demand-driven: `requestRender()` coalesces via rAF. Static content
   already renders exactly once. Preserve this property everywhere.
3. `updateConfig()` splits params into two classes:
   - **uniform-only** (applied next frame, zero resource churn): `emitterGamma`,
     `redMaxOutput/greenMaxOutput/blueMaxOutput`, `redSigma/greenSigma/blueSigma`,
     `opticalSpill`, `activeLevel`, `inactiveLevel`,
     `bloomThreshold/bloomPower/bloomIntensity/bloomRadius`
   - **resize-triggering** (recreate 3 render-target FBOs): pitch family
     (`pixelScale/autoPixelScale/minPixelScale/maxPixelScale/targetLogicalWidth/targetLogicalHeight`),
     geometry ratios (`rowPitchFactor/blackMatrixRatio/greenSizeRatio/diamondSizeRatio`),
     `supersample`, `maxInternalPixels`, `maxDevicePixelRatio`
4. Three uncoordinated loops exist today: per-renderer rAF, media-loader
   `setInterval`, and the adaptive governor's own rAF counter + interval inside
   `app.js`. The governor destructively mutates shared config.
5. Duplicated/inconsistent config fallbacks exist (e.g. shader-uniform inline
   fallback `redSigma 0.45` vs config default `0.55`; bloomRadius fallback 12 vs
   config 16; supersample clamp fallback 2 vs config 1). Phase 1 removes these.
6. Hard-coded constants live inside GLSL (`aa=0.75`, halo split `0.65/0.35`,
   near-lobe sigma scale `0.16`, reach multipliers `3.0/3.5`, margin padding,
   fixed 13-tap blur). Phase 7 promotes them to config.
7. The Canvas 2D fallback ignores most physical params and mixes colors in gamma
   space. That is acceptable — document it as approximation-only; do NOT chase parity.
8. nginx cache rule (`nginx.conf:12`) covers js/css/images but not `.amo`.
9. New modules must remain loadable in bare Node (see conventions §8) so unit
   tests run without a browser.

---

<a name="1-goal"></a>
## 1. What we are building

Three independent products sharing one codebase:

```text
┌─────────────────────┐      ┌───────────┐      ┌─────────────────────┐      ┌─────────────────────┐
│  .amo GENERATOR     │      │  .amo     │      │  .amo PLAYER        │      │  AMOLED ENGINE      │
│                     │      │  FILE     │      │                     │      │                     │
│ create/edit scenes  │ ──▶  │ scene.amo │ ──▶  │ parse               │ ──▶  │ PenTile             │
│ preview             │      │           │      │ load assets         │      │ emitter physics     │
│ export .amo         │      │           │      │ evaluate timeline   │      │ gamma/spill/bloom   │
└─────────────────────┘      └───────────┘      │ render scene        │      │ GPU/CPU renderer    │
                                                └─────────────────────┘      └─────────────────────┘
```

Conceptual separation:

> **The `.amo` file describes WHAT the display should be doing.**
> **The AMOLED engine describes HOW a physical AMOLED display produces pixels.**

A scene says *"green mist drifting"* and separately *"this display has gamma 1.55,
wide optical spill, subdued blue emitters"*. The display itself becomes part of
each scene's art direction.

The portfolio is merely the first consumer:

```js
await amoBackground.load("/scenes/projects.amo");
```

And `px.ali.et` remains the standalone workshop/test environment for the engine.

---

<a name="2-rules"></a>
## 2. Non-negotiable architectural rules

These are treated as hard rules for every phase:

1. **Dependency direction:** `generator → .amo → player → engine`. The engine
   must never know `.amo`, scenes, timelines, portfolios, or navigation exist.
   The player consumes the engine through its public boundary only.
2. **Preserve `loadFrameBuffer(w,h,data)` / `updateConfig(cfg)` / `requestRender()`.**
   They are the compatibility boundary between scene system and physics engine.
3. **Art direction vs performance:** the quality/performance system may only
   modify *quality variables* (resolution, supersampling, FPS, DPR cap).
   It must NEVER modify artistic/display variables (gamma, spill, bloom,
   maxOutput, sigma, brightness, pentile geometry).
4. **Static scenes must truly be static.** If a scene has no time-dependent
   values: parse → rasterize once → `loadFrameBuffer` once → render once → stop.
   No rAF loop.
5. **Never trust a `.amo` file.** Everything is validated and clamped. NaN,
   Infinity, absurd resolutions, unknown types → reject or clamp at parse time.
6. **Resolution independence.** Scene coordinates are normalized `0→1`.
   The same `.amo` renders identically at 160×90, 320×180, 640×360.
   The format must never require high-resolution rendering.
7. **Determinism.** Same `.amo` + same resolution + same time (+ same seed)
   = same output bytes. No `Math.random()` in scenes; seeded PRNG only.
8. **CPU first, GPU later.** All rasterization/expression evaluation starts on
   CPU feeding the existing framebuffer upload path. GPU-native paths only
   arrive in Phase 10, behind the same format.
9. **Keep the demo working.** `index.html` + existing UI keeps functioning until
   explicitly replaced in Phase 3+ steps. No big-bang rewrites.
10. **No build step.** No bundler, no transpiler, no npm install required to
   develop or deploy. Native browser features only.

---

<a name="3-decisions"></a>
## 3. Decided technical choices

These decisions have been made. Do not relitigate them during implementation.

### 3.1 Module format: native ES modules, hybrid migration

- **All NEW code** (`src/scene/`, `src/player/`, tests' importable modules) uses
  native ES modules (`import`/`export`), loaded from `index.html` via
  `<script type="module" src="...">`. No bundler. Every WebGL2-capable browser
  supports ESM; nginx serves it statically.
- **Existing engine files stay as global-IIFEs for now.** This works because of
  Rule 1: the player never imports engine internals — it receives a renderer
  instance and calls its public methods. Migrating engine files to ESM may
  happen later (optional cleanup in Phase 10+) without touching the scene system.
- Boot flow becomes: engine IIFE scripts load by classic `<script>` tags → one
  `<script type="module">` imports player modules and hands them `window.AMOLED`
  renderer constructors.

### 3.2 Repo layout: everything in this repository

Engine, player, scenes, and (eventually) the generator live here together.
Simplest sharing of parser/runtime between generator preview and production.

### 3.3 `.amo` = JSON with a `.amo` extension (v1)

No custom syntax yet. A prettier surface syntax can compile to the same internal
representation later. Keeps parsing trivial, validation centralized.

### 3.4 Display-parameter animation classes

Defined in the validator from day one (see §5.6):

- **`animatable`** (uniform-only under the hood): timeline keyframes allowed in v1.
- **`structural`** (resize-triggering under the hood): set only at scene load in v1.
  Animating these is explicitly rejected by the validator until FBO-reallocation
  optimization lands.

### 3.5 Performance expression budget (v1)

Guaranteed smooth target: ONE animated expression layer at ≤320×180 @ 30fps.
Multiple simultaneously-animated expression layers are documented as "may need
the Phase 10 GPU path". The validator warns (does not reject) above the budget.

---

<a name="4-repo-shape"></a>
## 4. Final repository shape

```text
amoled-client/
│
├── index.html                  # updated incrementally; demo UI until replaced
├── styles/
│   ├── demo.css                # existing demo styling
│   └── player.css              # (Phase 3) minimal player chrome if needed
│
├── src/
│   ├── engine/                 # ← Phase 1 moves existing files here UNCHANGED
│   │   ├── config.js
│   │   ├── frame-buffer.js
│   │   ├── diamond-pentile-geometry.js
│   │   ├── amoled-gpu-renderer.js
│   │   └── amoled-renderer.js
│   │
│   ├── scene/                  # ES modules — pure logic, DOM-free where possible
│   │   ├── parser.js           #   .amo text → raw object → SceneDefinition
│   │   ├── validator.js        #   schema checks, clamping, animation-class rules
│   │   ├── defaults.js         #   single source of normalized default values
│   │   ├── expression.js       #   tokenizer/parser/AST/compiler (Phase 5)
│   │   ├── rasterizer.js       #   SceneDefinition + t → RGB buffer (Phase 2+)
│   │   ├── compositor.js       #   layers, blend modes (Phase 6)
│   │   ├── assets.js           #   asset resolution/loading/caching (Phase 3+)
│   │   └── prng.js             #   seeded deterministic random (Phase 5)
│   │
│   ├── player/                 # ES modules — DOM-aware orchestration
│   │   ├── amoplayer.js        #   public API: load/play/pause/stop/destroy
│   │   ├── runtime.js          #   central clock, scheduling, static detection
│   │   ├── timeline.js         #   duration/loop/keyframe interpolation (Phase 4)
│   │   ├── quality.js          #   quality negotiation (extracted governor, Phase 8)
│   │   └── cache.js            #   parsed-scene / decoded-asset / rendered-frame caches
│   │
│   ├── media-loader.js         # stays; repurposed as asset decoder (Phase 4)
│   ├── patterns.js             # stays (test pattern)
│   ├── gifuct.js               # stays untouched
│   └── app.js                  # shrinks over phases; eventually thin bootstrap only
│
├── generator/                  # ← Phase 9 only. Nothing before then.
│
├── scenes/                     # .amo files + sibling assets (same-origin)
│   ├── gradient.amo
│   ├── image.amo
│   └── procedural.amo
│
├── assets/                     # existing icons + future scene assets
├── tests/                      # see §7
├── Dockerfile / docker-compose.yml / nginx.conf
└── PLAN.md                     # this file
```

Exact directory names aren't sacred; **the boundaries are** (Rule 1).

---

<a name="5-format"></a>
## 5. The `.amo` format v1 specification

JSON file, extension `.amo`, served as `application/octet-stream` (fine — the
player parses text itself).

### 5.1 Top-level sections

```json
{
  "amo": 1,

  "meta": {
    "name": "forest",
    "author": "ali"
  },

  "display": { ... },
  "quality": { ... },
  "assets":  { ... },
  "scene":   { ... },
  "timeline": { ... }
}
```

Only `"amo"` is required. Every other section has full defaults. Unknown fields
→ warning (not error) in v1, listed in parse result diagnostics.

### 5.2 `display` — physical characteristics (art direction)

Full field list (all optional; defaults come from engine config):

```json
{
  "pitch": 8,                        // number | "auto"
  "gamma": 1.6,
  "brightness": {
    "active": 1.0,
    "inactive": 0.035
  },
  "spill": 0.25,
  "emitters": {
    "maxOutput": { "r": 0.70, "g": 1.00, "b": 0.55 },
    "sigma":     { "r": 0.55, "g": 0.35, "b": 0.65 }
  },
  "bloom": {
    "intensity": 0.3,
    "threshold": 0.45,
    "power": 2.0,
    "radius": 12
  },
  "pentile": {
    "rowPitchFactor": 0.86,
    "blackMatrixRatio": 0.22,
    "greenSizeRatio": 0.80,
    "diamondSizeRatio": 0.90
  }
}
```

Validation ranges (clamp or reject — prefer clamp with diagnostic):
`gamma ∈ [0.5, 4]`, spill ∈ `[0, 0.6]`, maxOutput/sigma channels ∈ `[0, 1]` /
`(0, 2]`, bloom.intensity ∈ `[0, 1]`, radius ∈ `[2, 40]`, pentile ratios sane
positive floats.

### 5.3 `quality` — performance requests (device gets final say)

```json
{
  "logicalResolution": { "width": 320, "height": 180 },  // or omitted for auto
  "fps": 30,
  "supersample": "auto",            // "auto" | 1 | 2 | 3 | 4
  "priority": "visual"              // "visual" | "battery" (future use)
}
```

Constraints: width,height ∈ `[64, 1280]`; fps ∈ `[1, 60]`. Requests are
preferences — the quality manager (§Phase 8) negotiates downward as needed.

Note: logical resolution lives under `quality`, NOT `display` — it describes how
much information the scene carries, not what the fake panel looks like.

### 5.4 `assets` — external references

```json
{
  "forest": "forest.webp",
  "rain": "rain.gif",
  "bgvideo": "rain.mp4"
}
```

Values are URLs resolved **relative to the `.amo` file's URL**. Same-origin only
in v1. Referenced-but-missing assets → validation error.

### 5.5 `scene` — content source

v1 primitive types (one per scene initially; composite arrives in Phase 6):

```json
{ "type": "color",     "color": "#06120a" }
{ "type": "gradient",  "from": "#001a08", "to": "#123f20", "direction": "vertical" }
{ "type": "image",     "asset": "forest", "fit": "cover" }
{ "type": "gif",       "asset": "rain",   "fit": "contain" }
{ "type": "video",     "asset": "bgvideo", "muted": true }
{ "type": "pattern",   "pattern": "dots" }                       // Phase 2 stretch
{ "type": "expression", "r": "...", "g": "...", "b": "..." }     // Phase 5
{ "type": "composite",  "layers": [ ... ] }                      // Phase 6
```

`fit`: `"cover" | "contain" | "stretch"` (default cover). Colors: `#rgb`,
`#rrggbb`, or `{r,g,b}` floats 0–1. Directions: `vertical | horizontal |
diagonal | radial`.

Coordinates/sizes in composite layers (Phase 6) are normalized `0→1` (Rule 6).

### 5.6 Animation classes (validator-enforced)

| Class | Fields | Timeline keyframes? |
|---|---|---|
| `animatable` | `display.gamma`, `brightness.*`, `spill`, `emitters.*`, `bloom.*` | YES (v1) |
| `structural` | `display.pitch`, `display.pentile.*`, `quality.supersample` | NO — rejected until FBO realloc optimization exists |

### 5.7 `timeline`

```json
{
  "duration": 8,          // seconds; expressions receive t wrapped to [0, duration)
  "loop": true,
  "keyframes": [
    { "property": "display.bloom.intensity",
      "keys": [[0, 0.0], [2, 0.5], [5, 0.15]],
      "easing": "smoothstep" }
  ]
}
```

Keyframed properties must be class `animatable` (§5.6). Easings v1: `linear`,
`smoothstep`, `easeIn`, `easeOut`.

### 5.8 Static detection

A scene is **static** iff: scene type ∈ {color, gradient(static), image,
pattern} AND no `timeline.keyframes` AND no time-dependent expressions.
Static ⇒ render one frame and stop (Rule 4). GIF/video scenes are inherently
animated while playing but pause their clock when tab hidden.

---

<a name="6-phases"></a>
## 6. Implementation phases

Implement strictly in order. Each phase lists: goal, tasks, files touched,
acceptance criteria. Commit after each phase. Keep commits scoped to one phase.

---

<a name="phase-1"></a>
### Phase 1 — Refactor boundaries (no visual changes)

**Goal:** clean foundation. Existing demo behaves pixel-identically afterwards.

Tasks:

1. Create `src/engine/`; move `config.js`, `frame-buffer.js`,
   `diamond-pentile-geometry.js`, `amoled-gpu-renderer.js`, `amoled-renderer.js`
   into it **unchanged**. Update `index.html` script tags and README paths.
2. Fix duplicated/inconsistent fallbacks:
   - In both renderers, replace inline magic fallbacks
     (`positive(cfg.redSigma, 0.45)` etc.) with references to the single frozen
     defaults object so there is exactly ONE default value per setting.
   - Reconcile the known conflicts: redSigma 0.45-vs-0.55, bloomRadius 12-vs-16,
     supersample clamp-fallback 2-vs-config-1, HTML control defaults.
   - Unify duplicated helpers (`clamp01`, `resolveElement`, sRGB conversions)
     into one place reachable by both renderers (may be a small shared section
     appended to `config.js`, since IIFE files can't import).
3. Extract the adaptive quality governor out of `app.js` into
   `src/player/quality.js` (ES module). For now it can still mutate renderer
   config internally, BUT:
   - It must save/restore cleanly and expose `setRequestedQuality(q)` /
     `getActualQuality()` instead of reaching into UI elements.
   - It must not depend on `document.getElementById("fps-input")` etc. — take
     target FPS and callbacks as constructor options.
   - Mark with a TODO that Phase 8 replaces its internals with negotiation.
4. Optimize `resize()` in BOTH renderers: skip destroying/recreating
   `sceneTarget`/`bloomATarget`/`bloomBTarget` when computed dimensions are
   unchanged (common case for pitch tweaks). Verify HDR-fallback path still works.
5. Add `.amo` to nginx cache regex (`nginx.conf:12`).
6. Move nothing else. `media-loader.js`, `patterns.js`, `app.js` keep working.
7. **[AMENDMENT A5] Commit the proven browser harness** from the debugging
   sessions into `tests/browser/` (chrome-headless-shell + puppeteer-core,
   `CHROME_BIN` env var, manual-run scripts: smoke / regression / screenshots).
   They are written and battle-tested; committing them makes the Phase 7
   screenshot gate trivial instead of new work.
8. **[AMENDMENT A6]** Shared helpers (`clamp01`, `resolveElement`, sRGB
   conversions, `positive`, clamps) live in a new tiny IIFE `src/engine/util.js`
   loaded before all other engine scripts — NOT appended to `config.js`
   (that file is "defaults", not "utils").

Acceptance criteria:

- `node tests/lattice-parity.js` exits 0.
- Demo loads, GIF playback works, sliders work, governor downgrades/upgrades
  under simulated load (throttle CPU in devtools), Canvas 2D fallback works
  (force by temporarily disabling WebGL2).
- `grep` finds no remaining numeric-literal fallbacks for sigma/radius/supersample
  in renderer uniform-setting code.
- Visual diff by eye: renders look identical before/after.

---

<a name="phase-2"></a>
### Phase 2 — `.amo` v1 format

**Goal:** parse + validate + normalize. No playback yet.

Files to create (ES modules, Node-testable — see §8):

- `src/scene/parser.js`
  - `parseAmo(text | object, baseUrl) → { definition, warnings[] }` or throws
    `AmoParseError` with path-style messages (`display.bloom.radius`).
  - Accepts JSON text or an already-parsed object. Resolves relative asset URLs
    against `baseUrl`.
- `src/scene/validator.js`
  - Schema checks per §5. Rejects: missing/unknown `amo` version, invalid scene
    type, invalid colors, negative dimensions, resolution outside `[64,1280]`,
    NaN/Infinity anywhere, missing referenced assets (URL existence check is
    async — validator returns list of required assets; loader verifies later),
    keyframes on `structural` params.
  - Clamps out-of-range numerics WITH a warning entry.
- `src/scene/defaults.js`
  - Single normalized-defaults table mirroring engine defaults (imported conceptually
    from `AMOLED.DEFAULT_ENGINE_CONFIG` — but scene module must NOT read window;
    duplicate the numbers here with a comment tying them to engine config, OR
    accept a defaults object as argument. Prefer: `buildDefinition(rawObject, engineDefaults)`.
- Output shape — `SceneDefinition` (frozen):

```js
{
  version: 1,
  meta: { name, author },
  display: {
    pitch: null /*auto*/ | number,
    gamma, activeLevel, inactiveLevel, spill,
    maxOutput: {r,g,b}, sigma: {r,g,b},
    bloom: { intensity, threshold, power, radius },
    pentile: { rowPitchFactor, blackMatrixRatio, greenSizeRatio, diamondSizeRatio }
  },
  quality: { logicalWidth, logicalHeight /*null=auto*/, fps, supersample /*null=auto*/ },
  assets: { name → resolvedAbsoluteUrl },
  scene: { type, ...typeSpecificFields },
  timeline: { duration, loop, keyframes: [...] } | null,
  isStatic: boolean
}
```

Also create sample scenes: `scenes/color.amo`, `scenes/gradient.amo`,
`scenes/image.amo` (+ a small test image in `assets/`, ≤ 640×360, e.g. reuse or
downscale something; do NOT add multi-MB files).

Tests (Node, see §7): valid/invalid fixtures, clamping, static detection matrix.

Acceptance criteria:

- `node tests/amo-parser.test.js` passes ≥ 20 fixture cases including all reject
  cases in §5.1/§5.5.
- `parseAmo(JSON.stringify(validScene)) === parseAmo(validScene)` (idempotent).
- Static detection: color/gradient/image ⇒ `isStatic === true`; gif/video ⇒ false;
  anything with keyframes ⇒ false.

---

<a name="phase-3"></a>
### Phase 3 — Player + first real scene (critical milestone)

**Goal:** prove `.amo → parser → runtime → rasterizer → existing renderer → canvas`.

Files to create:

- `src/scene/rasterizer.js`
  - `rasterize(definition, t, targetSize, assets) → Uint8ClampedArray(len=w*h*3)`
  - Implements v1 sources: `color`, `gradient` (vertical/horizontal/diagonal/radial),
    `image` (via decoded ImageBitmap, fit cover/contain/stretch with black padding,
    drawn to an offscreen canvas then read back at logical resolution — this
    downsampling-before-simulation is a core perf win).
- `src/scene/assets.js`
  - `loadAssets(definition) → Promise<{name → decoded}>`; images via `createImageBitmap`,
    GIFs/videos deferred to Phase 4 (reject with clear message for now).
- `src/player/runtime.js`
  - Owns THE clock (single `requestAnimationFrame` loop when animated; none when
    static). API: `setScene(def)`, `start()`, `pause()`, `stop()`, `invalidate()`.
  - Static scene: rasterize once, deliver frame, stop loop.
  - Animated: schedule at `quality.fps` (NOT display refresh) using accumulated-time
    gating inside rAF.
- `src/player/cache.js` — `Map` caches: URL→SceneDefinition, URL→ImageBitmap,
  definition-key→static frame buffer.
- `src/player/amoplayer.js` — public API:

```js
const player = new AMOLEDPlayer({ renderer /* instance */, container });
await player.load("/scenes/gradient.amo");  // fetch → parse → validate → assets
player.play(); player.pause(); player.stop(); player.destroy();
player.load(parsedDefinitionObject);        // also accepts pre-parsed defs
// events: onloadstart / onload / onerror / onqualitychange (later)
```

  On scene load it applies `definition.display` via ONE
  `renderer.updateConfig(displayToEngineConfig(display))` call (mapping table
  documented in code), sizes frames to negotiated logical resolution
  (Phase 3: just use requested or 320×180 auto), and delivers frames via
  `renderer.loadFrameBuffer(w, h, data)`.

- Update `index.html`/`app.js` minimally: keep the demo, ADD a debug hook
  `window.__player` and a temporary way to load a scene (e.g.
  `?scene=/scenes/gradient.amo` query param routes through the player instead of
  the GIF loader). Do NOT delete demo UI yet.

Additional tasks / invariants **[AMENDMENTS A3 + A4]**:

- Add a cumulative render counter to BOTH renderers' `getStats()`
  (`framesRendered`) — additive engine API, needed to measure the
  "exactly ONE render" criterion below.
- INVARIANT: exactly ONE owner of the renderer instance. When `?scene=` is
  present, the player drives the renderer and the legacy demo media loop must
  not start (and vice versa). Two owners = squeezed-corner-class bugs.

Acceptance criteria:

- `?scene=scenes/gradient.amo` renders a gradient through the real PenTile
  simulation; network tab shows exactly ONE render (static scene ⇒ no repeated
  rAF work; verify via `getStats().framesRendered`).
- Switching `?scene=` between color/gradient/image works without page reload
  issues (cache hit on second visit to same scene).
- Engine files untouched except via their public API.
- Lattice-parity test still green; demo GIF mode still works.

---

<a name="phase-4"></a>

### Phase 4 — Animation & central clock

**Goal:** moving scenes; media-loader demoted to decoder.

Tasks:

1. `src/player/timeline.js`:
   - `duration`, `loop` wrapping of `t` into `[0, duration)`.
   - Keyframe interpolation for `animatable` display properties
     (mapping table from §5.6). Interpolated values applied each tick via
     `updateConfig` (cheap: they're all uniform-only).
   - Easings: linear, smoothstep, easeIn, easeOut.
2. Extend `assets.js` + `runtime.js` for `gif` and `video` scene types:
   - Repurpose `ClientMediaLoader` as a pure decoder: call its `load()` +
     `getFrame(w,h)` manually from the runtime tick; DELETE reliance on its
     internal `setInterval` startLoop for scene playback (keep the method for the
     legacy demo path until demo removal).
   - GIF frame advancement timing driven by the runtime clock, not Date.now()
     side loops where feasible (minimal change: runtime polls getFrame each tick;
     loader advances internally — acceptable v1, note as debt).
   - Video: play/pause tied to player.play()/pause(); muted always.
3. Tab visibility: when `document.hidden`, pause the clock (and video); resume on
   visible. Static scenes unaffected.
4. Sample scenes: `scenes/rain.amo` (gif), `scenes/clip.amo` (video) — small
   assets only (< 2 MB total additions).
5. **[AMENDMENT A2] Grid-sync inheritance:** the runtime must inherit the two
   behaviors currently living in `app.js` callbacks: (a) on renderer grid
   change, re-target the frame source dimensions (`onGridChange → resizeTarget`
   equivalent); (b) skip decode/upload while `document.hidden`. Acceptance item:
   resizing the window mid-GIF-scene must NOT produce squeezed/corner-locked
   content (the regression we fixed once already).

Acceptance criteria:

- Keyframe demo: bloom intensity visibly animates 0→0.5→0.15 over 5 s loop;
  profile confirms no FBO recreation during animation (only uniform updates).
- GIF scene plays at correct cadence; pausing player pauses GIF.
- Hidden tab ⇒ zero rAF ticks (count them); visible ⇒ resumes.
- Two different scenes loaded back-to-back: second load reuses cached decoded
  asset when same asset referenced.

---

<a name="phase-5"></a>
### Phase 5 — Expression language

**Goal:** safe math-driven procedural content.

File: `src/scene/expression.js` (+ `src/scene/prng.js`).

Requirements:

- Pipeline: tokenizer → recursive-descent parser → AST → compile-once closure.
  Parse ONCE at scene load; evaluation per pixel per frame must involve zero
  string work.
- Grammar v1: numbers, identifiers, unary -, `+ - * / % ^`, parentheses,
  ternary `? :` (nice for palette tricks), function calls, comma args.
- Functions: `sin cos tan asin acos atan atan2 abs sqrt pow min max floor ceil
  fract mod clamp mix lerp(alias of mix) smoothstep step exp log sign distance
  length noise(fbm later)` — implement in JS, mirror semantics precisely in the
  doc-comment so the Phase 10 GLSL compiler matches.
- Variables: `x y t frame width height u v (=x/w, y/h) seed progress`.
- `noise(seedable)`: value-noise with bilinear+smoothstep interp, deterministic
  from `prng.js` (xorshift/mulberry32 seeded from scene `seed` field).
- Errors: unknown identifier/function, arity mismatch, deep recursion → throw
  at PARSE/COMPILE time with position info. Runtime division-by-zero yields
  defined result (Infinity guard → clamp), never NaN in output (final clamp
  pass guarantees bytes).
- Integration: `expression` scene type evaluates per pixel into the RGB buffer.
  Per-pixel eval loop must be flat typed-array work, no allocations.
- Validator: expression scenes force `isStatic=false` unless AST contains no
  `t`/`frame` reference (walk the AST — this gives static mathematical images
  for free).
- Budget guardrail (decision §3.5): warn when expression scene requests > 480×270
  or > 2 simultaneous expression layers (compositing, Phase 6).

Tests (Node): determinism (same seed+t ⇒ identical buffer hash), NaN-prevention,
parse errors, easing/curve spot values, static-detection via AST walk.

Acceptance criteria:

- `scenes/procedural.amo` (e.g. plasma: `sin(x*8+t)+sin(y*6-t)*...`) animates
  smoothly at 320×180@30 on a mid laptop (verify via quality manager metrics).
- Static expression scene (`no t`) renders once.
- 100% parser error cases covered by tests.

---

<a name="phase-6"></a>
### Phase 6 — Compositing

**Goal:** layered scenes — the artistic payoff.

- `src/scene/compositor.js`: ordered layer list, bottom-up.
- Layer common fields: `opacity [0,1]`, `blend: normal|add|multiply|screen|overlay`
  (implement normal/add/multiply/screen first; overlay if cheap),
  optional normalized-rect clip `x,y,w,h ∈ [0,1]`, transform v1 limited to
  `offset:{x,y}` + `scale` (normalized units) + `rotation` (defer if pressed).
- Composite in float (Float32 workspace) then quantize once to RGB bytes —
  avoid banding from repeated byte rounding.
- Extend `expression` type usable AS a layer; gradients/patterns too.
- Masks: defer unless trivially served by clip rects. True alpha masks = follow-up.
- Sample: `scenes/composite.amo` — gradient + image @0.5 opacity + slow noise
  shimmer @add 0.3.

Acceptance criteria: composite scene visually matches hand-computed expectation
for a 3-layer test fixture (unit-test compositor on tiny 4×4 buffers against
golden bytes); performance within budget guardrail; static composite scenes
(composed entirely of static layers) render once.

---

<a name="phase-7"></a>
### Phase 7 — Per-scene AMOLED configuration completion

**Goal:** every §5.2 display field actually flows to the engine; hard-coded GLSL
constants promoted.

Tasks:

1. Audit mapping table `displayToEngineConfig()` — ensure ALL fields work end-to-end
   (some were wired in Phase 3 minimally; complete now, incl. `pitch:"auto"`
   semantics = leave engine auto-density untouched).
2. Promote GLSL hard-coded constants to uniforms/config (engine change — the ONLY
   sanctioned engine modification beyond Phase 1):
   - `uCoreSoftness` (aa=0.75), `uHaloNearScale` (0.16),
     `uHaloNearWeight` (0.65), `uHaloFarWeight` (0.35)
   - Keep reach multipliers/margins derived as-is (not exposed).
   - Engine-level defaults preserve current visuals EXACTLY (bit-for-bit intent:
     verify with a screenshot comparison before/after at fixed viewport).
   - Wire into `DEFAULT_ENGINE_CONFIG`; optionally surface in `.amo`
     `display.optics` later — NOT in v1 format yet.
3. Structural-param handling: applying a scene with different `pitch`/`pentile`
   triggers exactly one `resize()`; verify no double-resize on load
   (apply display BEFORE first frame delivery).
4. Document Canvas 2D fallback limits in README ("approximation; physical
   params like gamma/sigma/spill are WebGL2-only").

Acceptance criteria: screenshot pair (before/after constant promotion) at fixed
viewport+scene is pixel-identical or within ±1 LSB; every §5.2 field demonstrably
changes output in isolation (manual checklist); lattice-parity green.

---

<a name="phase-8"></a>
### Phase 8 — Quality negotiation system

**Goal:** hierarchical, reversible, art-safe adaptation.

Rewrite `src/player/quality.js` (replacing the Phase 1 extraction):

```text
requested (scene.quality)
   ↓
device capabilities tier (dpr, screen, hardwareConcurrency, deviceMemory,
                          webgl2, EXT_color_buffer_float, lowTier heuristic)
   ↓
measured cost (rolling: renderer.getRenderCost() + runtime FPS counter)
   ↓
safety limits (engine-owned: maxInternalPixels, maxDevicePixelRatio,
               min/maxPixelScale, resolution ceiling 1280)
   ↓
actual quality {logicalWidth, logicalHeight, fps, supersample}
```

Rules:

- **[AMENDMENT A1] Signal priority: measured display FPS is the PRIMARY
  signal; `getRenderCost()` (CPU submit time, no `gl.FINISH`) is secondary.**
  Cost systematically underestimates GPU-bound devices (integrated GPUs) —
  exactly the machines that need protection — so when cost says "fine" but
  FPS says "dying", FPS wins.
- Downgrade ladder (per-axis, reversible, hysteresis: 3 strikes down w/ cooldown,
  8 good-streaks up w/ longer cooldown — reuse proven constants from old governor):
  1. logicalResolution −25%
  2. fps −30% (floor 12)
  3. supersample → 1
  4. DPR cap → 1
- NEVER touches display/artistic params (assert in code: whitelist of mutable keys).
- Static scenes exempt from downgrade (they don't consume continuous time).
- Emits `onqualitychange(actual)`; player surfaces it; debug status line shows
  requested vs actual.
- Cache interplay: quality change on a STATIC scene ⇒ invalidate cached frame,
  re-rasterize once at new size.

Acceptance criteria: scripted throttle test (devtools CPU 6× slowdown) walks
ladder down then back up; assert artistic config keys bit-identical throughout;
unit-test ladder transitions in Node with mocked metrics.

---

<a name="phase-9"></a>
### Phase 9 — Generator (only after format is stable)

Build in stages, each independently shippable:

1. **Stage 1 — form editor:** fields for Display/Quality/Scene(v1 types)/Assets;
   preview pane embedding the REAL player+engine (same modules — Rule: generator
   must not have its own renderer); Export downloads `scene.amo`.
2. **Stage 2 — visual layer editor** (composite layers, drag order).
3. **Stage 3 — timeline editor** (keyframe tracks for animatable params).
4. **Stage 4 — expression editor** (live-eval sandbox using the same compiler,
   with error surfacing from parse stage).
5. Export v1: single `.amo` + instructions to place sibling assets; packaging
   (zip) deferred.

Location: `/generator/` in-repo (plain HTML+ESM pages; served statically).
Generator shares `src/scene/*` and `src/player/*` verbatim — enforced by code
review, and practically by the fact it needs zero copies.

Acceptance criteria: a scene authored in generator exports a `.amo` that the
portfolio player loads byte-identically (same definition object after parse);
preview and production render indistinguishably (same pipeline by construction).

---

<a name="phase-10"></a>
### Phase 10 — GPU procedural scenes (optimization, optional timing)

Trigger: profiling shows CPU rasterization is the bottleneck for real portfolio
scenes (likely: multiple animated expression/noise layers).

Design constraints:

- Format unchanged. Player detects capability + scene complexity and selects path.
- Add engine API `loadTexture(sourceTextureOrCanvas)` alongside
  `loadFrameBuffer(...)` — never remove the latter (Canvas 2D fallback depends on it).
- Expression compiler gains a GLSL backend: same AST → GLSL expression string;
  determinism caveats documented (GPU sin/exp differ in ULPs — acceptable,
  document; keep CPU path as reference/fallback).
- Rasterization-to-texture path: scene layers render to an offscreen FBO at
  logical resolution → fed directly into emission pass as `uSource`.
  Blend modes implemented in a composite fragment shader matching compositor.js
  semantics exactly (golden-test CPU vs GPU on identical inputs, tolerance ±1).

Acceptance criteria: procedural scene at 640×360@30 with 2+ animated layers runs
within budget on mid hardware; CPU fallback still produces visually-equivalent
output when forced.

---

<a name="7-testing"></a>
## 7. Testing strategy

Runner: plain `node tests/<name>.test.js` scripts (exit code = pass/fail). No
framework needed; keep it that way. Optional tiny assert helper in
`tests/_lib.js`.

**[AMENDMENT A4-note] Module resolution:** a minimal `package.json` with
`"type": "module"` and no dependencies lands in Phase 1 so bare-Node ESM tests
can `import` the `.js` scene modules. The browser ignores it entirely (classic
`<script>` tags stay classic). `tests/lattice-parity.js` is converted to ESM
with a tiny IIFE-eval shim for the engine files it exercises.

Existing (KEEP GREEN THROUGHOUT):
- `tests/lattice-parity.js` — CPU↔GPU lattice invariant. Run after EVERY phase.

New, per phase:

| Phase | Test file | Covers |
|---|---|---|
| 2 | `tests/amo-parser.test.js` | fixtures valid/invalid/clamp/static-detect/version |
| 3 | `tests/rasterizer.test.js` | solid/gradient expected bytes on tiny buffers; image fit math |
| 4 | `tests/timeline.test.js` | wrapping, keyframe interp, easings, structural rejection |
| 5 | `tests/expression.test.js` | grammar, errors, functions spot-values, determinism hash, NaN guards, AST static-walk |
| 6 | `tests/compositor.test.js` | blend-mode golden bytes on 4×4 fixtures |
| 8 | `tests/quality.test.js` | ladder transitions with mocked metrics; art-key immutability assertion |

Browser-level (manual checklist per phase, automated later — explicitly OUT of
scope until after Phase 8): headless screenshot harness notes kept in
`tests/README.md` as a future work item (Playwright + `preserveDrawingBuffer`
capture, golden PNG compare).

CI suggestion (optional, cheap): GitHub Actions running the Node tests on push.
Requires adding a minimal `package.json` with ONLY a test script — does not
violate no-build-step (nothing installed).

---

<a name="8-conventions"></a>
## 8. Conventions for all new code

1. **ES modules** for everything new (`export`/`import`). No default exports
   except player entry (`amoplayer.js`).
2. **DOM-free cores:** `src/scene/**` must not touch `document`/`window`
   (exceptions: `assets.js` decoding, which takes injected factories if needed).
   This preserves bare-Node testability. `src/player/**` may use DOM.
3. **No comments unless non-obvious**, matching existing codebase style; JSDoc
   allowed on public APIs of scene/player modules.
4. **Style:** match existing files — 4-space indent, double quotes, strict mode,
   named function declarations, no semicolon-free style experiments.
5. **Error style:** throw `Error` subclasses with path-context messages
   (`display.bloom.radius: expected number, got string`). Never console.warn from
   library modules — return warnings arrays; callers decide.
6. **Allocation discipline:** per-frame paths (rasterizer, compositor, evaluator)
   allocate nothing in steady state (reuse typed-array workspaces sized on
   scene load).
7. **Numbers:** all scene-facing angles in radians, time in seconds, colors
   normalized floats internally.
8. Every phase = separate commit(s) referencing the phase number.

---

<a name="9-risks"></a>
## 9. Known risks and traps

| Risk | Mitigation |
|---|---|
| Mixed IIFE/ESM confusion | Engine untouched; player receives instances, never imports engine internals. Enforce in review. |
| Animating structural params thrashes FBOs | Validator rejects keyframes on them (§5.6) until resize() optimization verified. |
| CPU expression perf cliff with many layers | Budget guardrail §3.5 + warning; Phase 10 escape hatch designed-in. |
| Quality system fighting scenes | Whitelist assertion — quality manager physically cannot write artistic keys. |
| GPU/CPU visual divergence after constant promotion | Screenshot pair gate in Phase 7 acceptance. |
| GIF timing drift via dual clocks | Accepted v1 debt (loader advances internally); revisit if visible stutter. |
| `.amo` MIME/caching | Handled Phase 1 (nginx rule); player parses text regardless of Content-Type. |
| Scope creep into "general graphics engine" | The primitive list in §5.5 is closed for v1–v6. New primitives require plan amendment. |
| Breaking the demo mid-overhaul | Phases 1–2 don't alter user-visible behavior; Phase 3 adds rather than replaces until the switch-over step. |

---

## Milestone summary

| Phase | Deliverable | User-visible? |
|---|---|---|
| 1 | Cleaned boundaries, extracted governor | No (identical visuals) |
| 2 | `.amo` parser/validator + samples | No |
| 3 | **Player: `.amo` → real PenTile canvas** | **YES — critical milestone** |
| 4 | Timelines, GIF/video scenes | Yes |
| 5 | Math expression scenes | Yes |
| 6 | Layered compositing | Yes |
| 7 | Full per-scene display personality | Yes |
| 8 | Adaptive quality negotiation | Yes (smoother on weak devices) |
| 9 | Generator | Tooling |
| 10 | GPU procedural fast path | Perf only |

**End state:** the portfolio loads `/scenes/<section>.amo`; each scene defines
its content, motion, and the physical personality of the simulated display; weak
devices silently negotiate quality; static scenes cost one frame; and the AMOLED
engine remains a standalone simulator that has never heard of websites.
