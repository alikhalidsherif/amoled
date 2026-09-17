# Signal Lab & Resizable UI — Specification

**Status:** Spec finalized for implementation — rev 4. Rev 2: strict signal-space vs pixel-space variable allocation (§4.0). Rev 3: explicit knob vocabulary (`frequency` / `sweepSpeed` / `phaseOffset` / `amplitude` / `offset`) with spatial-vs-temporal term ownership, and the canonical three-phase defaults written explicitly (§4.1, §4.2, §9). Rev 4 (final corrections): corrected sweep-speed documentation (§4.2a), corrected custom-expression pipeline (§4.3), UI simplicity rules (§7.1a, §12), simple Background (§7.3), stroke-machinery verification requirement (§5.3a), implementation priority & UX success criterion (§15/§16).
**Date:** 2026-09-17
**Supersedes:** the "Math tab" direction from `sessionmathsim.md`; supersedes the earlier "flat mixed rows" and "Tabs + Advanced" answers from this interview (see the clarification document quoted in Appendix A, which is the controlling statement of direction).

---

## 1. Problem statement

The studio at `generator/index.html` currently presents itself as a math-driven **RGB color animator**. Its default math sheet drives full-screen color channels over time:

```text
R = 0.5 + 0.5*sin(t*2)
G = 0.5 + 0.5*sin(t*2 - tau/3)
B = 0.5 + 0.5*sin(t*2 - 2*tau/3)
```

This produces a solid color transitioning through phase-shifted shades — **the whole screen changes color; nothing moves across it**. The user cannot build the thing they actually want: an **oscilloscope** showing three-phase AC — three colored sinusoidal **traces** (R/G/B, 120° apart) sweeping horizontally and undulating vertically, like a real scope.

Three root causes:

1. **No spatial meaning.** In the current default equations `x`/`y` never appear; `t` alone drives everything. The coordinate system (`x` = across, `y` = down, `t` = seconds) is documented only in `docs/AMO_FORMAT.md`, not in the UI.
2. **No first-class trace concept.** The only way to draw a *line* is a per-pixel Gaussian trick like `exp(-((v - 0.5 - amp*sin(u*tau*cycles - t*tau*speed))^2) / (width*width))` — exactly what the user was told to do and found incomprehensible. Alternatively there is the `curve` scene type (parametric `x(p)`, `y(p)` stroke renderer) — but it is not exposed in the Math tab at all, and it is a "layer", a concept the user explicitly rejected.
3. **The UI is a collection of implementation tabs** (Math / Layers / Design / Source) organized around the renderer's internal model rather than around signals.

Additionally the desktop layout is a hard-coded CSS grid (`minmax(400px, 46%) 1fr`): the preview column and editor column **cannot be resized**.

## 2. Vision

> Evolve the project from a math-driven RGB color animator into a **visual signal / waveform authoring and AMOLED display simulator**.

- The **primary object** is a **trace (signal)**: a mathematical waveform with physical knobs (amplitude, frequency, phase, offset, speed, thickness, color). The user thinks in *signal* terms ("sine at 2 Hz, amplitude 0.35, sweeping left-to-right"), never in per-pixel terms.
- The user writes (or picks) the waveform **shape**; the system owns the signal pipeline that turns it into a moving line on screen.
- `x`, `y`, `t` get clear, documented, consistent meaning, split by space (§4.0): in **signal space** (trace math) `x` = position along the sweep and `t` = time; in **pixel space** (raw field math) `x`/`y` = screen coordinates, `y` top-down. Signal-to-screen mapping is done *by the renderer*, never by the user.
- The raw expression system (`r`/`g`/`b` per-pixel fields over `x y t`) remains fully available for advanced/custom effects — as a lower-level layer **under** the trace model, not a competing one.
- The main UI feels like a **signal laboratory / oscilloscope editor**: Traces, Display, Advanced. Desmos-like: type/pick → immediately see; collapsible; modular; no jargon required.
- The layout is **adjustable**: draggable dividers between preview and editor, resizable editor width, collapsible sections, persisted sizes.

**Immediate goal (acceptance target):** a clean, correct **three-phase oscilloscope** — three editable R/G/B sine traces, 120° phase separation, visibly traveling across the display — as the boot experience.

**Success criterion (final principle):** technically rigorous underneath, extremely simple on top. *I open the app, immediately see three moving colored waves, click one, adjust a few obvious controls, and understand what is happening without needing to learn signal processing or graphics programming.* The primary UI must not feel like scientific instrumentation; the three-phase waveform is the behavior being implemented, not an instruction to make the UI resemble laboratory equipment.

## 3. Non-goals for v1 (architecture must leave room, features stay out)

Per the user's explicit instructions:

- Noise traces, modulation (AM/FM), envelopes, FFT
- XY mode, parametric / Lissajous mode (architecture should anticipate these — the trace pipeline should not hard-assume "y = f(sweep)" any more than necessary)
- Persistence / phosphor trails, triggering, measurement readouts, voltage/time axis labels, scan simulation
- Lanes (per-trace auto-stacking) — explicitly rejected for v1
- Recipes / one-click presets — **explicitly rejected** in a previous session ("i dont want one click magic")

## 4. The trace model

### 4.0 Signal space vs. pixel space (no variable overloading)

There are exactly **two coordinate spaces**, and every expression lives in exactly one of them.

**Signal space — trace math** (built-in waveforms conceptually; `waveform: "custom"` expressions literally):

| Input | Meaning |
|---|---|
| `x` | Normalized horizontal position **along the sweep**, 0..1 (left → right) |
| `t` | Animation time, seconds |
| `p` | Canonical sweep angle `2π·frequency·x − sweepSpeed·t + phaseOffset` (§4.2) |
| `frequency`, `sweepSpeed`, `phaseOffset` | The trace's own knob values, read-only |
| *user parameters* | Named sliders (auto-adoption active), as anywhere else in the format |

