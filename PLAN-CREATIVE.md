# PLAN-CREATIVE.md — `.amo` Creative Expansion: Living Scenes, Primitives, Presets, Hybrid Studio

> **Status:** Approved plan, ready for execution. Companion to `PLAN.md` (which covers
> engine/player Phases 1–10, all shipped and verified).
> **How to use:** Execute workstreams A → B → C → D in order. Each task lists files,
> design decisions, and acceptance criteria. Commit after every numbered task.
> Run `npm test` after every task; run `npm run test:browser` after tasks that touch
> player/runtime code.

---

## 0. Context — what exists today (verified)

The engine, player, and format from PLAN.md are complete and green:

- **Renderer boundary (stable):** `renderer.loadFrameBuffer(w,h,rgb)` / `updateConfig(cfg)` / `requestRender()`.
- **Player pipeline:** `.amo` fetch → parse → validate → assets → runtime clock → rasterizer → engine. Concurrent loads are serialized (last-requested wins). Static scenes render exactly once.
- **Format v1 sections:** `amo`, `meta`, `display`, `quality`, `assets`, `scene`, `timeline`.
- **Scene types:** `color`, `gradient`, `image`, `gif`, `video`, `pattern`*, `expression`, `composite`.
  - *KNOWN GAP: `pattern` passes validation but `rasterizer.js` has NO case for it — throws
    "unsupported scene type". Fix lands in Task B1.
- **Expression language** (`src/scene/expression.js`): tokenizer → parser → AST → closures;
  vars `x y t frame u v width height seed progress`; functions incl. `sin cos abs sqrt pow
  min max floor ceil fract mod clamp mix lerp smoothstep step exp log sign distance length
  noise`; seeded value-noise; AST time-reference walk (`expressionReferencesTime`); GLSL backend (`compileToGLSL`) used by the opt-in GPU path.
- **Compositor:** bottom-up float32 workspace, blends normal/add/multiply/screen/overlay,
  opacity, clip rect, scale+offset transform (no rotation yet).
- **Timeline:** duration/loop wrapping; keyframes on `animatable` display params only.
- **Generator Stage 1:** bare form editor at `/generator/index.html` with live preview through
  the real player and export/import.

### Known architecture facts that constrain this plan

- Scene modules (`src/scene/**`) MUST stay DOM-free (Node-testable). DOM lives in `src/player/**` and `generator/**` only.
- Expression language is **scalar-only** (returns numbers). There is no vec3/color type. Color animation = per-channel scalar expressions. Do NOT introduce vector types in this expansion.
- Per-frame paths must not allocate (reused typed-array workspaces).
- Determinism rule: same `.amo` + size + t (+ seed) ⇒ identical output bytes. Particles must be stateless functions of `(seed_i, t)`, never simulated state.

---

## 1. Vision (user-approved decisions)

Build the full creative ladder — everything from a still gradient to living mathematical
scenes — plus a real authoring tool:

| Decision | Choice |
|---|---|
| Authoring UX | **Hybrid editor**: visual form ↔ live `.amo` source side-by-side, round-tripping |
| Motion model | **Expressions everywhere**, PLUS a preset library that generates expression code for common motions |
| Primitives | ALL of: living gradients & flow fields, transforms & parallax, pattern generators, particles |
| Audience | Personal devtool now, architecturally ready to go public later |

Mental model to preserve:

> The `.amo` file describes what the display shows and how the display should look.
> Layer properties may be alive (functions of time/space). The physics engine stays oblivious.

---

## 2. Workstream A — Expressions Everywhere (foundation)

Everything else composes on this. Goal: **any numeric or color sub-property of any scene
or layer can be an expression string instead of a literal.**

### A0. The "E-value" convention (format law, document in README)

A *slot* is a named property location (e.g. `layers[2].opacity`, `scene.from.r`).

- Numeric slot accepts: `number` **or** `string` (an expression evaluating to a number).
- Color slot accepts: `"#rgb"/"#rrggbb"` hex string, `{r,g,b}` floats, **or**
  `{r: <number|string>, g: ..., b: ...}` where each channel may independently be a
  number or expression string.
- Expression results are clamped by the same range rules as literals, applied at
  evaluation time.
