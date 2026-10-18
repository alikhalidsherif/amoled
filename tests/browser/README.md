# Browser harnesses (manual-run)

Headless-Chrome smoke/regression scripts for the GPU simulator. Not wired
into CI yet — run them by hand after engine changes (PLAN.md defers full
browser automation until after Phase 8; these are the proven debugging
scripts from the supersample/context-loss work).

## Setup

```bash
npm i --no-save puppeteer-core          # driver only, no download
# Any Chrome-for-Testing / chrome-headless-shell binary works:
export CHROME_BIN=/path/to/chrome-headless-shell
```

SwiftShader (software WebGL) is sufficient — pass `--use-angle=swiftshader`
is already baked into the scripts' launch args via `--enable-unsafe-swiftshader`.

## Run

```bash
npm run test:browser               # full chain, stop on first failure
```

Individual harnesses:

```bash
node tests/browser/smoke.js        # boot + render + bloom energy check
node tests/browser/regression.js   # bloom floor, pitch UI sync, spill default,
                                   # auto-pitch preservation, context-loss recovery
node tests/browser/phase3.mjs …    # feature phases (import/export, scenes, …)
node tests/browser/studio.mjs      # AMO Studio boot/render/edit acceptance
node tests/browser/studio-overhaul.mjs
node tests/browser/shapes.mjs      # shape presets, Advanced declutter, ctl heights
node tests/browser/layers.mjs      # layers overhaul: top-first list, arrows, scope
                                   # layer → Traces routing, blend default,
                                   # AI copy/paste round-trip
node tests/browser/trace-color.mjs # color popover, color != channel semantics
node tests/browser/landing.mjs     # landing hero, butterflies, accent drift,
                                   # reduced-motion static frame
```

All serve the repo over a local HTTP server on a random port and print
PASS/FAIL with details. Exit code is non-zero on failure. Notes:
- `page.waitForFunction` runs in an isolated world here, where page globals
  (`window.__sim`, `window.__landing`, …) are invisible — poll with
  `page.evaluate` instead (see `trace-color.mjs`/`landing.mjs`).
- `evaluate` callbacks are serialized: Node-side closure variables don't
  exist inside them (return values out, or stash on `window` page-side).
- Under SwiftShader each evaluate round trip can take seconds; sample
  timing-sensitive state inside a single in-page evaluate.
- The full chained `npm run test:browser` can exceed a 10-minute tool
  timeout under SwiftShader — run harnesses in chunks when scripting it.