Output: a **signal value** — volts-like amplitude, normalized, −1..+1. **Never a screen Y coordinate.** The renderer owns the mapping `signal value + amplitude + offset (+ display vertical scale) → screen Y` (§6). A trace expression has no access to the screen's vertical axis: vertical placement is expressed through the knobs, not through math on pixel coordinates.

**Pixel space — raw per-pixel / color-field math** (existing `expression` scenes, background fields, Advanced raw math — unchanged):

| Input | Meaning |
|---|---|
| `x` / `u` | Normalized horizontal screen position, 0..1 |
| `y` / `v` | Normalized vertical screen position, 0..1, top → bottom |
| `t` | Animation time, seconds |
| … | plus `frame`, `width`, `height`, `seed`, `progress` as documented in `docs/AMO_FORMAT.md` |

Output: per-channel intensity 0..1.

Variable allocation is strict, so trace math and pixel math can never be confused:

- `y` (and its alias `v`) is **pixel-space only** — it is **not** part of the trace expression environment. A custom trace expression referencing `y`/`v` is a validation error with a helpful message ("`y` is a pixel-space variable — a trace takes a signal value; set vertical placement with the Position knob").
- `p` is **signal-space only** (undefined in pixel-space expressions).
- `x` and `t` exist in **both** spaces with identical meaning (horizontal position, time) — shared deliberately because they are unambiguous.
- Knob names `frequency`, `sweepSpeed`, `phaseOffset` are visible to trace expressions as read-only values. `amplitude` and `offset` are **not** inputs to the expression — the renderer applies them afterward (§4.2), so they cannot be double-applied.

### 4.1 First-class concept

A **trace** is a typed row with:

| Property | Meaning |
|---|---|
| `name` | Human label (e.g. "Phase A", "R") |
| `waveform` | One of `sine`, `square`, `triangle`, `sawtooth`, `custom` |
| `expression` | Required when `waveform: "custom"`; see §4.3 |
| `color` | Trace color as hex (e.g. `#ff0000`); **independent of channel** |
| `channel` | *Optional* association with an R/G/B channel (legacy/interop; see §4.5) |
| `frequency` | How many cycles are visible across the screen width (default 2) |
| `sweepSpeed` | How quickly the waveform travels; internally radians/second so the canonical form is exactly `2πfx − st + φ` (default 4 ≈ 0.318 screen-widths/s at frequency 2, per §4.2a) |
| `phaseOffset` | Relative phase vs other traces, radians (serialized name `phaseOffset`; UI label "Phase"; default 0) |
| `amplitude` | Vertical size: screen-height fraction of a full-scale ±1 signal swing (default 0.35) |
| `offset` | DC / vertical shift — position of the trace's center line in **screen** units 0..1, 0.5 = middle (default 0.5); UI label "Position"; the knob that bridges signal space into pixel space |
| `thickness` | Line thickness, normalized units (default 0.02) |
| `enabled` | Toggle visibility on/off without deleting |

Defaults for the boot sheet (three R/G/B traces) should form a good-looking, clearly-animating three-phase scope out of the box.

### 4.2 The deterministic signal pipeline (one pipeline, no double-application)

For **built-in waveforms** (sine/square/triangle/sawtooth), the renderer computes, per pixel of the trace:

```text
p        = 2*pi*frequency*x - sweepSpeed*t + phaseOffset   (signal space: sweep angle)
sig      = waveform(p)                                     (sine → sin(p); etc.)
V        = amplitude * sig                                 (signal value, volts-like)
y_screen = offset - V * verticalScale                      (renderer-only mapping into pixel space;
                                                           offset is in screen units 0..1; §6, §7.2)
```

**Horizontal speed (corrected math — rev 4):** for a waveform with `frequency` cycles visible across the screen, motion in screen-widths per second is

```text
screen-widths/s = sweepSpeed / (2*pi*frequency)
cycles/s        = sweepSpeed / (2*pi)
```

So the canonical defaults (`frequency = 2`, `sweepSpeed = 4`) give ≈ **0.318 screen-widths/s** and ≈ **0.636 waveform cycles/s** (two cycles visible ⇒ the wave crosses the screen roughly every 3.1 s). **Never document `sweepSpeed = 4` as “0.64 screen-widths/s”** — that figure is cycles/s, not screen-widths/s. Use this wording in comments, docs, and help text.

**One knob, one concept** — horizontal position (`x`) and animation time (`t`) enter the sweep angle through **separate terms owned by separate knobs**, which is what gives the intuitive scope controls instead of burying everything inside one enormous expression:

| Knob | Scope meaning | Owns in the pipeline |
|---|---|---|
| `frequency` | how many cycles are visible | spatial term `2π·frequency·x` |
| `sweepSpeed` | how quickly the waveform moves | temporal term `sweepSpeed·t` (rad/s) |
| `phaseOffset` | relative phase vs other traces | static term |
| `amplitude` | vertical size | renderer-side vertical scaling |
| `offset` | DC / vertical shift | renderer-side center-line position |

Key invariants:

- **The knobs own the standard signal parameters. The expression (when custom) owns only the waveform shape.** Never may the expression *and* the knobs independently multiply frequency/amplitude/etc.
- For built-in waveforms the user does not write an expression at all — they pick the waveform and turn the knobs.
- **`p` is the canonical normalized/continuous sweep phase** supplied to custom expressions, so `sin(p)` exactly reproduces the built-in sine. Custom traces are drop-in comparable with built-ins.
- **The renderer owns signal → screen mapping.** Trace math produces a signal value only (§4.0); no trace expression ever reads or computes screen Y.
- One deterministic pipeline end-to-end; same `.amo` + same `t` ⇒ same output bytes (project invariant, unchanged).

### 4.3 Custom expression traces

Custom expressions define the waveform **shape** as a function of the sweep. The pipeline (rev 4, corrected to match built-ins exactly):

```text
p         = 2*pi*frequency*x - sweepSpeed*t + phaseOffset
rawSignal = expression(x, t, p, frequency, sweepSpeed, phaseOffset, <user params>)
V         = amplitude * rawSignal
y_screen  = offset - V * verticalScale        (renderer-only; §4.2a for speed math)
```

