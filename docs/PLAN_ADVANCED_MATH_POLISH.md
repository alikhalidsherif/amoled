# Plan: Advanced math polish + shape presets + input-system cleanup

**Status**: complete (overnight autonomous passes, 2026-10-17/18 — left uncommitted
for morning review). Pass 1 = shapes/declutter/inputs; pass 2 = AI round-trip +
Layers overhaul (§5).
**Basis**: user report — pasted shape equations (circle/ring/square/cross/ripples) render black;
Advanced tab "too bloated and too confusing"; polish all generator input fields.
Follow-up (pass 2): "copy/paste the hint into an AI bot and ask for shapes/animations";
Layers section audit — "tens of dysfunctional buttons… doesn't actually layer…
editing stuff does weird stuff… impossible to understand".

## 1. Assessment findings

### 1.1 Why the pasted shape equations don't work (root cause, confirmed by node repro)

The pasted (AI-generated) guidance claims `x,y ∈ 0..1`. In this engine **x/y are pixel
coordinates**; the normalized pair is **u/v**:

- CPU: `rasterizeExpression` (`src/scene/rasterizer.js:966`) builds env
  `{t, frame, width, height, u, v, seed, progress}` and sets `E.x=x, E.y=y` per pixel —
  pixels, top-down. `u = x/(w-1)`, `v = y/(h-1)`.
- GPU: `setScene` (`src/player/gpu-rasterizer.js:90-98`) — `x=floor(gl_FragCoord.x)`,
  `y` flipped to top-down, `width=uWidth`, `height=uHeight`, `u,v` normalized.

Consequence: a circle test like `(u-0.5)^2+(v-0.5)^2 < r^2` written with `x,y` samples a
sub-pixel region at the canvas corner → black canvas. Repro (node, 80×60):

| formula (assumes 0..1)            | lit px | mean |
|-----------------------------------|--------|------|
| circle in `x,y`                   | 0      | 0    |
| circle in `u,v`                   | 332    | 23   |

**x/y semantics cannot change** — every existing `.amo` scene, docs, and tests depend on
pixel coordinates. `PIXEL_ONLY_IDENTS={y,v}` applies only to TRACE custom expressions.

Also: all functions/variables the pasted equations use (`exp sqrt abs cos`, `width/height`)
already exist — the failure is purely coordinate semantics, plus a *silent* black result.

### 1.2 Advanced tab / input-field audit (gen/index.html)

- Math hint is a dense prose wall; u/v documented, x/y (pixels) not mentioned at all →
  silent-black trap for anyone pasting x,y-style equations.
- No way to insert a working shape; must hand-type u,v equations.
- Layers pane: two stacked action rows (add/dup/del then ↑/↓), chatty intro, flat h2
  stack (Parameters, Motion preset) with no hierarchy.
