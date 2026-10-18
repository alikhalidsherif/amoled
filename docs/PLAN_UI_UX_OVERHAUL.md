# PLAN — UI/UX Overhaul: Landing + Simulator + AMO Studio

Status: **complete** (written 2026-10-17; all sections implemented and verified).

Build log: routing move ✅ · tokens + studio chrome ✅ · color popover + trace/channel rework ✅
(§5.2–5.4, incl. unit tests) · landing + sim restyle ✅ (§3–4) · Firefox hardening ✅ (§6) ·
tests + screenshot review ✅ (§7: full node + browser suites green incl. `landing.mjs`,
`trace-color.mjs`; desktop + mobile screenshots reviewed).

---

## 0. Goals

1. Minimal, clean, premium UI across the whole site: **monochrome base + hue-drifting accent**. No green tint anywhere. Darker, deeper tones suited to a black UI — nothing bright or garish.
2. Every trace gets a proper color picker (arbitrary colors + custom hex). Red/green/blue are the *initial colors* of the three-phase demo, not mandatory trace types.
3. Trace color and RGB channel association are separate concepts. Ordinary traces render their selected color through the existing AMOLED pipeline. Channel binding stays available as an explicit opt-in for PenTile/subpixel experiments and must never silently override the selected color.
4. Primary interface stays simple: clear labels, tooltips, sensible defaults, restrained styling, instant previews. Rarely used controls stay accessible without cluttering trace cards.
5. Root page (`/`) becomes a landing page with its own live AMOLED animation. The simulator moves to `/sim`, the studio to `/gen`.
6. Preserve: trace architecture, `.amo` compatibility, existing examples, Advanced tools, resizable layout. No Formula Art, no new waveform types, no renderer redesign, no math-feature expansion.
7. Firefox: best-effort hardening only (desktop Firefox already works and is fast; mobile-Firefox users can use Chrome).

## 1. Routing

| Path | Content | Notes |
|---|---|---|
| `/` | **New landing page** (`index.html` rewritten) | Hero + butterflies attract background |
| `/sim/` | Simulator (current root page, moved to `sim/index.html`) | Keeps `?scene=` param, media upload, test pattern |
| `/gen/` | AMO Studio (`generator/` renamed to `gen/`) | Same relative depth → `../src`, `../scenes` still valid |
| `/generator/` | Tiny redirect stub → `/gen/` | Don't break old bookmarks |

- All internal asset/scene references become **root-absolute** (`/assets/…`, `/scenes/…`) so pages work at any depth: `app.js:111` (`assets/test-*.gif`), `studio.js:2362/2370` (`../scenes/…`), `studio.js:420/422` (`../assets/…` defaults), and `?scene=` resolution in `app.js:539` (prefix `/` when the value has no leading slash).
- `nginx.conf` already has `try_files $uri $uri/ /index.html` → directory indexes serve `/sim/` and `/gen/` fine. Keep the stub at `generator/index.html`.
- Browser tests currently load the simulator at `/` (`smoke.js`, `regression.js`, `phase3–10`, `resize`, `screenshot`) → update to `/sim/` (+ root-absolute scene URLs). Studio tests (`studio.mjs`, `studio-overhaul.mjs`) → `/gen/index.html`.
- Add cross-links: studio topbar wordmark → `/`; sim drawer header link → `/` and `/gen/` (small, restrained).

## 2. Design system (shared tokens)

### 2.1 Color

```css
--bg:#08080a  --panel:#101013  --panel-2:#16161a
--line:#24242a --line-soft:#1b1b20
--txt:#d6d6db --dim:#8e8e96 --faint:#5c5c64     /* pulled down from near-white */

@property --h { syntax:"<number>"; inherits:true; initial-value:250; }
--hue-cycle: 120s;  /* single knob — see §10 for the 180s → 120s change */
```