- **The custom expression must NOT receive or apply `amplitude` or `offset`.** `amplitude` is applied **after** the expression (scales the whole result — Height). `offset` is applied **only by the renderer** as vertical screen position (Position). No double application of amplitude, frequency, phase, speed, or offset, ever.
- Therefore **`sin(p)` must match the built-in sine waveform exactly**, and `sin(p) + 0.3*sin(3*p)` means *“a waveform shape made from two harmonics”*, after which Height scales the whole result and Position places it vertically.
- **Desmos-style auto-variable adoption stays active inside trace expressions**: typing an invented name (e.g. `damp`) auto-creates a slider in the Variables section, exactly like the current Math tab (`adoptUnknownIdentifiers` in `generator/studio.js`). Typo sliders are deletable, same as today. (Raw `y`/per-pixel manipulation stays available **only** in the advanced/raw expression system — backgrounds and raw expression scenes — never in traces.)

### 4.4 Waveform vocabulary v1

All using the same parameter model (§4.1) and the same pipeline (§4.2):

| Waveform | `waveform(p)` definition |
|---|---|
| `sine` | `sin(p)` |
| `square` | `p mod 2pi < pi ? 1 : -1` (i.e. `sign(sin(p))`, with defined behavior at discontinuities) |
| `triangle` | `2*abs(2*fract(p/tau) - 1) - 1` (equivalent even-line form; exact formula is an implementation detail, must hit ±1 at peaks, 0 at zero-crossings) |
| `sawtooth` | `2*fract(p/tau) - 1` (ramping, resets at `p = tau`) |
| `custom` | User expression per §4.3 |

Square/triangle/saw get soft-edge handling consistent with `thickness` so hard edges don't alias horribly at low logical resolution; exact easing is an implementation detail. **Do not** implement noise/modulation now.

### 4.5 Colors and channels

- **Hybrid model.** A trace may be *associated* with an R/G/B channel for the simple three-phase workflow, but trace color is ultimately independently configurable.
- The default three boot traces bind to R, G, B channels and inherit the obvious channel colors. **Decision (final round): default colors are pure primaries — `#ff0000`, `#00ff00`, `#0000ff`** — maximally unambiguous "R is red" mapping; harshness is acceptable.
- Multiple traces of the same color must be possible. Unbound traces are legal. **No hard-coded assumption of exactly three traces or one-to-one R/G/B correspondence anywhere in the model.**
- Channel binding semantics: for a channel-bound trace, the trace's signal drives *that channel's* emission (this is what makes a "G" trace literally green on the PenTile lattice); an unbound trace drives all channels by its `color` mix. (Implementation may treat unbound traces as color-layer strokes; the distinction is observable only in how the AMOLED subpixel simulation lights up.)

### 4.6 Multi-trace composition

- All traces share **one common oscilloscope coordinate system**, drawn as **independent overlays** (classic scope): no lanes, no auto-stacking.
- Each trace is independently evaluated across the sweep, and the **renderer** maps its signal value into pixel space via amplitude/offset (§4.0, §4.2). Traces can cross and overlap naturally (three-phase must visibly cross).
- Traces have an explicit **render order** (sheet order): later rows render over earlier rows, with normal alpha/color compositing. Overlap blending follows the renderer's existing additive/alpha behavior; thickness and glow determine the visual result.
- Background color-field rows may sit underneath traces (see §7.4).

## 5. `.amo` format extension

### 5.1 Principle

> Represent traces explicitly as typed trace rows/objects. **Do not serialize a trace as a generated per-pixel RGB expression.** The file preserves the author's intent and parameters so it stays readable, editable, and forward-compatible. The renderer derives pixel output from the trace definition at runtime.

### 5.2 New scene type: `scope`

A new top-level scene type holding an **ordered stack of render rows**:

```json
{
  "type": "scope",
  "rows": [
    { "row": "trace", "name": "R", "waveform": "sine", "color": "#ff0000",
      "channel": "r",
      "amplitude": 0.35, "frequency": 2, "phaseOffset": 0,
      "offset": 0.5, "sweepSpeed": 4, "thickness": 0.02, "enabled": true },
    { "row": "trace", "name": "G", "waveform": "sine", "color": "#00ff00",
      "channel": "g",
      "amplitude": 0.35, "frequency": 2, "phaseOffset": -2.0944,
      "offset": 0.5, "sweepSpeed": 4, "thickness": 0.02, "enabled": true },
    { "row": "trace", "name": "B", "waveform": "sine", "color": "#0000ff",
      "channel": "b",
      "amplitude": 0.35, "frequency": 2, "phaseOffset": -4.1888,
      "offset": 0.5, "sweepSpeed": 4, "thickness": 0.02, "enabled": true }
  ]
}
```

(The exact envelope keys — `row` vs `kind`, nesting of trace fields — are an implementation choice; the requirement is **typed trace objects with semantic parameters**, ordered, mixed with field rows.) Serialized names are the explicit semantic ones (`frequency`, `sweepSpeed`, `phaseOffset`, `amplitude`, `offset`, `thickness`) so the file is self-describing; the plain UI labels (Frequency / Speed / Phase / Height / Position / Thickness) map one-to-one onto them. The rows above are the **canonical three-phase**: G lags R by 120°, B lags G by 120° (`phaseOffset` 0 / −2π/3 / −4π/3).

- `waveform: "custom"` rows additionally carry `"expression": "..."`.
- Numeric trace fields (amplitude, frequency, phaseOffset, offset, sweepSpeed, thickness) accept the existing **E-value** convention (number or expression string of `t`) already used across the format, so an animated `phaseOffset` or `offset` is possible without new machinery.
- A background row is the existing color-field row type inside `rows` (see §7.3) — e.g. `{ "type": "color", "color": "#010a08" }` or an `expression` field layer.

### 5.3a Stroke machinery: verify before reuse (rev 4)