- Design pane: `Author` gets its own h2 for a single field.
- Inputs: ad-hoc heights (38px global, 34px buttons, patch overrides at 0/4/6px),
  hardcoded hover hexes (#34343c #303038 #1d1d22 #141418), no thin range-track styling
  (phase 2 plan §5.1 never landed for gen), param rows cramped at mixed heights.

## 2. Implementation plan

### 2.1 Shape presets (`src/scene/shape-presets.js`, DOM-free)

`SHAPE_PRESETS`: `{id, label, r, g, b, params:{name:{value,min,max,step}}}` for
**circle, ring, square, cross, ripples**. Equations authored with `u,v` + `width/height`
aspect correction (isotropic `du*width/height`), soft-shouldered via `exp` (GPU-safe),
all three channels set (white shapes; users can zero channels for red). Params
(`cx, cy, radius|size|freq`) come with real ranges so they appear as usable sliders
(inserted directly into `workingRaw.parameters`, never overwriting existing names).

### 2.2 Math pane (gen/studio.js + index.html)

- Shapes button row above the sheet; click inserts the preset as an equation group —
  same insert flow as `+ add equations` (replace non-equation scene; append to composite
  when equation-based). **Guard trace scenes** (warn instead of wiping — also add the
  missing guard to `btn-add-field`, a pre-existing data-loss footgun).
- Compact 2-line hint + explicit variable legend line
  (`u,v 0..1 · x,y pixels · width,height pixels · t seconds`).

### 2.3 Advanced declutter (gen/index.html)

- Layers: single action row (add/dup/del/↑/↓), shorter intro; Parameters + Motion
  preset become collapsible `<details class="ws-section">` (preset closed by default).
- Design: drop the lone `Author` h2.
- No structural/JS changes to `#advanced-shell` nesting (switchAdvTab selectors stay).

### 2.4 Input system (gen/index.html CSS)

- `--ctl-h: 32px` global control height; buttons 30px; param/trace micro-controls 26px.
- Thin range tracks (3px) + 12px accent thumbs (webkit + moz), focus rings kept.
- Replace hardcoded hover hexes with color-mix/rgba derived from tokens.
- expr-highlight/param rows/matrix controls re-aligned to the same heights.

### 2.5 Tests + docs

- `tests/shapes.test.js` (node): every preset parses through `parseAmo` and rasterizes
  non-black (center pixel bright, >2% lit) via `rasterizeScene`.
- `tests/browser/shapes.mjs`: boot studio → Advanced → Math → insert Circle → model has
  `cx/cy/radius` params + preview lit; insert Ring; trace-scene guard verified.
  Wired into `npm run test:browser`.
- README: math-sheet section gains shapes + coordinate clarification.
- Screenshots (desktop + mobile) of the restyled panes; morning report.

## 3. Non-goals

- Changing x/y semantics, new math functions (all needed ones exist), landing/sim
  redesign, GPU-only features (presets validated through the shared pipeline).

## 4. Results (morning-of report)

- **Root cause answered**: `x,y` are pixel coordinates; `u,v` are the 0..1 pair —
  the pasted equations sampled a sub-pixel corner region → black. Documented in
  README (expression row + studio authoring), the Math-pane hint now carries an
  explicit legend (`u,v 0..1 · x,y pixels · … (equations that assume x,y ∈ 0..1
  paint black)`), and presets sidestep the trap entirely.
- **Shape presets shipped**: `src/scene/shape-presets.js` (DOM-free, shared with
  tests) + SHAPES row in the Math pane. Circle/ring/square/cross/ripples insert
  slidable `cx/cy/radius|size|freq` params (never clobbering existing names) as
  equation groups; trace scenes are guarded (warn, no wipe) — the same guard was
  missing on `+ add equations` (pre-existing data-loss footgun, fixed).
- **Advanced declutter**: Layers action bar merged to one row; Parameters +
  Motion preset are collapsible sections (preset closed by default); the
  Examples gallery moved from mid-panes to the bottom of the Advanced shell;
  lone Author heading dropped; first-open of Advanced now renders the math sheet
  (was blank until an atab click).
- **Input system**: `--ctl-h: 32px` / `--ctl-h-sm: 26px`, buttons 30px, thin
  3px range tracks with 12px accent thumbs (webkit+moz), mono/tabular numerics,
  remaining hardcoded hover hexes tokenized via color-mix.
- **Verification**: `npm test` green (shapes.test.js adds 24 checks incl. the
  black-paint trap regression); `npm run test:browser` green end to end
  (new `shapes.mjs` covers insert flows, guard, param adoption, declutter,
  control heights); desktop+mobile screenshots reviewed.

## 5. Pass 2 — AI round-trip + Layers overhaul

### 5.1 AI round-trip (`src/scene/ai-prompt.js`, DOM-free)

User flow: **copy engine prompt** → paste into any chat bot → bot answers three
lines (`R:` `G:` `B:`) → **paste reply** → inserted as an equation group, invented
names auto-become sliders.

- `ENGINE_PROMPT`: self-contained contract — u,v normalized vs x,y pixels (the
  §1.1 trap, stated first), aspect factor for circles, available functions and
  constants, reserved names (params adopt cleanly), soft-edge style notes, and
  the exact three-line output format `parseAIReply` expects.
- `parseAIReply(text) → {r,g,b} | null`: tolerant of code fences, `R =`/`**G**:`
  styles and surrounding prose; a lone channel line applies to all three
  channels; garbage → `null` (status bar warns, scene untouched).
- Studio wiring: `btn-ai-prompt` copies via Clipboard API with `execCommand`
  fallback (LAN http = insecure context); `btn-ai-paste` reads the clipboard
  with a `prompt()` textarea fallback (permission-deny safe), runs
  `adoptUnknownIdentifiers` per channel, then inserts through the shared
  `insertMathGroup` flow.
- `insertMathGroup(expr)` is now the one insert path for shapes, `+ add
  equations`, and AI pastes. **Behavior change vs pass 1**: it always wraps
  non-expression scenes (waveform/gradient/particles) as the base layer and
  layers equations on top — it no longer replaces a composite that happens to
  contain zero expression layers (data-loss bug caught by the new test).

### 5.2 Layers overhaul (audit findings → fixes)

| # | Finding (before) | Fix |
|---|------------------|-----|
| P1 | Scope scenes were a dead-end after any layering: Traces tab showed "isn't a waveform scene" + destructive wipe; layer editor empty | `activeScopeScene()` — the Traces workspace edits the scene when it is a scope, or the **selected scope layer** in a composite; scope layer editor shows "Edit traces" button; `ensureScopeSelection()` snaps to the first scope layer only while the Traces pane is visible; banner "Editing waveform layer N — other layers keep rendering underneath" |
| P2 | ↑/↓ arrows inverted (list rendered bottom-first) | List renders **top-first** (badge 1 = topmost, editor title matches); ↑ = `moveLayer(+1)`; intro now says "Top of the list renders on top" |
| P3 | Duplicate/Delete/↑/↓ silently no-op on single scenes | del/↑/↓ **disabled** on single scenes; Duplicate wraps the scene into `[scene, copy]` (first step toward blending) |
| P4 | New layers default `normal` (opaque replace) → "doesn't actually layer" | New layers added via the type picker default to `blend: "add"` (AMOLED-natural light stacking); chip descriptions surface non-normal blends |
| P5 | Type picker inline-styled (#101010/#2a2a2a/#888) | Themed via `#type-picker .tp-card/.tp-btn/.tp-desc` CSS (theme tokens) |
| P6 | `describeLayer` missing cases | scope ("N traces"), gradient, color, media; blend suffix on composites |
| P7 | Shapes/+add equations refused waveform scenes | They **wrap and layer over** waveforms (P1 makes traces editable afterwards); "clear sheet" keeps refusing (destructive), now also when a composite contains a scope layer |
| P8 | No AI paste path | §5.1 |
| P9 | `_traceSig` ignored selection | Sig includes scene type + selected layer index + trace count (switching layers rebuilds the workspace) |
| P10 | `trace-mode` body class on pure scope only | Now `!!activeScopeScene()` — gallery hidden while editing scope layers too |
| P11 | "scope" not in type picker | Added (seeds `blankScopeScene()`); the Traces pane's composite note offers "+ Add waveform layer" instead of a destructive wipe |

### 5.3 Tests (pass 2)

- `tests/ai-prompt.test.js` (13 checks): prompt contract (coords, format,
  functions, aspect, reserved names), parser against realistic replies
  (clean/fenced/`=`-style/single-line), rejection cases, and a full
  `parseAmo` round-trip of a parsed reply. Wired into `npm test`.
- `tests/browser/layers.mjs` (new, wired into `test:browser`): single-scene
  button enablement, Duplicate-wraps, top-first badges, scope editor → Edit
  traces → Traces banner, add-trace isolation (sibling scope layer untouched),
  ↑ ordering (DOM + array), themed type picker + scope entry, default
  `blend: "add"`, AI copy/paste (prompt() stub) with param adoption, garbage
  paste rejected without mutation.
- `tests/browser/shapes.mjs` updated: trace-scene insert now expects
  `composite [scope, shape]` + traces still editable (was: guard refusal).
- `tests/browser/studio.mjs` updated: chip selection by type (top-first order).

### 5.4 Verification (pass 2)

- `npm test`: green — 22 suites, `ai-prompt: 13 passed`.
- `npm run test:browser`: green — 19 suites incl. new `layers.mjs`.
  (Run in two chunks; single chained run exceeds the 10-min tool timeout under
  SwiftShader.)
- Screenshots (desktop 1440×900 + mobile 390×844): Math pane with AI row,
  Layers with top-first chips + scope editor, type picker modal,
  composite-traces banner — all reviewed.