Implementation note (decided during build): the drift is **stepped by `src/hue-drift.js`**
via `requestAnimationFrame` — one `--h` update per second (3°/s, visually identical to
a smooth 120s pass), not a CSS animation. A continuously animating custom property
forces a full style recalc every frame across every accent-dependent element, which
visibly starved low-power/headless rendering (a "still typing" debounce drifted from
300ms to >1s and test flows flaked). Stepping costs one style recalc per second;
`setInterval` is avoided because heavy main-thread work can throttle timers into
visible jumps — rAF keeps the step grid exact. Hidden tabs stop the loop and resync
from wall clock on return. Same single-knob promise: `--hue-cycle` in theme.css.

```css
--accent:     oklch(65% 0.14 var(--h));  /* mid-dark, saturated-but-deep — not icy, not neon */
--accent-ink: #0a0a0c;                   /* constant near-black on accent fills */
--accent-soft / --accent-line: color-mix(in oklab, var(--accent) 14%/40%, transparent|panel);
--err / --warn: fixed hues (semantics don't drift); --ok = accent
```

- **Readability guarantee:** OKLCH lightness is perceptually uniform, so accent ↔ `#0a0a0c` stays ≥4.5:1 for every hue (covers both “accent text on dark” and “dark text on accent fill”). Enforced by automated test (§7).
- `prefers-reduced-motion: reduce` → no animation, static hue 250 (steel blue).
- No `@property`/`oklch`/`color-mix` support (old Safari) → static hue-250 accent, otherwise intact.
- Hard-coded greens in current code to eliminate: studio tokens `generator/index.html:8–15`, buttons `:42`, hovers `:154`, layer chip `:184`, adv-strip `:302`, divider `:360`, scope grid `:310–316`, selection `:135`, scrollbar `:377`, `.tok-fn` `:137`; root page `styles/demo.css` primary `#8c8`, pulse `rgba(100,200,100,…)`, dragover `#8a8`.

### 2.2 Typography

- **UI sans:** `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` — labels, buttons, hints.
- **Mono:** `ui-monospace, SFMono-Regular, Menlo, Consolas` — numbers, hex, expressions, source, timecodes (+ `font-variant-numeric: tabular-nums`).
- **Hero display serif:** self-hosted OFL serif woff2 in `assets/fonts/` (Instrument Serif or Fraunces; Georgia fallback). No CDN — offline/docker safe.
- Scale: 10px uppercase eyebrows (.1em tracking) / 11px captions / 12px secondary / 13px base / 14px emphasis; hero `clamp(44px, 8vw, 104px)`.
- Geometry: 4px spacing base; radii 6px controls / 8px cards; 1px hairlines; focus = 2px accent ring.

## 3. Landing page `/` (new)

Structure (single `index.html`, own small CSS + `landing.js` module):

- Full-bleed canvas: AMOLED engine running a **multicolored butterflies** attract animation.
- Hero over it (scrim gradient + vignette for legibility): wordmark · serif headline · sans sub-line · two buttons — **[Open Simulator → `/sim/`]** (primary accent) and **[AMO Studio → `/gen/`]** (secondary outline) · footer bar: GitHub (`github.com/alikhalidsherif/amoled`) + `px@ali.et` (mailto) + MIT note.

**Attract animation** — new `src/attract.js` attached to `window.AMOLED` (sibling of `patterns.js`, demo content only, not part of the .amo math system):

- Butterflies: parametric wing shape (mirrored polar lobes), per-butterfly hue from a multicolor palette, wing flap via horizontal scale `sin(fl·t+φ)`, slow lissajous-ish drift paths, additive soft glow over black. Count ~6–14 scaled inversely to grid size.
- Fed frame-by-frame into the simulator framebuffer (same `createTestPattern`-style pattern loop).

**Adaptive quality (landing only):**

- **Pitch by device capacity:** tier score from `deviceMemory`, `hardwareConcurrency`, screen pixels, DPR (reuse `detectLowTier()` pattern from `app.js:19–25`). Map: low → pitch ≈ 10px, mid → ≈ 6px, high → ≈ 4px, then clamp to viewport so grid stays ≥ ~120 columns wide.
- **Supersampling fixed at 1×** for the landing (no visible quality loss; big perf win).
- Butterfly count and logical resolution scale with tier. Cap DPR (low: 1, high: ≤2).
- `prefers-reduced-motion`: render one static frame, stop the loop. `visibilitychange`: pause when hidden.

