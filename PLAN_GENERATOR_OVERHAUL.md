

# AMOLED / `.amo` Generator Overhaul — Autonomous Implementation Plan

## 0. Mission

Overhaul the existing `.amo` generator into a proper **visual mathematical scene authoring tool**.

The system consists of three distinct products:

1. **AMOLED engine**

   * Existing physical PenTile AMOLED renderer.
   * Remains a reusable standalone engine.
   * Must not become coupled to the generator.

2. **`.amo` format + runtime**

   * Declarative scene format.
   * Describes spatial RGB emitter intensity fields over time.
   * Can represent static images, gradients, patterns, animations, mathematical fields, etc.
   * Player evaluates the description and feeds the AMOLED engine.

3. **`.amo` generator**

   * Visual authoring environment.
   * This is the part being overhauled.
   * Primary interaction model should feel closer to **Desmos + visual editor**, not a collection of renderer configuration sliders.

The eventual portfolio is a **consumer** of the player. Do not redesign the portfolio or merge portfolio-specific functionality into this project.

---

# 1. First: inspect the existing implementation

Before changing anything:

* inspect the complete current repository;
* identify the existing generator UI;
* identify the current `.amo` parser/serializer;
* identify the current runtime;
* identify existing scene primitives;
* identify how expressions are currently parsed/evaluated;
* identify existing preview/rendering paths;
* identify existing tests;
* identify existing sample `.amo` files.

Do **not** throw away working infrastructure merely because the UI is bad.

Create a short internal implementation map:

```text
existing functionality
    ↓
keep
    ↓
adapt
    ↓
replace
```

Then proceed without asking the user for confirmation.

The user explicitly wants autonomous implementation.

---

# 2. Core conceptual model

The fundamental `.amo` abstraction is:

[
E_c(x,y,t)
]

where:

* `c ∈ {r,g,b}`
* `x` = normalized horizontal position
* `y` = normalized vertical position
* `t` = normalized/runtime time
* `E` = emitter drive/intensity
* output = `0..100`

Therefore every scene ultimately describes:

```text
R(x, y, t) → 0..100
G(x, y, t) → 0..100
B(x, y, t) → 0..100
```

The AMOLED renderer then handles:

```text
emitter drive
→ gamma
→ emitter response
→ PenTile geometry
→ optical spill
→ bloom
→ color management
→ display
```

The `.amo` scene must **not** duplicate physical rendering logic.

---

# 3. Separate scene mathematics from physical display parameters

An `.amo` should have two conceptual layers.

## Scene

Defines what the emitters should do.

Example:

```text
R(x,y,t) = ...
G(x,y,t) = ...
B(x,y,t) = ...
```

## Display

Defines how the AMOLED engine renders it.

For example:

```text
display:
    pitch: auto
    gamma: 1.7
    spill: 0.25
    bloom: ...
```

This allows the same mathematical scene to be rendered using different physical appearances.

---

# 4. Coordinate system

Establish one canonical normalized coordinate system.

Use:

```text
x = 0..1
y = 0..1
t = seconds
```

with:

```text
(0,0) = top-left
(1,1) = bottom-right
```

Document this explicitly.

The runtime converts normalized coordinates into whatever logical emitter grid is currently being rendered.

This is crucial because the `.amo` file must not depend on whether the player is rendering:

```text
200 × 120
300 × 180
800 × 450
```

The mathematical scene remains resolution-independent.

---

# 5. Expression engine

Build a proper safe mathematical expression system.

Do **not** use JavaScript `eval()`.

Expressions need:

### Constants

```text
pi
tau
e
```

### Variables

```text
x
y
t
```

Also expose useful aliases:

```text
time
width
height
```

if appropriate.

### Arithmetic

```text
+
-
*
/
%
^
```

### Functions

At minimum:

```text
sin
cos
tan
asin
acos
atan

sqrt
abs
floor
ceil
round

min
max
clamp

exp
log
pow

mod
```

### Useful graphics functions

Add:

```text
smoothstep(a,b,x)
mix(a,b,t)
step(edge,x)
```

And useful spatial helpers:

```text
distance(x1,y1,x2,y2)
length(x,y)
dot(...)
```

Potentially:

```text
noise(...)
```

later.

---

# 6. Expression editor should feel like Desmos

This is the single most important generator UX requirement.

The user should be able to create something like:

```text
y = 0.5 + 0.25 sin(2πx + t)
```

without having to understand the internal AST or `.amo` syntax.

