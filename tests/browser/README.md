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
node tests/browser/smoke.js        # boot + render + bloom energy check
node tests/browser/regression.js   # bloom floor, pitch UI sync, spill default,
                                   # auto-pitch preservation, context-loss recovery
```

Both serve the repo root over a local HTTP server on a random port and print
PASS/FAIL with details. Exit code is non-zero on failure.