## 4. Simulator `/sim/`

- Move current root markup + `styles/demo.css` + `src/app.js` wiring; restyle per §2 (drawer, toggle — green pulse becomes a gentle accent breath — sliders with thin track + accent thumb, buttons, upload/dragover, status, repo link, mobile ≤500px).
- Default behavior unchanged: test pattern on boot, `?scene=` loads scenes (paths root-absolute), media upload, all existing controls.
- Keep engine defaults (supersample select stays a user control).

## 5. AMO Studio `/gen/`

### 5.1 Chrome
Restyle per §2: topbar, tabs (accent underline), transport, statusbar, adv-strip as segmented control, layer chips, math cards, autocomplete, inspector, env banner, scrollbars. Scope overlay grid → neutral white-alpha. Inputs compact (32px), thin range track + accent thumb.

### 5.2 Color popover component (new, vanilla, reusable)
Swatch button → popover: **SV square + hue strip + hex text field** (`#rgb`/`#rrggbb`, validated, lowercased) + native-picker fallback + curated preset row. Live `input` → existing `commitEdits()` debounce → instant preview. Outside-click/Esc close, keyboard accessible, viewport-flip. Used by: trace cards, background card, Advanced layer color fields (guard expression-disabled state exactly like today).

### 5.3 Trace cards (`traceCard`, `studio.js:1889–2008`)
- Header one-liner: swatch · name · waveform · visibility toggle · delete (tooltips on icons); disabled traces dim.
- Knobs: consistent `label | slider | value` rows; tooltips from `TRACE_KNOB_META` kept.
- **More…**: Phase, Thickness, custom expression (as today) + new **Emitter channel** select `None | R | G | B` with tooltip ("PenTile experiment: lights only that subpixel channel. None = full selected color") + auto-warning when the color lacks a component in the bound channel (would render invisible). Channel chip in header only when bound.

### 5.4 Color ≠ channel semantics
- `defaultTrace()` (`studio.js:1794`): boot keeps R/G/B **colors**, **no channel binding** (visually identical for pure primaries — proven by test). Added traces cycle a curated non-RGB palette (amber/cyan/violet/pink/mint/white…), unbound.
- `scenes/three-phase-scope.amo`: untouched (compat; bound + pure primary ≡ unbound).
- `src/scene/rasterizer.js`: **unchanged** (unbound already renders full color at :571–573).