The editor should provide:

* equation rows;
* syntax highlighting;
* autocomplete;
* function suggestions;
* error highlighting;
* live evaluation;
* graph/field preview;
* variable sliders where useful;
* draggable visual controls where feasible.

Example:

```text
┌─────────────────────────────────────────┐
│ Expressions                             │
│                                         │
│ R(x,y,t) = 50 + 50 sin(2πt)            │
│ G(x,y,t) = 50 + 50 sin(2πt - 2π/3)     │
│ B(x,y,t) = 50 + 50 sin(2πt - 4π/3)     │
│                                         │
│ [+ expression]                          │
└─────────────────────────────────────────┘
```

Changing any expression updates the preview immediately.

---

# 7. Do not restrict expressions to RGB intensity fields

Support several expression targets.

## Field intensity

```text
R(x,y,t)
```

## Position

For moving emitters:

```text
x(t)
y(t)
```

## Intensity

```text
z(t)
```

## Color

Allow:

```text
color.r(...)
color.g(...)
color.b(...)
```

or equivalent.

## Parameters

Allow reusable parameters:

```text
amplitude = 0.25
frequency = 2
phase = 2*pi/3
```

Then:

```text
R = 50 + 50*sin(frequency*t)
```

This makes complicated scenes manageable.

---

# 8. Support reusable parameters

The generator should have a parameter panel.

Example:

```text
Parameters

Amplitude     0.25   ─────●────
Frequency     2.00   ─────●────
Phase         120°   ─────●────
Speed         1.00   ─────●────
```

Parameters may be:

* constants;
* sliders;
* animated values;
* expressions.

This is extremely useful for experimentation.

---

# 9. Built-in visual primitives

Mathematics is the core, but nobody should need to write:

```text
smoothstep(...)
```

to make a radial gradient.

Provide helpers.

At minimum:

### Solid

```text
solid(color)
```

### Linear gradient

```text
linearGradient(...)
```

### Radial gradient

```text
radialGradient(...)
```

### Conic gradient

```text
conicGradient(...)
```

### Rectangle

### Circle

### Line

### Ring

### Noise

### Checkerboard

### Stripes

### Grid

### Dots

### Waves

### Plasma

### Particles

These are convenience generators that compile down to the same field representation.

---

# 10. Everything should ultimately reduce to fields

For example:

```text
radialGradient
```

might internally become:

```text
d = distance(x,y,cx,cy)

mix(colorA, colorB, smoothstep(...))
```

The user doesn't need to see that.

This gives the system:

```text
visual helper
        ↓
mathematical representation
        ↓
field evaluator
        ↓
RGB field
        ↓
AMOLED renderer
```

rather than maintaining completely separate rendering systems.

---

# 11. Layers / composition

Support multiple fields.

For example:

```text
Scene

Background
    radial gradient

Wave
    mathematical field

Glow
    radial emitter

Particles
    procedural field
```

Each layer should have:

```text
enabled
opacity
blend mode
mask
transform
```

Start with:

```text
normal
add
multiply
screen
```

and expand later if needed.

---

# 12. Time model

Use one authoritative scene clock.

Every animation gets:

```text
t
```

in seconds.

Support:

```text
duration
loop
loopMode
```

with:

```text
loop
pingpong
once
clamp
```

The runtime must be deterministic.

A scene rendered at:

```text
t = 1.5
```

must produce the same result regardless of FPS.

Do **not** base mathematical animation on "number of frames elapsed."

---

# 13. Mathematical animation

The system must support arbitrary time-dependent expressions.

Example:

```text
R = 50 + 50*sin(2*pi*t)
```

Spatial:

```text
R = 50 + 50*sin(10*x + 2*pi*t)
```

Spatial + temporal:

```text
R = 50
    + 50*sin(
        10*x
        + 5*y
        + 2*pi*t
      )
```

This is the core capability.

---

# 14. Moving emitter primitives

Also support an explicit moving-emitter abstraction.

For example:

```text
Emitter

x(t) = 0.5 + 0.3*cos(t)
y(t) = 0.5 + 0.3*sin(t)
intensity(t) = 100
color = red
```

This is useful for:

* particles;
* dots;
* indicators;
* oscilloscopes;
* signal diagrams;
* orbiting objects;
* visual effects.

It should be rendered into the same field system.

---

# 15. Your three-phase AC scene should be a canonical example

Implement a sample scene demonstrating:

```text
R:
50 + 50*sin(ω*t)

G:
50 + 50*sin(ω*t - 2*pi/3)

B:
50 + 50*sin(ω*t - 4*pi/3)
```

Then create a second example where those signals become actual oscilloscope traces:

```text
x = wrappedTime(t)
y = 0.5 + amplitude * sin(...)
z = 100
```

This should become a regression/example scene.

---

# 16. Images/GIF/video

Keep support for conventional media.

A source can be:

```text
image
gif
video
```

These are simply alternate field providers.

For an image:

```text
image(x,y)
```

For animation:

```text
image(x,y,t)
```

The runtime samples the asset and converts it into the RGB field.

Do not make media a separate conceptual system from mathematical scenes.

---

# 17. `.amo` format design

The format should be:

* declarative;
* human-readable;
* deterministic;
* versioned;
* extensible;
* reasonably compact;
* safe to execute;
* independent of the renderer implementation.

Use a structured format rather than inventing an unnecessarily clever parser unless the current implementation already has a strong reason for its custom syntax.

If the current `.amo` format is already established, preserve compatibility where practical.

Define:

```text
version
metadata
canvas
parameters
timeline
layers
display
assets
```

Conceptually:

```text
{
  version: "...",

  canvas: {
    coordinateSpace: "normalized"
  },

  timeline: {
    duration: ...,
    loop: true
  },

  parameters: {...},

  layers: [...],

  display: {...},

  assets: [...]
}
```

Exact syntax is up to the existing implementation, but **do not couple the schema to JavaScript implementation details.**

---

# 18. Expressions in `.amo`

Expressions must be serialized as expressions, not evaluated values.

Bad:

```text
R: 73.218
```

for a mathematical animation.

Good:

```text
R: "50 + 50*sin(2*pi*t)"
```

Likewise:

```text
x: "0.5 + 0.3*cos(t)"
y: "0.5 + 0.3*sin(t)"
```

The player evaluates them.

---

# 19. Expression AST

Internally parse expressions into an AST.

Example:

```text
50 + 50*sin(2*pi*t)
```

becomes roughly:

```text
ADD
├── 50
└── MUL
    ├── 50
    └── SIN
        └── MUL
            ├── MUL
            │   ├── 2
            │   └── pi
            └── t
```

Do not store this implementation-specific AST directly as the public `.amo` format unless there is a compelling reason.

The serialized expression remains human-readable.

---

# 20. Performance architecture

The player must **not** evaluate arbitrary expressions separately in expensive ways for every DOM/UI operation.

Build a pipeline:

```text
.amo
 ↓
parse
 ↓
validate
 ↓
compile expressions
 ↓
runtime
 ↓
evaluate field
 ↓
logical RGB framebuffer
 ↓
AMOLED renderer
```

For static scenes:

**evaluate once.**

For animations:

**evaluate only when a new frame is required.**

Do not continuously render static scenes.

Preserve the existing demand-driven behavior.

---

# 21. Quality / resolution independence

The `.amo` scene must not care about physical pixel count.

The player decides:

```text
logicalWidth
logicalHeight
```

based on:

* viewport;
* desired pitch;
* device capability;
* performance policy.

The expression receives normalized coordinates.

Thus:

```text
R(x,y,t)
```

works at any resolution.

---

# 22. Generator preview modes

Provide at least:

### Normal field preview

Shows the mathematical result without the simulated physical display.

### AMOLED preview

Runs the result through the actual AMOLED simulator.

### Pixel inspection

Allow the user to hover over the preview and show:

```text
x: 0.437
y: 0.612

R: 84.2
G: 17.4
B: 3.1
```

This is particularly important for debugging mathematical scenes.

---

# 23. Time controls

The generator needs a proper timeline.

At minimum:

```text
▶ Play
⏸ Pause
↻ Restart

Time: 2.347s

[──────────────●────────]
0s                         10s
```

Allow:

* scrubbing;
* frame stepping;
* playback speed;
* loop toggle;
* duration.

The mathematical scene must update while scrubbing.

---

# 24. Expression graphing

For mathematical scenes, provide a graph/field visualization mode.

For example:

```text
R(x,y,t)
```

could be shown as:

* heatmap;
* contour;
* graph;
* emitter dots.

And for:

```text
y = f(x,t)
```

show the curve.

The user should be able to inspect what their equation actually does before wondering why their screen looks like a dying router.

---

# 25. Color editor

Provide intuitive RGB controls.