- Strings that look like hex colors are never treated as expressions (disambiguation is
  positional: hex parsing is attempted first in color slots; numeric slots treat any
  string as an expression).

Examples:

```json
{ "opacity": "0.5 + 0.3*sin(t*0.7)" }
{ "scale": "1 + 0.05*sin(t*2)" }
{ "from": { "r": "0.02 + 0.05*sin(t*0.3)", "g": "0.10", "b": "0.03" }, "to": "#2a5c34" }
{ "size": "6 + 2*sin(t)" }
```

### A1. Centralize expression handling — `src/scene/evalue.js` (NEW)

Single module, DOM-free:

```js
resolveSlot(slotSpec, env) -> number          // literal fast path or compiled eval
isDynamicSlot(slotSpec) -> boolean             // true if string && referencesTime
collectExpressions(node) -> [{path, source}]  // deep-walk any scene/layer tree
makeEnv(t, w, h, fps, duration, seed) -> env  // shared env object construction
```

- Compile-once caching keyed by WeakMap on the owning frozen scene/layer object
  (same pattern as `programCache` in rasterizer.js).
- Env for **layer-level slots**: `{t, frame, width, height, progress, seed}` — NO x/y/u/v.
  Layer transforms are per-layer scalars; spatial variation there is undefined behavior
  (validator warns). Document this.
- Env for **pixel-level slots** (gradient/livingGradient channel colors, pattern params):
  full env incl. `x y u v`. These evaluate per pixel; budget-gated (§7).

Update `src/scene/rasterizer.js`: replace private `programCache` usage with evalue helpers
where convenient (keep the hot r/g/b loop as-is).

### A2. Wire E-values into compositor transforms — `compositor.js`

- `opacity`, `scale`, `offset.x/y`, `rect.{x,y,w,h}` become E-value slots, resolved once
  per layer per frame before the pixel loop.
- **Add `rotation`** (radians, around layer center): inverse-map destination→source coords
  in the transform path (rotate + scale + offset composition). Nearest-neighbor sampling
  like the existing path; document edge behavior (out-of-bounds = transparent/black).
- Blend mode remains a static string (v1).

### A3. Wire E-values into gradients + add `livingGradient` — `rasterizer.js`, `validator.js`

- Existing 2-stop `gradient`: `from`/`to` become color-E-value slots. If ALL channels are
  constants → existing fast path untouched. If ANY channel is an expression → per-pixel
  evaluation path (6 scalar evals/pixel max).
- NEW `livingGradient` — multi-stop animated gradient:
  ```json
  { "type": "livingGradient",
    "stops": [
      { "at": 0,   "color": "#001a08" },
      { "at": 0.55,"color": { "r": "0.07+0.06*sin(t*0.4)", "g": "0.25", "b": "0.12" } },
      { "at": 1,   "color": "#2a5c34" }
    ],
    "direction": "vertical",         // or E-value radians? v1: vertical|horizontal|diagonal|radial
    "wobble": "0.03*sin(t*0.5)" }    // E-value: sinusoidal displacement of the axis coordinate
  ```
  Piecewise-linear stop interpolation (smoothstep option later). `wobble` displaces the
  projection coordinate before interpolation — cheap organic drift.
- `direction` may become an E-value (radians angle) in a later pass if wanted; not required.

### A4. Validator/parser updates — `validator.js`

