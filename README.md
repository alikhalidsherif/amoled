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
- **HDR intermediate buffers** — RGBA16F when available, RGBA8 fallback
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
src/diamond-pentile-geometry.js  — Zero-dependency lattice builder
src/frame-buffer.js             — Zero-dependency pixel buffer
src/amoled-gpu-renderer.js      — WebGL2 physical-emitter simulator
src/amoled-renderer.js          — Canvas 2D renderer (fallback)
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
    opticalSpill: 0.05,      // Gaussian spill fraction per emitter
    redMaxOutput: 0.70,      // Per-channel maximum output
    greenMaxOutput: 1.00,
    blueMaxOutput: 0.55,
    redSigma: 0.45,          // Optical spread sigma (pitch units)
    greenSigma: 0.35,
    blueSigma: 0.55,
    supersample: 2,          // Internal resolution multiplier (1-4)
    maxInternalPixels: 33554432,  // Emission-pass fragment budget
    bloomThreshold: 0.70,    // Smooth bloom onset in linear luminance
    bloomPower: 2.0,         // Bloom falloff exponent
    bloomRadius: 12,         // Bloom blur radius (device px)

    inactiveLevel: 0.035,    // Off-pixel brightness (0-1)
    activeLevel: 1.0,        // Active brightness (0-1)
    bloomIntensity: 0.0,     // Glow intensity (0-1)
    maxDevicePixelRatio: 2   // DPR cap for performance
};
```

## Architecture

```
src/
├── config.js                 Engine defaults (incl. physics parameters)
├── frame-buffer.js           RGB pixel buffer
├── diamond-pentile-geometry.js  Subpixel lattice builder
├── amoled-gpu-renderer.js    WebGL2 physical-emitter pipeline
├── amoled-renderer.js        Canvas 2D fallback renderer
├── media-loader.js           GIF/image/video decoder
├── patterns.js               Built-in test pattern
├── gifuct.js                 GIF decoder library (bundled)
└── app.js                    Demo page wiring
tests/
└── lattice-parity.js         Verifies shader lattice == CPU geometry
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
composite.

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