Users can define:

```text
red intensity
green intensity
blue intensity
```

or use colors:

```text
#32FFAA
```

Internally convert everything to the normalized RGB field representation.

Support animated colors:

```text
color(t)
```

and mathematically generated colors.

---

# 26. Physical AMOLED controls

Keep them, but **move them out of the primary authoring workflow.**

Primary:

```text
AMOLED preset:
[ Natural ▼ ]
```

Advanced:

```text
▸ Pixel geometry
▸ Gamma
▸ Emitter response
▸ Spill
▸ Bloom
▸ RGB balance
▸ Supersampling
```

All renderer-specific values remain available.

Do not remove them.

---

# 27. Generator layout

Prefer a three-region layout:

```text
┌─────────────────────────────────────────────────────┐
│ File   Edit   Scene   View                 ▶  Save │
├──────────────┬──────────────────────────┬───────────┤
│              │                          │           │
│ SCENE        │                          │ INSPECTOR │
│              │        PREVIEW           │           │
│ Expressions  │                          │ selected  │
│ Layers       │                          │ object    │
│ Parameters   │                          │           │
│ Assets       │                          │           │
│              │                          │           │
├──────────────┴──────────────────────────┴───────────┤
│ Timeline / graph / expression editor                │
└─────────────────────────────────────────────────────┘
```

Adapt this to the existing generator framework rather than blindly replacing the UI technology.

---

# 28. Essential workflows

The finished generator must make these workflows easy.

### Workflow A — gradient

```text
New Scene
→ Gradient
→ choose colors
→ choose direction
→ preview
→ export
```

### Workflow B — animated gradient

```text
Gradient
→ animate position/color
→ timeline
→ preview
→ export
```

### Workflow C — mathematical wave

```text
New Mathematical Field
→ enter expression
→ see result immediately
→ animate t
→ export
```

### Workflow D — three-phase AC

```text
3 expressions
→ R/G/B phase offsets
→ preview
→ inspect emitter values
→ export
```

### Workflow E — image

```text
Image
→ upload
→ preview
→ AMOLED preview
→ export
```

### Workflow F — complicated mathematical artwork

```text
Multiple expressions
+
parameters
+
layers
+
animation
+
functions
```

No special-case architecture should be required.

---

# 29. Built-in examples

Ship several `.amo` examples:

```text
examples/
    solid.amo
    gradient.amo
    animated-gradient.amo
    waves.amo
    plasma.amo
    particles.amo
    three-phase.amo
    oscilloscope.amo
    image.amo
```

These are both demos and regression fixtures.

---

# 30. Testing

Add tests for:

### Expression parser

```text
2 + 2
sin(pi)
50 + 50*sin(t)
```

### Expression errors

Invalid syntax must produce useful errors.

### Determinism

Same:

```text
x,y,t
```

must always produce the same value.

### Bounds

Emitter outputs must ultimately clamp to:

```text
0..100
```

### Coordinate invariance

A scene evaluated at different logical resolutions must represent the same normalized mathematical field.

### Animation

At identical `t`, identical scene output.

### `.amo` round-trip

```text
Scene
→ serialize
→ parse
→ serialize
```

must preserve semantics.

### Golden scenes

Render known `.amo` examples and verify basic output.

Preserve the existing lattice-parity test.

---

# 31. Safety

Expressions are untrusted scene data.

Never execute arbitrary JavaScript.

No:

```text
eval()
Function(...)
```

No access to:

```text
window
document
fetch
WebGL
DOM
```

from expressions.

The expression environment should expose only the approved mathematical functions and variables.

---

# 32. Backward compatibility

If the current generator already produces `.amo` files:

* detect their version;
* maintain a migration path where reasonable;
* don't silently reinterpret existing scenes;
* provide useful validation errors.

If the current format is fundamentally incompatible with this model, introduce:

```text
format version 2
```

rather than pretending the old semantics are unchanged.

---

# 33. Do not prematurely GPU-compile the math

For this overhaul, prioritize:

**correctness + authoring experience + clean format.**

CPU rasterization is acceptable initially.

Design the field evaluator so that later it can have:

```text
CPU evaluator
GPU evaluator
```

with the same semantic model.

Eventually a mathematical field could compile into GLSL or another GPU representation, but **do not make that prerequisite for completing this overhaul.**

---

# 34. Important abstraction boundary

The agent should preserve this:

```text
              .amo
                │
          Scene Runtime
                │
       RGB field/framebuffer
                │
                ▼
       ┌─────────────────┐
       │ AMOLED ENGINE   │
       │                 │
       │ PenTile         │
       │ gamma           │
       │ spill           │
       │ bloom           │
       │ color           │
       └─────────────────┘
                │
                ▼
              Canvas
```

The generator must not start directly manipulating:

```text
WebGL uniforms
FBOs
PenTile geometry
shader internals
```

It should communicate through the scene/runtime API.

---

# 35. Definition of done

Do not consider this finished because the new UI renders.

The overhaul is complete when:

* [ ] Existing generator has been audited.
* [ ] Existing useful functionality is preserved.
* [ ] `.amo` schema supports spatial RGB fields.
* [ ] Expressions support `x`, `y`, `t`.
* [ ] Mathematical expressions are safely parsed.
* [ ] Expressions are live.
* [ ] Mathematical scenes animate in real time.
* [ ] Gradients and common primitives are built in.
* [ ] Parameters are supported.
* [ ] Multiple layers/fields are supported.
* [ ] Images/GIF/video remain possible.
* [ ] RGB channels can be independently controlled.
* [ ] Moving emitters are possible.
* [ ] Time scrubbing works.
* [ ] Preview works.
* [ ] AMOLED preview uses the real engine.
* [ ] `.amo` export works.
* [ ] `.amo` reload works.
* [ ] Static scenes render only when necessary.
* [ ] Resolution is independent of scene mathematics.
* [ ] Physical AMOLED parameters remain configurable.
* [ ] Existing renderer remains independently usable.
* [ ] Tests cover parser/evaluator/runtime basics.
* [ ] Example `.amo` scenes exist.
* [ ] Documentation explains the format.
* [ ] No unsafe expression execution exists.

---

# 36. Autonomous execution rules for the agent

**Do not stop to ask the user questions unless the repository is genuinely impossible to modify safely without an answer.**

Use reasonable engineering judgment.

When multiple implementation choices exist:

1. Prefer the simplest architecture compatible with the requirements.
2. Preserve working existing behavior.
3. Avoid unnecessary dependencies.
4. Avoid rewriting the AMOLED renderer unless required.
5. Keep the `.amo` format renderer-independent.
6. Favor backwards compatibility.
7. Write tests alongside the implementation.
8. Build progressively rather than replacing everything blindly.

If the current implementation already has an equivalent subsystem, **adapt it instead of creating a duplicate.**

If a feature is too large to perfect in one pass, implement a clean minimal version and leave the architecture extensible rather than blocking the rest of the overhaul.

---

# 37. Git requirements

Work in logical commits.

At minimum:

```text
feat: redesign amo scene model
feat: add safe mathematical expression engine
feat: overhaul generator editor
feat: add mathematical field authoring
feat: add visual primitives and helpers
feat: add timeline and animation controls
feat: integrate amo runtime with amoled preview
test: add amo format and expression coverage
docs: document amo scene format
```

Do **not** make one gigantic commit containing the entire overnight change.

After each coherent milestone:

```bash
git status
git diff
git add ...
git commit -m "..."
```

Before finishing:

```bash
git status
git log --oneline -n <recent commits>
```

Ensure the working tree is clean unless there is a deliberate, documented reason otherwise.

**Commit the work. Push the commits to the configured remote.**

Do not merely report that changes *could* be committed.

---

# 38. Final priority order

If time becomes limited overnight, prioritize in exactly this order:

### P0 — Mathematical scene foundation

```text
R(x,y,t)
G(x,y,t)
B(x,y,t)
```

safe expression evaluator + runtime.

### P1 — Generator usability

Real-time equation editor, preview, parameters, timeline.

### P2 — `.amo` format

Stable serialization/deserialization/versioning.

### P3 — Helpers

Gradients, waves, circles, particles, etc.

### P4 — AMOLED integration

Real engine preview + display configuration.

### P5 — Advanced UX

Graphing, inspectors, visual manipulators, polish.

### P6 — Optimization

GPU expression evaluation, caching, advanced performance work.

Do **not** sacrifice P0–P3 to make the interface pretty.

---

## The one-sentence north star

> **Build a Desmos-like real-time mathematical editor whose output is a portable `.amo` scene describing RGB emitter fields (R(x,y,t), G(x,y,t), B(x,y,t)), with convenient visual primitives layered on top, and whose preview can pass those fields through the existing physical AMOLED engine.**

That is the thing.