- Accept the new shapes everywhere (E-values in numeric/color slots, `rotation`,
  `livingGradient.stops`, `wobble`). Clamp-at-eval, not clamp-at-parse, for expression
  slots (can't know values statically); literals keep current clamping + warnings.
- **Static detection rewrite (central rule):** scene is STATIC iff
  - `collectExpressions(definition.scene)` finds zero strings matching
    `expressionReferencesTime`, AND
  - no `timeline.keyframes`, AND
  - type ∉ {gif, video}, AND (new) particles.count === 0 handled by B3 rule.
  Replace the ad-hoc per-type checks in `validateAndNormalize`. This must keep passing the
  entire existing static-detection test matrix.
- New warning: layer-level E-value referencing `x|y|u|v` (parse the AST to detect) —
  "layer transforms do not vary per-pixel".

### A5. Tests

- `tests/evalue.test.js`: literal/expression/clamp/env-shape/WeakMap-caching cases.
- Extend `tests/amo-parser.test.js`: every new accepted shape + rejection cases
  (non-numeric non-expression in numeric slot, bad stops, negative `at`, unsorted stops
  auto-sort with warning).
- Extend static-detection fixtures: dynamic via layer opacity expr, dynamic via gradient
  channel expr, static via constant exprs (`"2+2"` must NOT force animation… note:
  conservative option is treat any expression string as potentially dynamic — NO, spec is
  AST-based: `expressionReferencesTime("2+2") === false` ⇒ static. Test it.)
- `tests/compositor.test.js`: golden bytes for rotation (90° exact swap on even-size
  buffers), animated opacity over 3 timestamps.

**Acceptance:** all suites green; a hand-written composite scene with pulsing opacity +
rotating image layer + breathing gradient renders correctly through the real player
(manual browser check); no perf regression on existing scenes.

---

## 3. Workstream B — Primitives

Order chosen by dependency: B1 (fixes broken type) → B2 → B3 → B4.

### B1. Pattern generators — finish the `pattern` type

```json
{ "type": "pattern", "pattern": "dots",       "size": 8,  "thickness": 0.5,
  "fg": "#39ff6a", "bg": "#041008", "softness": 0.15,
  "angle": "t*0.1", "offset": { "x": "t*0.05 % 1", "y": 0 } }
```

- Variants v1: `dots` (grid of discs), `checks`, `stripes`, `scanlines` (horizontal stripes
  sized in logical px), `halftone` (disc grid whose radius follows luminance of an optional
  `asset` or a `signal` expression — v1 supports `signal` expression only, asset-based
  halftone deferred).
- ALL numeric/color params are E-value slots (pixel-level env — patterns may crawl).
- Implementation: analytic coverage in the pixel loop — grid coords rotated by `angle`,
  distance-to-cell-center vs radius with `smoothstep(softness)` edges. No allocations.
- This FIXES the existing gap: rasterizer currently throws for `pattern`.
- Tests: golden bytes per variant on tiny buffers; animated offset advances; static when
  all params constant.

### B2. Flow field / living noise — `flow` type

```json
{ "type": "flow",
  "palette": ["#020d06", "#0d3320", "#2a6b3a", "#79c98a"],
  "scale": 3.5,        // noise frequency across width (E-value OK)
  "speed": 0.12,       // time multiplier
  "warp": 0.5,         // domain-warp strength (0 = plain fbm)
  "octaves": 3,        // 1..5, validated
  "gain": 0.5,         // lacunarity gain
  "seed": 7,
  "contrast": 1.0 }    // post curve: v' = clamp(0.5 + (v-0.5)*contrast)
```

- Value = fbm(x*scale + warpOffset, y*scale + t*speed), optionally domain-warped:
  `n = fbm(p + warp * vec(fbm(p + a), fbm(p + b)))` — implement with two extra fbm taps
  using orthogonal offsets. Map result through `palette` (piecewise-smooth ramp,
  smoothstep between stops).
- Budget gate: validator warns above `480×270` with `octaves*warp` cost > threshold
  (see §7). Reuses seeded noise consistent with `noise()` (exact same hash — must match
  the GLSL implementation contract for future GPU path).
- Tests: determinism hash across two runs; palette endpoint mapping; warp=0 equals plain
  fbm path (golden bytes); octaves=5 rejected/warned per validation rule.

### B3. Particles — `particles` type (stateless, deterministic)

```json
{ "type": "particles",
  "count": 90,           // 1..512 validated
  "behavior": "drift",   // drift|orbit|rise|fall|fireflies|snow
  "seed": 42,
  "size": { "min": 0.004, "max": 0.012 },   // fraction of height
  "speed": 0.2,          // behavior-scaled (fraction of height/sec)
  "color": "#aaffcc",    // or palette array -> per-particle pick
  "glow": 0.6,           // 0=hard disc, 1=wide gaussian falloff
  "twinkle": "0.5+0.5*sin(t*3+i)" }  // reserved: per-particle brightness expr (v1.1)
```

- **Stateless position functions**: particle i has hashed constants `(px_i, py_i, ph_i,
  pr_i)` from `mulberry32(seed + i)`; position at time t is a closed-form function
  (`drift`: wrap-around linear drift + sine bobbing; `orbit`: ellipse around hashed
  center; `rise/fall/snow`: vertical scroll with horizontal sway; `fireflies`: drift +
  twinkle brightness). No simulation state ⇒ determinism trivially holds and seeking/
  scrubbing works for free (studio scrubber depends on this).
- Render: additive soft discs splatted into the float workspace (works standalone and as
  a composite layer). Splat cost O(count × discArea) — cap count and glow accordingly.
- Static rule: `count > 0` ⇒ dynamic UNLESS speed === 0 (then positions are frozen —
  still render, mark static).
- Tests: determinism (same seed/t ⇒ identical buffer), wrap-around continuity (t and
  t+period produce overlapping distributions), splat energy bounds.

### B4. Parallax & transform recipes (no new engine code)

Parallax = composite of transformed layers using E-value offsets:

```json
{ "type": "composite", "layers": [
  { "type": "image", "asset": "far",  "scale": 1.1, "offset": { "x": "-0.02*sin(t*0.11)", "y": 0 } },
  { "type": "image", "asset": "mid",  "scale": 1.2, "offset": { "x": "-0.05*sin(t*0.17)", "y": 0 } },
  { "type": "flow",  "blend": "screen", "opacity": 0.35, "scale": 2.5 }
]}
```

Ship 2–3 example scenes under `scenes/` demonstrating parallax + rotation combos. Nothing
new to build beyond A2 — this task is examples + docs only.

**Workstream B acceptance:** every primitive demonstrable via a committed sample scene
loaded through the player; golden tests green; performance budgets hold on mid hardware
(manual check via quality overlay).

---

## 4. Workstream C — Motion preset library

NEW `src/scene/presets.js` — pure JSON→JSON transformer, DOM-free, Node-testable.

```js
applyPreset(fragment, presetName, params) -> fragment   // returns modified copy
listPresets() -> [{name, description, params}]
```

Presets generate EXPRESSION CODE (never hidden engine features) so exported `.amo` stays
transparent and the GPU path works unchanged:

| Preset | Generates |
|---|---|
| `pulse` | `opacity = base + amp*sin(t*rate + phase)` |
| `breathe` | `scale = 1 + amp*sin(t*rate)` |
| `driftX` / `driftY` | `offset.x = dist*sin(t*rate)` (wrap-safe small amplitudes) |
| `orbit` | offset.x/y circular motion pair |
| `sway` | `rotation = amp*sin(t*rate)` |
| `shimmer` | adds slow noise term to layer color channels (expression layers) |
| `wave` | `wobble = amp*sin(t*rate + y*freq)`-style livingGradient wobble |
| `flicker` | layered sines + seeded jitter on brightness |
| `scan` | linear moving offset with modulo wrap |
| `zoomPulse` | slow scale breathing tuned for backgrounds |
| `hueDrift` | gradient channel phase-shifted sine triads (approximate hue cycling in RGB space) |

Rules:

- Presets are **advisory sugar**: they expand to plain expressions at edit time and then
  disappear from the file. The `.amo` never contains preset references (keeps parser/GPU
  contract untouched).
- Each preset documents its params with defaults; unknown params rejected.
- Tests: snapshot expansion outputs; idempotence (applying twice doesn't stack — applying
  replaces the generated slots).

---

## 5. Workstream D — Hybrid Studio (generator overhaul)

Upgrade `/generator/` to a three-pane studio. Vanilla JS + ES modules, dark theme, no
framework. Architecture must remain public-ready (no dev-only shortcuts in core paths).

Layout:

```text
┌──────────────┬──────────────────────────┬────────────────────────┐
│ FORM / LAYERS│   PREVIEW (real player)  │  .amo SOURCE (editable)│
│ meta/display │                          │                        │
│ quality      │   ┌──────────────────┐   │  (round-trips both     │
│ scene tree   │   │ timeline scrubber│   │   ways)                │
│  ├ layer 1   │   │ ▶ ⏸  t=3.2s      │   │                        │
│  ├ layer 2+  │   └──────────────────┘   │  [format] [export]     │
│ presets ▾    │   status: fps/res/errors │  [import]              │
└──────────────┴──────────────────────────┴────────────────────────┘
```

Tasks:

1. **Source pane (right):** live textarea bound to parsed definition. Debounced
   (250 ms) re-parse on manual edits → validate → reload preview. Parse errors render
   beneath the editor WITHOUT clobbering the user's text; last-good preview persists.
2. **Form pane (left) → source regeneration:** every control writes into a working
   definition object, then pretty-prints JSON into the source pane (single writer:
   form always regenerates whole source; source edits replace the definition — no merge
   heuristics). Layer list: add/remove/reorder (↑↓), per-layer type picker + fields.
3. **Round-trip integrity:** definition → JSON → parse must be lossless for all supported
   shapes. Unknown-but-valid fields survive regeneration (carry-through raw tree, don't
   rebuild from normalized model). Test: round-trip equality on all gallery scenes.
4. **Scrubber:** pause + drag t ∈ [0, duration] calling a new player API
   `player.scrub(t)` (runtime renders single frame at t; requires statelessness —
   guaranteed by B3 design). Play resumes clock from scrub point.
5. **Display pane controls:** gamma/spill/bloom/etc sliders editing the `display`
   section (already exist in Stage 1 — port into new layout).
6. **Preset buttons:** per-layer dropdown of `listPresets()` with param mini-form;
   applies via `presets.js` and regenerates source (user sees exactly what got written).
7. **Gallery tab:** lists committed `scenes/*.amo`; click to load; serves as living
   documentation of every feature.
8. **Export/Import:** download working JSON as `<name>.amo`; file-picker import.
9. Polish pass LAST: keyboard shortcuts (space = play/pause), error toasts, responsive
   minimum width, help hints. Public-readiness = clean separation, not visual polish.

Player API addition (`amoplayer.js` + `runtime.js`):

```js
player.scrub(tSeconds)   // pause + render exactly one frame at absolute t
player.getTime() / player.getDuration()
```

Tests: Node-level round-trip tests for #3; scrubber correctness in browser harness
(scrub to fixed t ⇒ deterministic buffer hash matches direct rasterize at same t).

---

## 6. Execution order (today's run)

```text
A0/A1  evalue.js + centralized collection          ← start here
A2     compositor E-values + rotation
A3     gradient channel exprs + livingGradient
A4     validator/parser + static-detection rewrite
A5     tests green                                  ← commit gate
B1     pattern generators (fixes broken type)
B2     flow field
B3     particles
B4     parallax samples                             ← commit gate
C      presets.js + gallery scenes                  ← commit gate
D1-D3  studio shell + source pane + round-trip
D4-D9  scrubber, presets UI, gallery, export, polish← commit gate
```

Commit message convention: `feat(creative-A1): evalue infrastructure` etc.

---

## 7. Performance budgets (enforced by validator warnings, hard limits in code)

| Feature | Budget |
|---|---|
| Layer-level E-values | O(layers)/frame — negligible, no gate |
| Gradient channel exprs | ≤ 6 evals/px — warn > 640×360 |
| `flow` | warn when `width*height*(octaves*(warp>0?3:1))/1e6 > 12` (≈480×270@3oct+warp@30fps) |
| `particles` | hard cap count ≤ 512; warn > 256 with glow > 0.7 |
| Composite total | warn when animated expression layers > 2 (existing rule) |

Hard caps reject at validation: `octaves > 5`, `count > 512`, resolution > 1280 (existing).

---

## 8. Conventions (inherit §8 of PLAN.md, plus)

- New primitives follow the existing rasterizer dispatch style; zero steady-state
  allocations; seeded randomness ONLY via `src/scene/prng.js` (`mulberry32`).
- Every new expression-consuming feature must remain expressible in the GLSL backend
  (scalar ops only) OR be explicitly documented CPU-only (currently: particles, flow
  domain-warp — revisit when GPU path extends).
- Docs: update README's format section as part of each workstream's final commit, not
  piecemeal.

## 9. Risks

| Risk | Mitigation |
|---|---|
| E-values explode scope of validator | Single `evalue.js` choke point; validator delegates |
| Static-detection rewrite regresses existing matrix | Full fixture suite must pass before B work starts |
| Per-pixel E-values tank perf on naive use | Budget warnings + presets steer users to cheap patterns |
| Studio round-trip loses unknown fields | Carry-through raw-tree policy + round-trip tests on gallery |
| Scrubbing breaks with future stateful effects | Statelessness is a format invariant (documented; particles comply) |
