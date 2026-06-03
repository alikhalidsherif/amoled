# AMOLED Diamond PenTile Simulator

[**Live Demo →**](https://amoled.ali.et)

A pure client-side Diamond PenTile AMOLED subpixel lattice simulator. Renders true emitter geometry — green circles, red/blue diamonds, strict black matrix — directly in the browser with zero backend dependency.

Built for display enthusiasts who want to see and manipulate actual subpixel structure.

## Features

- **True Diamond PenTile geometry** — staggered lattice with configurable pitch, black matrix, and shape ratios
- **Animated GIF support** — frame-by-frame decode via [gifuct-js](https://github.com/nicgirault/gifuct.js), works in all browsers
- **Video playback** — native `<video>` element with client-side rendering
- **Image loading** — drag-and-drop or file picker for PNG, JPG, WebP, BMP, TIFF
- **Bloom/glow effect** — Gaussian blur with additive color mixing
- **Brightness controls** — separate active and off-pixel brightness sliders
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
src/amoled-renderer.js          — Canvas 2D renderer with bloom
```

```html
<script src="diamond-pentile-geometry.js"></script>
<script src="frame-buffer.js"></script>
<script src="amoled-renderer.js"></script>
<script>
    const sim = new AMOLED.AMOLEDRenderer({
        containerSelector: "#display",
        canvasSelector: "#canvas"
    });

    const data = new Uint8ClampedArray(width * height * 3);
    // Fill with RGB data...
    sim.loadFrameBuffer(width, height, data);
</script>
```

## API

### `AMOLEDRenderer`

| Method | Description |
|---|---|
| `loadFrameBuffer(w, h, data)` | Load RGB pixel data for rendering |
| `updateConfig(partial)` | Update renderer config at runtime |
| `resize()` | Force viewport recalculation |
| `getStats()` | Get current viewport, grid, and frame info |
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
    minPixelScale: 3.5,      // Minimum subpixel pitch
    maxPixelScale: 11,       // Maximum subpixel pitch
    rowPitchFactor: 0.86,    // Vertical stagger ratio
    blackMatrixRatio: 0.22,  // Black matrix spacing
    greenSizeRatio: 0.80,    // Green subpixel size
    diamondSizeRatio: 0.90,  // Red/blue diamond size
    inactiveLevel: 0.035,    // Off-pixel brightness (0-1)
    activeLevel: 1.0,        // Active brightness (0-1)
    bloomIntensity: 0.0,     // Glow intensity (0-1)
    maxDevicePixelRatio: 2   // DPR cap for performance
};
```

## Architecture

```
src/
├── config.js                 Engine defaults
├── frame-buffer.js           RGB pixel buffer
├── diamond-pentile-geometry.js  Subpixel lattice builder
├── amoled-renderer.js        Canvas 2D renderer + bloom
├── media-loader.js           GIF/image/video decoder
├── patterns.js               Built-in test pattern
├── gifuct.js                 GIF decoder library (bundled)
└── app.js                    Demo page wiring
```

## Browser Support

- **Full**: Chrome 90+, Edge 90+, Firefox 90+, Safari 15+
- **GIF decode**: All browsers (gifuct-js is pure JavaScript)
- **Video**: All browsers with `<video>` support
- **Bloom**: Requires `ctx.filter` support (all modern browsers)

## How It Works

1. **Geometry engine** builds a staggered Diamond PenTile lattice — green circles at alternating positions, red/blue diamonds filling the gaps
2. **Renderer** maps frame buffer pixels to individual subpixels using normalized grid coordinates
3. **Bloom pass** renders to a 1/4 resolution offscreen canvas, blurs it, and composites with additive blending
4. **Media loader** decodes GIF frames via LZW decompression (gifuct-js), reads video frames via Canvas `drawImage`, and outputs RGB data for the renderer

## License

MIT