## 6. Firefox (best-effort only)
- Desktop Firefox confirmed working (fast). No diagnosis phase required.
- Cheap hardening: defensive context creation in `amoled-gpu-renderer.js:287` and `amoled-renderer.js:40` — if `getContext(..., {desynchronized:true, …})` returns null, retry without `desynchronized` (Firefox doesn't support the hint). ~6 lines each, zero risk on Chrome.
- README Browser Support: note verified Firefox desktop; mobile Firefox may fail — recommend Chrome on phones.
- Optional (not required): `tests/browser/firefox-smoke.mjs` if Firefox is installable in the env.

## 7. Tests & acceptance

**New node tests**
- `tests/scope-raster.test.js` additions: arbitrary/mixed color (`#ff8844`) preserves R:G:B ratio in the rendered field; overlapping traces add; bound-vs-unbound equality for pure primaries (demo unchanged); binding keeps only the bound component.
- `tests/hue-contrast.test.js`: oklch→linear-sRGB→Y math; assert accent ↔ `#0a0a0c` ≥ 4.5:1 for all 360 hues.
- Scope color round-trip: arbitrary hex survives validation (`scope-scene.test.js` addition).
- Add the currently-orphaned `scope-*.test.js` files to the `npm test` chain.

**New browser tests**
- `tests/browser/trace-color.mjs` (single-load pattern like `studio-overhaul.mjs`): set color via popover hex + SV → `__gworking()` model color and rendered canvas pixels change; export JSON retains hex; import/source round-trip restores; new trace unbound with palette color; channel select in More binds + shows warning.
- `tests/browser/landing.mjs`: `/` boots, hero + two CTAs present, canvas animating (frame hash changes), `/sim` and `/gen` links work, reduced-motion freezes.
- Update existing browser tests to `/sim/` and `/gen/` (§1) — no selector regressions (keep `#param-list .param-row`, `.pdel`, `#source`, boot `rows === 3`, etc.).

**Regression:** full `npm test` + browser suite (`smoke`, `regression`, `phase3–10`, `studio`, `studio-overhaul`, `resize`).

**Visual review:** screenshots desktop + mobile of `/`, `/sim/`, `/gen/` (a few hues into the accent cycle) — review and iterate before done.

**Acceptance criteria** (from brief):
1. No fixed green anywhere; even 120s hue drift from a random starting hue; static darker blue fallback; text/accent contrast ≥4.5:1 at every hue (automated).
2. Arbitrary trace colors (incl. mixed RGB) render through the AMOLED pipeline; picker changes actual output; save/export + reopen preserves color; examples unchanged.
3. New traces unbound; channel binding opt-in in More with warning; ordinary traces never silently overridden.
4. Landing: butterflies attract, tier-based pitch, 1× supersample, hero with serif type, 2 CTAs, GitHub + px@ali.et; `/sim` and `/gen` work; `?scene=` works.
5. Studio: Advanced tools, resizable split, `.amo` export/import, gallery all intact.

## 8. Out of scope
Formula Art, new waveform types, math features, renderer architecture changes, `.amo` schema changes, Advanced-tool rewrites, subpixel-rendering compensation (see appendix), cross-page URL history beyond the redirects.

## 9. Execution order
1. Routing move (`generator/`→`gen/`, sim→`sim/`, path fixes, test URL updates) — verify suite green before styling.
2. Design tokens + studio chrome restyle.
3. Color popover + trace card rework + channel semantics + new color tests.
4. Root landing: restyle `demo.css`, landing markup/hero/serif, `src/attract.js` butterflies + tier pitch + landing boot wiring.
5. Firefox defensive context retry + README note.
6. New browser tests, full suite, screenshot review + polish pass.

---

## 10. Design pass 2 — branding, hero, butterflies, hue, SEO (2026-10-18)

Overnight follow-up on the §1–§9 build. User brief: move contact/GitHub to the
footer, new hero line, polish the butterflies, faster + randomized hue cycle,
pick a real title/brand, and give every page world-class SEO. Everything below
shipped together with tests.

### 10.1 Brand decision
- **Brand = `px.ali.et`** (not "pixelate", not "AMOLED"): it is the actual
  domain, the `og:url` base, and the contact identity (`px@ali.et`) — the only
  ownable name of the three. "AMOLED" is trademark-adjacent and generic for
  SEO; "pixelate" contradicts the subpixel-precise premise of the project.
- Wordmark everywhere: `px.ali.et` in mono with accent-colored dots (landing
  header, sim panel head, studio topbar). Product names stay descriptive:
  **Simulator** (`/sim/`), **AMO Studio** (`/gen/`).
- Page titles — unique, ≤65 chars, brand suffix (asserted by `tests/seo.test.js`):
  - `/` → `Diamond PenTile AMOLED Simulator — px.ali.et`
  - `/sim/` → `AMOLED Subpixel Visualizer — px.ali.et`
  - `/gen/` → `AMO Studio — Animated AMOLED Scenes — px.ali.et`
- `assets/icons/manifest.json` rebranded (name carries `px.ali.et`, short_name ≤12 chars).

### 10.2 Landing hero + footer
- H1 → **"Your Display, Magnified."**; sub rewritten as a concise project
  explanation (what the simulator shows, that the studio authors scenes).
- GitHub + `px@ali.et` moved out of the top-right nav into the bottom footer
  (`Pure client-side · zero backend · MIT` left; email + GitHub right; stacked
  on mobile). `.hero-nav` rules removed from `landing.css`.
- Scrim gained a left-side linear gradient (`rgba(0,0,0,.66)` → transparent at
  72%) so hero copy stays legible over bright butterflies.

### 10.3 Butterfly polish (`src/attract.js`)
- Per-butterfly lobe jitter (size/rotation/offset) — no two silhouettes match.
- Scalloped wing edges (5-lobe radius ripple) instead of bare ellipses.
- Swallowtail lobes (two extra hindwing tails) + antennae (soft segment SDF).
- Iridescent fill: near-body color (hue-shifted, lighter) blends to the deeper
  rim color; per-butterfly luminance variance.
- Asymmetric flap (right wing trails left by 0.35 rad) + body lift synced to
  the wing beat; drift path gains a slow secondary oscillator (meander).
- Deliberately **no frame trails**: at these drift speeds only the flap moves,
  and additive accumulation washed out hues in a trial capture.

### 10.4 Hue cycle
- `--hue-cycle: 180s` → **`120s`** (3°/s at the existing 1s step — the original
  180s read as "barely changing" at normal glance time).
- **Random starting hue per page load** (`Math.random()*360` base in
  `src/hue-drift.js`); hue normalized to `[0, 360)`. Reduced motion keeps the
  static 250 fallback and never drifts.
- `tests/browser/landing.mjs` asserts `cycle === 120000`, `base ∈ [0,360)`,
  derives expected drift from `__hueDrift.cycle`, and wraps the sampled delta
  across 0° (a random start makes a mid-sample wrap possible).

### 10.5 SEO (all pages)
- Per page: unique title + description (70–170 chars), keywords, author,
  robots (`index, follow, max-image-preview:large`), color-scheme, canonical ==
  `og:url`, full Open Graph (`og:site_name`, `og:locale`, image with
  width/height/alt), Twitter `summary_large_image`, favicons + manifest, and
  exactly one `<h1>` (`.sr-only` heading added to `/sim/` and `/gen/`).
- JSON-LD (`@graph`): landing = WebSite + Person + two WebApplications +
  WebPage; `/sim/` and `/gen/` = SoftwareApplication + BreadcrumbList.
- `robots.txt` (wildcard allow + sitemap pointer) and `sitemap.xml` (three URLs,
  lastmod) added; nginx serves both through `try_files`.
- OG card regenerated at **1200×630** from the live landing page via
  `tools/make-og-image.mjs` — runs with `prefers-reduced-motion` so the pose at
  t=4.2 and the static blue accent are deterministic across runs.
- Studio viewport dropped `user-scalable=no` (accessibility / mobile SEO).

### 10.6 Tests, verification, tooling
- New `tests/seo.test.js` (106 checks, appended to `npm test`): meta sets,
  canonical/og:url agreement, title uniqueness, JSON-LD parseability, OG PNG
  dimensions (IHDR), robots/sitemap contents, manifest branding.
- `tests/browser/landing.mjs` updated for the new headline, footer links, and
  randomized 120s drift.
- Full matrix green: `npm test` (19 suites) and every browser suite (`smoke`,
  `regression`, `phase3–10`, `resize`, `studio`, `studio-overhaul`, `shapes`,
  `layers`, `trace-color`, `landing`).
- New dev tools: `tools/shot.mjs` (viewport screenshots) and
  `tools/make-og-image.mjs`; screenshots live under `screenshots/` (gitignored).

## Appendix A — Why low optical spill looks greenish (design notes, not scope)

The Diamond PenTile lattice has **~2× as many green emitters as red or blue** (every other subpixel is green; R/B alternate at half density — `diamond-pentile-geometry.js`). The engine maps logical R→R emitters, G→G emitters, B→B emitters directly, with no subpixel-rendering compensation (real panels do this in the driver IC). Defaults also weight green highest (`config.js`: maxOutput R 0.70 / G 1.00 / B 0.55; green σ 0.35 is the *sharpest*).

- **Low spill:** each emitter lights only its own tiny diamond. The eye spatially averages a region → R + 2G + B → **greenish cast**. You're seeing the raw, uncompensated lattice — which is physically honest and the point of the simulator.
- **High spill:** each emitter's glow spreads over its neighbors, so R/G/B light optically re-mixes *before* the eye integrates → colors recombine toward the intended hue, plus a filmic glow people read as "looks right".

Both behaviors are correct simulations of the physics with/without optical spread. A future "subpixel compensation" display toggle (driver-style G down-weighting) could remove the cast at low spill — deliberately **not** in this iteration.
