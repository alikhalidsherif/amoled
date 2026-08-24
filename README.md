# AMOLED Diamond PenTile Simulator

**Live demo: https://px.ali.et/**

A pure client-side Diamond PenTile AMOLED subpixel lattice simulator. Renders true emitter geometry — green circles, red/blue diamonds, strict black matrix — directly in the browser with zero backend dependency.

Built for display enthusiasts who want to see and manipulate actual subpixel structure.

## Features

- **GPU physical-emitter simulation (WebGL2)** — every subpixel is treated as a physical light emitter, not a filtered RGB rectangle
- **Linear-light color pipeline** — sRGB → linear → simulate → linear → sRGB; no additive math on gamma-encoded values
- **True Diamond PenTile geometry** — staggered lattice with configurable pitch, black matrix, and shape ratios
- **Emitter response curve** — `L = intensity^γ` (default γ = 1.8), independent of the sRGB transfer function
- **Per-channel physics** — independent maximum output (R 0.70 / G 1.00 / B 0.55) and optical spread σ per color
- **Microscopic optical spill** — anisotropic gaussian halos bleeding into neighbouring subpixels (~5% of energy, tunable)
- **Brightness-dependent bloom** — smooth `max(lum − threshold)^power` extraction, blurred separately from micro-spill
- **Supersampling** — internal render at 1–4× per axis with fragment budget cap, downsampled to output
- **Adaptive quality governor** — watches real render cost against the target FPS and walks supersampling / internal resolution / DPR down (or back up); weak devices start on a light tier automatically
- **HDR intermediate buffers** — RGBA16F when available, RGBA8 fallback
- **WebGL context-loss recovery** — full pipeline rebuild on `webglcontextrestored`
- **Animated GIF support** — frame-by-frame decode via [gifuct-js](https://github.com/nicgirault/gifuct.js), works in all browsers
- **Video playback** — native `<video>` element with client-side rendering
- **Image loading** — drag-and-drop or file picker for PNG, JPG, WebP, BMP, TIFF
- **Canvas 2D fallback** — automatic when WebGL2 is unavailable
- **Aspect-ratio preservation** — letterbox/pillarbox black padding for non-matching sources
- **Auto-density scaling** — adapts to any screen size while keeping subpixels visible
- **Modular architecture** — extract individual components for other projects

## Quick Start

### Docker

```bash
docker compose up -d
# Open http://localhost:8051
```

### Static Server

```bash
python3 -m http.server 8080
# Open http://localhost:8080
```

### Direct

Open `index.html` in a browser.

## Modular Components

Grab these files for a standalone PenTile display element:

```
src/engine/diamond-pentile-geometry.js  — Zero-dependency lattice builder
src/engine/frame-buffer.js             — Zero-dependency pixel buffer
src/engine/amoled-gpu-renderer.js      — WebGL2 physical-emitter simulator
src/engine/amoled-renderer.js          — Canvas 2D renderer (fallback)
```

```html
<script src="diamond-pentile-geometry.js"></script>
<script src="frame-buffer.js"></script>
<script src="amoled-gpu-renderer.js"></script>
<script>
    const sim = new AMOLED.GPUPentileSimulator({
        containerSelector: "#display",
        canvasSelector: "#canvas"
    });

    const data = new Uint8ClampedArray(width * height * 3);
    // Fill with RGB data...
    sim.loadFrameBuffer(width, height, data);
</script>
```

## The `.amo` scene format

A `.amo` file is a declarative JSON scene: **what the display shows** (`scene`),
**how the simulated panel should look** (`display`), and **how much work to spend**
(`quality`). Load it through the player:

```js
const player = new AMOLEDPlayer({ renderer: sim, events });
await player.load("/scenes/forest.amo");   // fetch → parse → validate → play
player.play(); player.pause(); player.scrub(3.2);
```

### Scene types

| Type | Purpose |
|---|---|
| `color` | Solid color; channels accept expressions |
| `gradient` | 2-stop gradient; per-channel expression colors supported |
| `livingGradient` | Multi-stop animated gradient with sinusoidal `wobble` |
| `pattern` | Generators: `dots`, `checks`, `stripes`, `scanlines`, `halftone` — size/thickness/angle/offset all animatable |
| `flow` | Domain-warped fbm noise field mapped through a color palette (the "living background" workhorse) |
| `particles` | Stateless seeded particle systems: `drift`, `orbit`, `rise`, `fall`, `fireflies`, `snow` |
| `curve` | Parametric math art — Lissajous, harmonographs, roses, spirographs via `x(p)`/`y(p)` expressions with glow and damping |
| `expression` | Per-pixel math: `r/g/b` expressions over `x y t u v noise(...)` |
| `image` / `gif` / `video` | Media sources, rasterized to logical resolution |
| `composite` | Layer stack with blend modes (`normal/add/multiply/screen/overlay`), opacity, clip rects, scale + **rotation**, offsets |

### Expressions everywhere

Any numeric or color-channel property can be an **expression string** instead of a
literal:

```json
{ "type": "composite", "layers": [
  { "type": "flow", "palette": ["#020d06", "#175c2e", "#79c98a"],
    "scale": 3.2, "speed": 0.09, "warp": 0.65 },
  { "type": "particles", "behavior": "fireflies", "count": 70,
    "color": "#c8ffb0", "blend": "add" },
  { "type": "color", "color": "#ff8000", "blend": "screen",
    "opacity": "0.5 + 0.4*sin(t*0.7)",
    "scale": "1 + 0.05*sin(t*0.5)",
    "rotation": "0.08*sin(t*0.25)" }
]}
```

Variables: `x y t frame u v width height seed progress`. Functions include
`sin cos abs sqrt pow min max clamp mix smoothstep fract mod distance length noise`.
All randomness is seeded — same `.amo` + same time ⇒ identical output.

### Static-scene invariant

If nothing in a scene references time, it renders **exactly one frame and stops** —
no rAF loop, zero idle CPU. Animated scenes tick at their requested `quality.fps`.

### Display personality per scene

Each `.amo` owns its physical display characteristics via the `display` section:
gamma, spill, bloom (intensity/floor/radius), R/G/B emitter output & sigma,
brightness levels, PenTile geometry, pitch. Scenes request quality
(`logicalResolution`, `fps`, `supersample`) — the device negotiates the final values
and never touches art direction.

### Authoring

The hybrid studio at `/generator/index.html` offers live preview through the real
player, a round-tripping `.amo` source pane, timeline scrubbing, motion presets
(pulse/orbit/sway/flicker/hueDrift/… that expand to plain expressions), and export.
See `scenes/*.amo` for a gallery of every feature.

## API

### `GPUPentileSimulator` / `AMOLEDRenderer`

Both renderers share the same interface; the app picks the GPU one when
WebGL2 is available.

| Method | Description |
|---|---|
| `loadFrameBuffer(w, h, data)` | Load RGB pixel data for rendering |
| `updateConfig(partial)` | Update renderer config at runtime |
| `resize()` | Force viewport recalculation |
| `getStats()` | Get current viewport, grid, and frame info (includes `engine`) |
| `destroy()` | Clean up listeners and observers |

### `ClientMediaLoader`

| Method | Description |
|---|---|
| `load(source)` | Load File, Blob, or URL |
| `startLoop(cb, w, h)` | Start animation loop with setInterval |
| `stop()` | Stop animation loop |
| `setFps(fps)` | Change playback frame rate |
| `getFrame(w, h)` | Read current frame as RGB data |
| `getNativeSize()` | Get original media dimensions |
| `isAnimated()` | Check if media is GIF or video |

### Config

```javascript
AMOLED.DEFAULT_ENGINE_CONFIG = {
    pixelScale: null,        // Manual pitch override (null = auto)
    autoPixelScale: true,    // Auto-density per screen size
    minPixelScale: 1,        // Minimum subpixel pitch (fine detail)
    maxPixelScale: 24,       // Maximum subpixel pitch
    rowPitchFactor: 0.86,    // Vertical stagger ratio
    blackMatrixRatio: 0.22,  // Black matrix spacing
    greenSizeRatio: 0.80,    // Green subpixel size
    diamondSizeRatio: 0.90,  // Red/blue diamond size

    // Physical emitter model (GPU renderer)
    emitterGamma: 1.8,       // Emitter response exponent (L = drive^gamma)
    opticalSpill: 0.40,      // Gaussian spill fraction per emitter
    redMaxOutput: 0.70,      // Per-channel maximum output
    greenMaxOutput: 1.00,
    blueMaxOutput: 0.55,
    redSigma: 0.55,          // Optical spread sigma (pitch units)
    greenSigma: 0.35,
    blueSigma: 0.65,
    supersample: 1,          // Internal resolution multiplier (1-4)
    maxInternalPixels: 33554432,  // Emission-pass fragment budget
    bloomThreshold: 0.45,    // Bloom onset as fraction of peak luminance
    bloomPower: 2.0,         // Bloom falloff exponent
    bloomRadius: 16,         // Bloom blur radius (device px)

    inactiveLevel: 0.035,    // Off-pixel brightness (0-1)
    activeLevel: 1.0,        // Active brightness (0-1)
    bloomIntensity: 0.0,     // Glow intensity (0-1)
    maxDevicePixelRatio: 2   // DPR cap for performance
};
```

## Architecture

```
src/
├── engine/
│   ├── util.js                 Shared engine helpers (single implementations)
│   ├── config.js               Engine defaults (incl. physics parameters)
│   ├── frame-buffer.js         RGB pixel buffer
│   ├── diamond-pentile-geometry.js  Subpixel lattice builder
│   ├── amoled-gpu-renderer.js  WebGL2 physical-emitter pipeline
│   └── amoled-renderer.js      Canvas 2D fallback renderer
├── player/
│   └── quality.js              Adaptive quality governor (ES module)
├── media-loader.js             GIF/image/video decoder
├── patterns.js                 Built-in test pattern
├── gifuct.js                   GIF decoder library (bundled)
└── app.js                      Demo page wiring (ES module bootstrap)
tests/
├── lattice-parity.js           Verifies shader lattice == CPU geometry
└── browser/                    Headless Chrome smoke/regression harnesses
```

## How It Works

The GPU renderer treats the virtual AMOLED as a collection of physical
light emitters:

1. **Emission pass** (supersampled, HDR) — the PenTile lattice is rebuilt
   analytically per fragment. Each nearby emitter samples its logical pixel,
   converts sRGB → linear, applies `maxOutput × drive^gamma`, and contributes
   a hard-edged core shape (circle for G, diamond for R/B) plus an anisotropic
   gaussian spill halo. All light accumulates in linear RGB.
2. **Bloom extraction** — luminance above a smooth threshold is raised to a
   power and scaled; this is a separate, larger-scale effect from micro-spill.
3. **Blur + composite** — separable gaussian blur at quarter res, added to
   the emission buffer in linear space.
4. **Encode** — linear result is converted back to sRGB for the host monitor.

The Canvas 2D fallback draws subpixel shapes directly with a simple bloom
composite. It is an approximation: physical parameters (gamma, sigma, spill,
maxOutput) are WebGL2-only and intentionally not replicated there.

### `.amo` scene system (Phase 3+)

Scenes are JSON files with a `.amo` extension describing WHAT the display
should show; the engine describes HOW the simulated panel renders it.

```js
import AMOLEDPlayer from "./src/player/amoplayer.js";
const player = new AMOLEDPlayer({ renderer: sim });
await player.load("/scenes/gradient.amo");
player.play();
```

- `?scene=<url>` on the demo page routes through the player instead of the
  legacy media loop (single owner of the renderer).
- Static scenes render exactly once — no rAF loop.
- Logical resolution auto-matches display aspect; scenes are resolution-
  independent (normalized coordinates).

```
.amo file → parser → validator → assets → runtime clock → rasterizer
          → loadFrameBuffer / loadSourceTexture → PenTile emitter physics
          → canvas
```

### GPU procedural fast path (Phase 10, opt-in)

Expression scenes can be rasterized by a dedicated WebGL2 context using a
GLSL backend compiled from the same AST (`compileToGLSL`), then handed to the
engine via `loadSourceTexture(w, h, canvas)` — no CPU per-pixel work.
Off by default; enable with `gpuRaster: true`. The CPU path remains the
deterministic reference and is selected automatically on any GPU failure.
Determinism caveat: GPU transcendentals differ in ULPs (±1/255 after
quantization); composite-layer GPU compositing is future work.

### Simulation pipeline

```text
Normal RGB image → linearize → PenTile sampling → individual R/G/G emitters
→ emitter response → microscopic optical spreading → large-scale brightness
bloom → linear accumulation → sRGB encoding → normal monitor
```

These are visual-simulation starting points, not specifications of any
particular AMOLED panel — every parameter is exposed for tuning.

## Browser Support

- **GPU simulation**: any browser with WebGL2; `EXT_color_buffer_float` enables HDR intermediates (RGBA8 fallback otherwise)
- **Canvas 2D fallback**: all modern browsers
- **GIF decode**: All browsers (gifuct-js is pure JavaScript)
- **Video**: All browsers with `<video>` support

## License

MIT
