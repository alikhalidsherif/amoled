# The `.amo` Scene Format

A `.amo` file is a declarative JSON document describing **spatial RGB emitter
intensity fields over time**. Every scene ultimately defines:

```text
R(x, y, t) → 0..1
G(x, y, t) → 0..1
B(x, y, t) → 0..1
```

The player evaluates the description into a logical RGB framebuffer and feeds
the AMOLED engine, which handles all physical rendering concerns (gamma,
emitter response, PenTile geometry, spill, bloom, color management). Scenes
never duplicate renderer logic.

## Coordinate system (canonical)

| Axis | Range | Notes |
|------|-------|-------|
| `x`  | `0..1` | left → right |
| `y`  | `0..1` | **top → bottom** (`(0,0)` = top-left) |
| `t`  | seconds | one authoritative scene clock |

Aliases available in expressions: `u`/`v` are the same normalized coordinates;
`width`/`height` are the current *logical* pixel grid size. Scenes are
**resolution-independent**: the player picks the logical grid (viewport,
quality policy), and the same scene renders identically at 200×120 or 800×450.
Shape geometry additionally uses height-normalized distances with aspect
correction so circles stay circular on any aspect ratio.

## Top-level schema

```json
{
  "amo": 1,
  "meta":     { "name": "...", "author": "...", "description": "..." },
  "display":  { "gamma": 1.6, "spill": 0.3, "bloom": { "...": 0 } },
  "quality":  { "logicalResolution": { "width": 320, "height": 180 }, "fps": 30 },
  "timeline": { "duration": 8, "loop": true, "keyframes": [] },
  "assets":   { "name": "url" },
  "parameters": { "name": value-or-spec },
  "scene":    { "type": "...", "...": "..." }
}
```

### `parameters` — reusable named values

Any numeric or color-channel slot in a scene may reference a parameter by
name instead of a literal:

```json
"parameters": {
  "omega":   { "value": 2, "min": 0, "max": 12, "step": 0.1 },
  "amplitude": 0.35
}
```

* A parameter is either a shorthand value or an object
  `{ value, min, max, step }` where only `value` is required; the extra keys
  drive generator slider ranges.
* `value` may be a number **or an expression** — `"value": "0.5 + 0.5*sin(t)"`
  makes an animated parameter.
* Names must match `[A-Za-z_][A-Za-z0-9_]*` and must not collide with built-in
  variables (`x y t u v p frame width height seed progress`), constants
  (`pi tau e`) or functions.
* Parameter expressions see the layer-level environment (no per-pixel `x/y`)
  and may not reference other parameters.

## Expression language

Expressions are safe, deterministic, eval-free strings parsed to an AST at
load time and compiled once. No JavaScript is executed; identifiers are
whitelisted.

Variables: `x y t u v p frame width height seed progress`
Constants: `pi tau e`

Functions: `sin cos tan asin acos atan atan2 abs sqrt pow min max floor ceil
fract mod clamp mix lerp smoothstep step exp log sign distance length noise`

Grammar: ternary `?:`, comparisons, `+ - * / %`, unary minus, right-associative
`^`. Division by zero yields ±∞ (clamped downstream); outputs clamp to
`0..1` per channel. All randomness is seeded — same file + same time ⇒
identical output on every device and every FPS.

## Scene types

| Type | Purpose |
|---|---|
| `color` | Solid color; channels accept expressions |
| `gradient` | 2-stop gradient (`vertical/horizontal/diagonal/radial`) |
| `livingGradient` | Multi-stop animated gradient with sinusoidal wobble |
| `conicGradient` | Color sweep around a center point |
| `waves` | Traveling plane wave: wavelength/amplitude/speed/angle/phase |
| `pattern` | `dots checks stripes scanlines halftone grid`, soft edges, angle, offset |
| `shape` | `circle ring rect line` primitives with soft edges; E-value geometry means an expression center is a **moving emitter** |
| `flow` | Domain-warped fbm noise through a palette |
| `particles` | Stateless seeded systems (drift/orbit/rise/fall/fireflies/snow) |
| `curve` | Parametric math art via `x(p)`/`y(p)` expressions with glow |
| `expression` | Per-pixel fields: `r`, `g`, `b` expressions of `x y t` |
| `image` / `gif` / `video` | Media sources sampled into the same field model |
| `composite` | Layer stack: blend modes (`normal add multiply screen overlay`), opacity, clip rect, scale, rotation |

All primitive types compile down to the same RGB field representation —
there is exactly one evaluation pipeline:

```text
.amo → parse → validate → compile expressions → runtime clock
     → field rasterization → logical RGB framebuffer → AMOLED engine → canvas
```

## Layers

Composite layers support per-layer E-value slots (`opacity`, `scale`,
`rotation`, `offset{x,y}`, `rect{x,y,w,h}`) — numbers or expressions of `t`.
Layer transforms evaluate once per frame; they do not vary per-pixel.

## Time model

The runtime owns one deterministic clock. Scrubbing to any `t` reproduces the
exact frame regardless of playback history or FPS. If no expression anywhere
references `t`/`frame` (including parameters) and no keyframes exist, the
scene is **static** and renders exactly once — zero idle CPU.

Keyframes animate whitelisted display properties (not scene structure).

## Versioning & safety

* `"amo": 1` is the only version; the validator rejects unknown versions with
  precise error paths and warns on unknown fields.
* Expressions are untrusted input handled by a sandboxed parser — there is no
  `eval`, no property access, no host bindings.
* NaN/Infinity anywhere in the file is rejected at parse time.

## Examples

See `scenes/*.amo` — in particular `three-phase.amo` (canonical R/G/B phase
offsets driven by an `omega` parameter), `three-phase-scope.amo` (the same
signals as oscilloscope traces) and `orbiting-emitters.amo` (moving emitters
on parametric orbits).