The plan reuses the `curve` scene's `splatSegment` machinery — **only after verifying** it provides, for trace requirements:

- trace **thickness** with normalized-resolution scaling
- **glow / falloff** behavior suitable for traces
- **overlapping trace compositing** (additive/alpha) with correct render order
- correct **color / channel** behavior (channel-bound vs unbound traces; PenTile behavior — channel-bound traces must light the correct subpixel columns)
- **resolution independence** (same scene at 160×90 and 640×360 differs only in detail)

Reuse it where appropriate, but **do not distort the trace abstraction to fit assumptions made specifically for `curve` scenes** (e.g. curve's fixed math-y-up mapping, `samples`-based splatting density, its `bg` fill). If a capability is missing (e.g. per-channel emission control), extend the shared machinery or the trace rasterizer — do not emulate it via per-pixel tricks. Document findings in the trace rasterizer module header.

### 5.3 Compatibility

- Existing scene types (`expression`, `composite`, `curve`, `flow`, …) remain **fully valid and untouched**. Traces are additive.
- The Math sheet / studio "simply supports additional row types rather than replacing the existing system."
- Validator: new type added to `KNOWN_SCENE_TYPES` (`src/scene/validator.js`); validate/clamp trace fields (amplitude ≥ 0, frequency sane range, thickness bounds, waveform ∈ vocabulary, expression compiles, channel ∈ {r,g,b} | null, color parses). Clamp-with-warning per existing conventions. Custom trace expressions compile in the **signal environment** and must not reference pixel-space variables (`y`/`v`) — reject with the §4.0 guidance message, not a generic error.
- Rasterizer: new branch in `rasterize()` (`src/scene/rasterizer.js`). **Reuse the existing `curve` scene's `splatSegment` stroke machinery** (additive soft segment splatting with thickness/glow falloff) for trace strokes — this avoids a second rendering system and inherits correct additive color compositing between overlapping traces.
- GPU path: v1 ships CPU rasterization only (the existing GLSL fast path is expression-scene-scoped and off by default). Note as documented debt, mirroring the composite-on-GPU precedent.

## 6. Scope coordinate system & display mapping (canonical, documented)

Two spaces, never blended (full variable tables in §4.0):

| | Signal space (trace math) | Pixel space (raw fields / backgrounds / Advanced) |
|---|---|---|
| Horizontal | `x` — position along the sweep, 0..1 | `x` / `u` — screen position, 0..1 |
| Vertical | *not exposed — vertical placement comes from the Position/offset knob, applied by the renderer* | `y` / `v` — screen position, 0..1, top → bottom |
| Time | `t` — seconds | `t` — seconds |
| Sweep angle | `p` — `2π·frequency·x − sweepSpeed·t + phaseOffset` | *not defined* |
| Output | **signal value** −1..+1 (volts-like amplitude) | per-channel intensity 0..1 |

Mapping (renderer-internal; users never do this math):

```text
y_screen = offset - amplitude * waveform(p) * verticalScale        (§4.2, with §7.2 scale)
```

- **Volts-model, −1..+1**: expression/waveform output is a normalized signal amplitude; 0 = the trace's center line; amplitude scales it; offset shifts the center. `sin()` plots naturally. This domain is kept **separate from normalized screen coordinates** so users think in signal/voltage, not pixels.
- **Screen `y` is top-down** (format-wide convention). The mapping above already handles "positive signal = up on screen" via the minus sign; document this in the UI help text ("higher signal = higher on screen").
- **UI language (explicit decision): do not say "volts" in the normal UI.** Labels: **Height** (amplitude), **Position** (offset), **Frequency**, **Phase**, **Speed**, **Thickness**. Tooltips in plain language, e.g. Position: "moves the line up or down." Mathematical rigor lives internally. Technical coordinate-space detail is progressive (§12, rev 4): plain-language help in the main workspace, full signal/pixel-space explanation only in Custom Expression help / Advanced.
- A DISPLAY-level **vertical scale** knob (scope-wide, like volts/div but not called that) scales all traces' `y` positions together — see §7.2.
- The coordinate conventions **must be documented clearly in the UI/help text** — currently it is not obvious what `x`, `y`, `t` represent: signal space (`x` sweep, `t` time, `p` sweep angle, output −1..+1) vs pixel space (`x`/`y` screen coordinates, output 0..1). E.g. a collapsible "How this works" hint at the top of the Traces section, plus tooltips on `x`, `t`, `p` in the expression editor autocomplete metadata.

## 7. UI redesign (primary workspace)

### 7.1 Information architecture

Replace the current tab navigation (Math / Layers / Design / Source) as *primary* navigation. The main panel is a **single scrolling, modular, collapsible workspace** ("think like desmos, collapsible, modular"):

```text
┌ SCENE ─────────────────────────────────────┐
│  mode: waveform / signal (scope)           │  (v1: one mode; field is a
├ TRACES ────────────────────────────────────┤   stub the architecture can grow)
│  ┌─ R ──────────────────── [enabled] ─┐    │
│  │  waveform: sine ▾   color: ▇ #ff0000│   │
│  │  height      ●──── 0.35             │   │
│  │  frequency   ●──── 2.00             │   │
│  │  position    ●──── 0.50             │   │
│  │  speed       ●──── 4.00             │   │
│  │  ▸ More: phase ● 0.00, thick ● 0.02 │   │  ← visually secondary (rev 4)
│  │  (collapsible card)                 │   │
│  └─────────────────────────────────────┘    │
│  ┌─ G ─ … ┐  ┌─ B ─ … ┐                     │
│  [+ add trace]                              │
│  [+ background]  ← simple color control (rev 4)
├ DISPLAY ───────────────────────────────────┤
│  vertical scale  ●──── 1.0                 │
│  grid            [on]  center line  [on]   │
│  glow            ●──── 0.6                 │
│  brightness      ●──── 1.0                 │
├ ▸ ADVANCED ────────────────────────────────┤   (collapsed by default)
└────────────────────────────────────────────┘
```

- **Desmos behavior everywhere**: drag a knob → live preview; every control is directly manipulable; sections/cards **collapsible**.
- **UI simplicity rules (rev 4):** the primary card controls are **Waveform, Color, Height, Frequency, Position, Speed**. **Phase and Thickness stay available** but visually secondary — inside a small expandable **“More”** area in each trace card if needed to prevent clutter. Every control gets a short plain-language tooltip (Height: “How tall the wave appears.” Position: “Moves the wave up or down.” Frequency: “How many waves are visible across the screen.” Speed: “How quickly the wave moves across the screen.” Phase: “Shifts the wave relative to the others.” Thickness: “Changes the thickness of the line.”). Do not add readouts, meters, engineering labels, or “oscilloscope simulator” decoration — the three-phase waveform is the behavior being implemented, not a style brief. Nothing is removed; presentation is simplified.
- No jargon in the primary view: the words "layer", "blend", "expression field", "composite", "source" never appear outside Advanced. A user can open the app and understand what to click without knowing any of them.
- The preview must feel alive: every knob and expression edit updates the running preview immediately (existing `commitEdits`/`loadToPlayer` flow, with its existing debounce).

### 7.2 DISPLAY section (v1 scope — final decisions)

Selected: **vertical scale, grid, glow, trace thickness (per-trace), brightness** — "only things that make the preview immediately easier to understand or nicer to look at."

| Control | Disposition |
|---|---|
| **Grid / guides** | Graticule: faint division grid + border ticks, toggleable |
| **Center line** | Horizontal zero/center line — "very useful because it makes the vertical zero point obvious"; toggleable |
| **Vertical scale** | DISPLAY-level y-scale for all traces (not labeled "volts") |
| **Glow** | Exposes existing bloom/spill display settings under a friendly name — no new engine work |
| **Brightness** | Existing active-level setting, relocated/friendly-named |
| **Trace thickness** | Per-trace knob in the trace card (already §4.1) |

**Deferred to roadmap:** persistence/trails, triggering, measurements/readouts, axis/voltage labels, scan simulation.

**Grid/center-line = studio-only preview overlay — explicit decision:** *not* part of the animation, **not serialized in the `.amo`, not rendered through the AMOLED simulator**. Like the existing pixel inspector, it is a screen-space overlay drawn over/around the preview canvas in the generator only. Exported scenes contain just traces + fields; any player decides its own look. (Implementation note: draw the graticule on a separate absolutely-positioned canvas/element above `#preview-canvas`, pointer-events: none; do not touch `display.bloom`/engine config to fake it.)

### 7.3 Backgrounds (simple in primary UI — rev 4)

- A simple **`+ Background`** action at the bottom of the Traces section — visually separated from trace rows (divider + subdued styling).
- **The primary Background control is a simple color/background feature**: pick a color (swatch), done. **No raw mathematical expression editor in the normal Background UI.** Procedural gradients/effects remain available through the existing raw field machinery in **Advanced**.
- Internally the background is still the existing color-field row type under all traces (`color` row by default; an `expression` field when created via Advanced). Raw color-field rows are **not** shown mixed into the trace list. Advanced users can access the underlying field expression through Advanced.
- More than one background row is allowed via Advanced; the primary UI shows a single background slot (with a link into Advanced if one exists and is non-trivial).

### 7.4 ADVANCED section (collapsed by default)

- **Collapsed by default**; expanding reveals the existing lower-level tooling, preserved as-is:
  - **Layers** (composite editor, blend modes, order, transforms)
  - **Raw expressions** — the old Math tab's R/G/B field rows (final decision: the old Math tab **becomes part of Advanced**, it does not disappear; it does not remain a top-level tab)
  - **Design** (display personality: gamma, spill, bloom detail, quality/fps/resolution, timeline)
  - **Source** (round-tripping `.amo` JSON pane)
- Also reachable: the background's underlying field expression (§7.3).
- The Advanced toggle state may persist with layout settings (§8) — a session preference, not a scene property.

### 7.5 Scene chrome

- SCENE header holds: scene name, mode display ("waveform / signal"), import/export (existing), and (v1) a single mode stub. Mode switching beyond scope is explicitly out of scope; the architecture just shouldn't preclude a second mode later.

## 8. Resizable, fluid layout

Requirements from the user, verbatim in spirit:

1. **Main preview/canvas resizable relative to the editor** — draggable divider between preview and editor.
2. **Left/sidebar/control panel width draggable** (the preview column and the editor column are the two panes; the divider between them is the primary divider; the editor column itself scrolls).
3. Layout responds **fluidly** while dragging: canvas resizes live with **no awkward jumps, no minimum sizes that trap content, no controls becoming inaccessible**. The renderer must react correctly to new dimensions (engine already handles container resize via `resize()`/observer — verify no FBO thrash mid-drag; coalesce resize events).
4. **Persist reasonable UI dimensions** where appropriate: divider position(s) and section collapse states in `localStorage`; reload restores your layout. Sensible defaults on first run / on reset.
5. Collapsible where applicable — the editor sections (SCENE/TRACES/DISPLAY/ADVANCED and each trace card) fold away; the whole editor can collapse to give the preview the full width.
6. Touch: dividers draggable on touch devices; below the existing mobile breakpoint (~1000px, `generator/index.html` media query) the layout falls back to the current stacked/scrolling behavior (dividers hidden).
7. Double-click a divider resets it to the default position. Keyboard accessibility: dividers are focusable and arrow keys nudge the split (cheap, aligns with the project's a11y-ish touch points like `aria-label`s already present).

Implementation guidance: replace the fixed `grid-template-columns: minmax(400px, 46%) 1fr` with a CSS variable (e.g. `--split: 46%`) set from JS; drag handlers update the variable; canvas resize observer does the rest. No layout library needed (no-build-step rule).

## 9. Boot experience & default sheet

- **Boot default = the three-phase oscilloscope demo as a live, editable trace sheet**: three R/G/B trace rows, visible animation, sensible defaults (frequency 2, amplitude 0.35, sweepSpeed 4 rad/s ≈ 0.318 screen-widths/s ≈ 0.636 cycles/s, thickness 0.02, positions centered), with the **canonical three-phase relationship stated explicitly** — this is the canonical relationship the UI must demonstrate:

  ```text
  R: sin(2π·f·x − s·t + 0)
  G: sin(2π·f·x − s·t − 2π/3)      (G lags R by 120°)
  B: sin(2π·f·x − s·t − 4π/3)      (B lags G by 120°)
  ```

  i.e. `phaseOffset` = `0`, `−2π/3` (−2.0944), `−4π/3` (−4.1888).
- Every part editable — it is a starting scene, not a hardcoded demo.
- It doubles as the **reference example** for learning what `x`, `t`, `p`, Frequency, Speed, Phase, Height, and Position each do — one knob, one concept (§4.2).
- The previous "default demo scene" confusion ("why does it have a default thing always") is resolved by making the default *the thing the user is trying to build* — an alive, obviously-editable scope, in the obvious primary workspace.

## 10. Examples & migration

- **Retrofit flagship waveform examples** to first-class traces where appropriate — `three-phase.amo` (the solid-color one is superseded by the boot sheet but stays loadable as a "channel-driven colors" demo or is retrofitted; retrofit preferred for coherence) and `three-phase-scope.amo` (convert from three `curve` layers to three trace rows carrying the canonical `phaseOffset` values 0 / −2π/3 / −4π/3 — it becomes the flagship/default introductory example).
- **Keep all existing examples available.** Waveform/signal-based ones convert to traces; ones demonstrating raw fields, layers, blends, or unusual math (flow, fireflies, parallax, composite, plasma, dots…) stay on the lower-level system unchanged. Do not force everything into traces.
- **Non-trace scenes in the primary view (final decision): "Hint + Advanced."** When a loaded scene contains no `scope` rows, the Traces section shows a friendly note ("this scene uses advanced layers — it renders fine; edit it in Advanced") with an **Open in Advanced** button. Preview keeps working; no auto-conversion, no silent mutation.
- The gallery lives inside Advanced or as a compact picker in the SCENE header — implementation choice; it must not turn the primary workspace back into a tab farm.

## 11. What stays untouched (architecture invariants)

From `PLAN.md` and the existing codebase — all preserved:

- Dependency direction `generator → .amo → player → engine`; the engine never learns about traces. Traces are **scene-layer** semantics: the rasterizer (scene module) compiles trace rows into the same logical RGB framebuffer feeding `loadFrameBuffer(w,h,data)`.
- Existing scene types, expression language, parameters system, blend modes, quality negotiation, static-scene invariant (a scope scene with static rows and time-independent knobs is static; any `sweepSpeed ≠ 0` or animated E-value makes it animated — the existing AST/static walk generalizes to trace fields).
- Determinism: seeded, no `Math.random()`, same input ⇒ same bytes.
- Resolution independence: trace geometry in normalized units; stroke thickness already scales via the height-normalized `splatSegment` approach.
- No build step; native ES modules; Node-testable scene modules (§13).
- Existing named-parameter sliders, auto-adoption, expression editor (highlight/autocomplete/errors), transport (play/scrub/step/speed), pixel inspector, export/import all carry over and remain available.

## 12. User-facing help & documentation

- **Progressive help (rev 4):** the main Traces workspace does **not** permanently display signal-space vs pixel-space explanations or any raw renderer concepts. Instead, a small unobtrusive **“How this works”** affordance (collapsible help) gives plain-language answers only:
  - “A trace is a moving waveform.”
  - “Height controls how tall it is.”
  - “Position moves it up or down.”
  - “Frequency controls how many waves are visible.”
  - “Speed controls how quickly it moves.”
  - “Phase shifts the wave relative to the others.”
  Detailed explanations of `x`, `t`, `p`, signal space, pixel space, and expression environments belong in **Custom Expression help** and in **Advanced** — shown when the user actually opens those surfaces.
- Expression editor autocomplete metadata for trace rows should describe `p` ("sweep angle: 2π·f·x − sweepSpeed·t + phaseOffset; sin(p) = the sine trace") and must **not** offer `y`/`v` in trace rows — those belong to pixel-space fields (backgrounds, raw expressions). This detail lives in the Custom Expression editor surface, not the main workspace.
- `docs/AMO_FORMAT.md`: new `scope` type section, trace schema table, pipeline formula, channel-vs-color semantics.
- `README.md`: feature bullet + updated authoring paragraph (signal lab, traces, resizable studio).
- Update `PLAN_GENERATOR_OVERHAUL.md` or add a section noting the trace-first pivot so future sessions don't reintroduce the tab-first model.

## 13. Testing strategy (project conventions: plain `node tests/*.test.js`, exit-code pass/fail)

| Test | Covers |
|---|---|
| `tests/scope-scene.test.js` (new) | Parser/validator: valid scope scene round-trips; rejects/clamps bad trace fields (amplitude < 0, unknown waveform, broken custom expression, bad channel); trace custom expression referencing pixel-space `y`/`v` rejected with the §4.0 guidance message; static-detection (`sweepSpeed ≠ 0` ⇒ animated; everything static ⇒ static); parameters in trace E-values resolve |
| `tests/scope-raster.test.js` (new) | Golden bytes on tiny buffers: sine trace with known amplitude/offset/phase hits expected pixels; `sin(p)` custom ≡ built-in sine (tolerance ±1 LSB); **canonical three-phase relationship: G ≡ R with `phaseOffset −2π/3`, B ≡ R with `phaseOffset −4π/3` (golden bytes)**; square/triangle/saw spot values; two traces overlap additively; background row renders under traces; disabled trace invisible; thickness scales with resolution (resolution independence) |
| `tests/examples.test.js` (extend) | Retrofitted `three-phase-scope.amo` (trace-based) validates and rasterizes; all legacy scenes still pass |
| Browser regression (`tests/browser/studio-overhaul.mjs` or successor) | Boot = scope sheet with 3 editable trace cards; dragging a knob changes `workingRaw` and the preview reloads; waveform dropdown switches type; add/remove trace; enable toggle; `+ background` adds a field row under traces; Advanced opens the legacy editors; divider drag updates `--split` and canvas rect; localStorage persistence round-trips; custom-trace auto-variable adoption still works |
| Existing suite | All current Node + browser tests stay green (trace work is additive) |

## 14. Acceptance criteria (definition of done for v1)

1. **The canonical demo:** boot shows three separate sinusoidal traces (R `#ff0000`, G `#00ff00`, B `#0000ff`) in the canonical three-phase relationship — **G lags R by 120°, B lags G by 120°** (`phaseOffset` 0 / −2π/3 / −4π/3) — visibly **traveling horizontally** and undulating, with glow, on the PenTile-simulated display — and every value is editable in the primary UI with immediate live preview.
2. Typing a **custom expression** (e.g. `sin(p) + 0.3*sin(3*p)`) into a trace changes its shape immediately; amplitude/offset knobs still apply; `sin(p)` is indistinguishable from the built-in sine.
3. **No user-written `exp(-distance²)` anywhere**; no per-pixel knowledge required for any trace operation.
4. The divider between preview and editor **drags fluidly** (canvas resizes live, renderer correct); position persists across reload; double-click resets; touch works; mobile falls back to stacking.
5. Sections and trace cards **collapse**; Advanced is collapsed by default and contains Layers / raw expressions / Design / Source intact.
6. Old `.amo` scenes load; non-trace scenes show the hint + Open-in-Advanced; example gallery still fully functional.
7. Grid + center-line overlay toggle from DISPLAY; they do **not** appear in exported `.amo` and are not rendered by the simulator.
8. All Node and browser tests green; `docs/AMO_FORMAT.md` and README updated.

## 15. Suggested implementation order (simplest coherent version first)

1. **Format + validator + CPU rasterizer** for the `scope` scene type: trace rows, pipeline (§4.2), reuse `splatSegment`; background rows = existing field rows. Golden tests (§13).
2. **Retrofit `three-phase-scope.amo`** to traces; verify byte-sane rendering through the existing player/engine; add boot default.
3. **Primary UI**: SCENE/TRACES/DISPLAY sections, trace cards with knobs, waveform dropdown, color picker, enable toggles, `+ add trace` / `+ background`; wire to `workingRaw` + existing commit/preview flow.
4. **Advanced section** wrap of existing tabs (Layers / raw expressions / Design / Source) + non-trace-scene hint.
5. **Resizable layout**: CSS-variable split, drag/touch/keyboard/dbl-click, persistence; verify renderer resize behavior mid-drag.
6. **Grid/center-line overlay** (studio-only canvas), glow/brightness friendly exposure.
7. **Docs, examples retrofit, test suite extension**, full run.

Steps 3–5 are independently shippable; step 1–2 are the foundation the UI wires into.

---

## Appendix A — Controlling clarification (user's own words, 2026-09-17)

*(Quote preserved verbatim. Note: §4.0/§6 refine its `y` wording — `y` is a **pixel-space** screen variable for raw expressions; in trace math the vertical axis is reached only through amplitude + offset, applied by the renderer.)*

> I want to clarify the intended direction of this project so the implementation does not get trapped in the current UI/model. The project should evolve from a math-driven RGB color animator into a visual signal/waveform authoring and AMOLED display simulator. The key use case I want to support first is an oscilloscope-like display showing three-phase AC: three separate colored sinusoidal traces, phase shifted by 120°, moving continuously across the display.
>
> The current default expressions … only change the RGB values over time. This produces a full-screen color transition. That is not the behavior I want for an oscilloscope.
>
> I want x, y, and t to have clear spatial/temporal meaning. x: horizontal position across the display; for oscilloscope mode this is the horizontal sweep/time axis. y: vertical position across the display; this represents the signal's vertical amplitude/voltage position. t: animation time; it continuously advances and lets the waveform move/animate.
>
> For example, a traveling three-phase waveform could conceptually be: R = sin(2*pi*frequency*x − speed*t), G = sin(2*pi*frequency*x − speed*t − 2*pi/3), B = sin(2*pi*frequency*x − speed*t − 4*pi/3). The renderer should interpret the output of those functions as signal values and draw visible traces at the corresponding y positions. The user should NOT have to manually create an expression such as exp(−distance²) just to turn a mathematical waveform into a visible line.
>
> Instead, introduce a first-class concept of a TRACE / SIGNAL. A trace should have: mathematical expression, amplitude, frequency, phase, vertical offset, horizontal/sweep speed, thickness, color/channel, enable/disable. The system should internally convert the signal into pixel data for the AMOLED renderer. The existing raw expression system should remain available for advanced/custom effects … a higher-level authoring layer on top of it.
>
> The architecture should leave room for: sine, square, triangle, sawtooth, noise, arbitrary functions, multiple simultaneous traces, DC offset, modulation, XY mode, parametric/Lissajous mode, eventually oscilloscope-style grid, trigger, persistence, measurements, etc. Do not implement all of those immediately unless necessary for the architecture. The immediate goal is a clean, correct three-phase oscilloscope.
>
> UI requirements: (1) the main preview/canvas should be resizable relative to the editor; (2) the divider between preview and editor should be draggable; (3) the left/sidebar/control panel should also have a draggable width; (4) the layout should respond fluidly to resizing rather than assuming a fixed canvas size; (5) persist reasonable UI dimensions where appropriate; (6) advanced/low-level concepts such as layers, blends, low-level expressions, etc. should remain available but be hidden behind an Advanced toggle by default; (7) the primary workflow should be understandable without knowing graphics programming or shader math. The main UI should feel more like a signal laboratory / oscilloscope editor than a collection of implementation tabs.
>
> A possible primary workflow: SCENE (waveform / signal mode) → TRACES (R: expression, amplitude, frequency, phase, offset, speed, thickness; G: …; B: …) → DISPLAY (vertical scale, grid, brightness, persistence/glow) → ADVANCED (raw x/y/t expressions, RGB pixel expressions, layers, blends, low-level renderer controls).
>
> Most importantly, do not implement the oscilloscope by simply making R/G/B values vary with t. The waveform must vary across x and be mapped to y, with t controlling animation/sweep over time. The three-phase example should visibly produce three separate sinusoidal traces with 120° phase separation, moving smoothly across the display.
>
> Please inspect the existing architecture before changing it and preserve existing functionality where practical. Avoid creating a second incompatible rendering system if the existing expression renderer can be extended cleanly. Also make sure the underlying coordinate conventions are documented clearly in the UI/help text, because currently it is not obvious to a user what x, y, and t actually represent. Build the simplest coherent version of this architecture first, then verify it with the three-phase oscilloscope example.

## Appendix B — Interview decisions ledger (Q → decision)

| # | Topic | Decision |
|---|---|---|
| 1 | Priority | Both resizable layout and scope authoring together, one pass |
| 2 | Trace authoring model | High-level waveform/trace system; x/y/t fundamental; renderer converts signal → pixels; extend existing renderer, no second system |
| 3 | Advanced tabs | Hidden behind an Advanced toggle by default |
| 4 | Knob ownership | Knobs own standard signal parameters; expression owns waveform shape; `signal = amplitude * waveform(phase) + offset`; never double-apply |
| 5 | Waveforms v1 | sine, square, triangle, sawtooth, custom — one shared parameter model; no noise/modulation yet; room for more later |
| 6 | Format | Typed trace rows/objects in `.amo`; semantic parameters, not generated RGB; existing field rows stay compatible; Math sheet supports additional row types |
| 7 | Trace layout | Overlaid, shared scope coordinates, explicit render order, later-over-earlier, natural color blending; no lanes |
| 8 | Custom expression env | Receives `x`, `t`, knob values, and canonical sweep angle `p`; outputs −1..+1 signal; amplitude/offset applied after; `sin(p)` ≡ built-in sine |
| 9 | Grid | Studio-only overlay; not in `.amo`; not rendered by the AMOLED simulator |
| 10 | Backgrounds | `+ Background` action in main workspace, visually separated; internal color-field mechanism; raw expression accessible via Advanced |
| 11 | Examples | Retrofit flagship waveform examples to traces; keep all others as-is; three-phase scope = clearest/default intro |
| 12 | Old Math tab | Becomes part of Advanced |
| 13 | Auto-variables | Keep Desmos-style auto-adoption in trace expressions |
| 14 | Default trace colors | Pure primaries `#ff0000` / `#00ff00` / `#0000ff` |
| 15 | Legacy scenes in primary view | Hint + "Open in Advanced"; no auto-conversion |
| 16 | DISPLAY v1 | Vertical scale, grid, center line, glow (existing bloom), brightness, per-trace thickness; plain-language labels (Height/Position/Frequency/Phase/Speed/Thickness; never "volts"); persistence/trigger/measurements deferred |
| 17 | UI structure | Single primary workspace: Traces / Display / Advanced; old tabs behind Advanced; Desmos-like, collapsible, modular |
| 18 | Resizing | Fluid live drag (preview + editor), no trapped minimums; persist dimensions; collapsible sections; touch support; (added in spec: dbl-click reset, keyboard nudge) |
| 19 | Boot default | Editable 3-phase scope trace sheet as the reference example |
| 20 | Signal vs pixel space | Trace expressions run in **signal space** — inputs `x` (sweep), `t`, `p` (sweep angle), knob values; output is a **signal value −1..+1, never a screen Y**. The renderer maps signal + amplitude + offset → screen Y. `y`/`v` are reserved for raw pixel-space expressions; `p` exists only in signal space; `x`/`t` shared with identical meaning; no variable overloading |
| 21 | Knob vocabulary & canonical defaults | Explicit semantic names `frequency`, `sweepSpeed`, `phaseOffset`, `amplitude`, `offset` (plain UI labels: Frequency, Speed, Phase, Height, Position, Thickness). Sweep angle = `2π·frequency·x − sweepSpeed·t + phaseOffset`: spatial and temporal terms owned by separate knobs. Boot three-phase demonstrates the canonical form `sin(2π·f·x − s·t + {0, −2π/3, −4π/3})` |
| 22 | Sweep-speed math | `screen-widths/s = sweepSpeed / (2π·frequency)`; canonical defaults (f=2, s=4) ⇒ ≈0.318 screen-widths/s ≈ 0.636 cycles/s. Never say 0.64 screen-widths/s |
| 23 | Custom pipeline | `p` → `rawSignal = expression(x,t,p,frequency,sweepSpeed,phaseOffset,params)` → `V = amplitude·rawSignal` → `y_screen = offset − V·verticalScale`. Expression never receives/applies amplitude or offset; `sin(p)` ≡ built-in sine; no double application |
| 24 | UI simplicity | Primary card controls: Waveform, Color, Height, Frequency, Position, Speed; Phase & Thickness in a secondary “More” area; plain-language tooltips; no readouts/meters/lab decoration; nothing removed, presentation simplified |
| 25 | Progressive help | No permanent signal-space/pixel-space explainer in the primary workspace; plain-language “How this works” affordance; technical detail only in Custom Expression help / Advanced |
| 26 | Background simplicity | Primary Background = simple color control only; no raw expression box in normal Background UI; procedural backgrounds via Advanced |
| 27 | Stroke reuse | Verify `splatSegment` machinery (thickness scaling, glow/falloff, overlap compositing, color/channel/PenTile behavior, resolution independence) before reuse; never distort the trace abstraction to fit curve assumptions |
| 28 | UX priority | Implementation order: data model → rasterizer → default scene → primary UI → Advanced → layout → overlay → background → docs → tests. Success = open app, see three moving waves, click, adjust obvious controls, understand without learning signal processing |
