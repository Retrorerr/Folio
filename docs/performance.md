# Folio performance measurements

This document records the reproducible measurements and the limits of the
current workbench. It deliberately separates measurements from expectations:
this checkout has no Android SDK, Gradle, adb target, browser executable, or
model-pack binaries, so Android and browser-layout timings are not invented.

## Architecture map

- Android TTS: `FolioMobilePlugin` accepts synthesis requests, while
  `OnDeviceModelManager` owns one locked session set per engine. `KokoroRuntime`
  and `SupertonicRuntime` execute under that lock. `FolioPlaybackService` owns
  Media3 playback and background/notification state.
- Model lifecycle: model packs are extracted to a sibling staging directory,
  fully verified, contract-checked, and atomically published. Sessions are
  opened lazily and retained until unload or replacement.
- TTS queue/prebuffer: `useAudioPlayback` owns the sentence/audio cache and
  lead/read-ahead requests (`LEAD_PREFETCH_SENTENCES = 4`,
  `READ_AHEAD_SENTENCES = 12`). Android uses the same generated audio through
  the native Media3 queue; request keys and queue-session maps deduplicate work.
- Reader pagination: `ReflowViewer` keeps the visible multicolumn chapter and
  one current-chapter measurement clone for accurate pagination, sentence/page
  lookup, and resume. One adjacent chapter is mounted during idle pagination,
  measured, cached, and unmounted.
- Follow Along geometry: `buildVisualLineMap` tokenizes visible sentences,
  measures token ranges and canonical paragraph lines, groups fragments into
  visual lines, and maps playback anchors to views. `usePlaybackLineCursor`
  coalesces rebuilds and performs cursor presentation from the map.

## Commands

From `frontend/`:

```text
NPM_CONFIG_CACHE=/tmp/folio-npm-cache npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
npm run lint
npm run build
```

The synthetic offset-resolution benchmark is intentionally narrower than a
browser benchmark. It compares the old per-token linear text-node walk with
the indexed resolver used by Follow Along:

```text
FOLIO_BENCHMARK_NODES=128 FOLIO_BENCHMARK_TOKENS=1000000 \
  FOLIO_BENCHMARK_SAMPLES=15 node scripts/performance/visual-line-offset-benchmark.mjs
```

At runtime, Follow Along's bounded debug trace records map build duration,
sentence/token counts, indexed text-node counts, Range calls, and
`getClientRects()` calls. Enable the existing debug switch with
`FOLIO_DEBUG_FOLLOW_ALONG=1` (or the corresponding local-storage flag) when a
browser/device is available. The trace is not logged in normal production
operation.

The Android performance surface is exposed in model status as the selected
provider/thread configuration and the most recent validation/session-open
timings. The new `warm_model` bridge command returns a one-shot warm-up result;
it does not run a dummy inference.

## Baseline and measured result on this workbench

| Metric | Before | After | Measurement method |
| --- | ---: | ---: | --- |
| Frontend tests | 76 pass | 81 pass | `npm test` |
| Frontend typecheck | 3.627 s | 3.380 s | Sequential command wall time |
| Frontend lint | 7.094 s | 6.566 s | Sequential command wall time |
| Frontend production build | 1.032 s | 0.604 s | Vite-reported build time; noisy workstation metric |
| Main frontend JS | 495,645 B | 498,761 B | Vite output byte count |
| Offset resolver, median | 133.6254 ms | 91.7679 ms | 128 synthetic text nodes, 1,000,000 tokens, 15 samples |
| Offset resolver speedup | — | 1.46× | Same synthetic benchmark; not full layout time |
| Android session load | N/A | N/A | No Android SDK/device/model pack |
| Android first synthesis | N/A | N/A | No Android SDK/device/model pack |
| Android warm synthesis / RTF | N/A | N/A | No Android SDK/device/model pack |
| Reader open/layout/DOM nodes | N/A | N/A | No browser executable/layout engine |
| APK/AAB size, R8, frame timing | N/A | N/A | Final Tauri Android project is generated at build time |

The offset result measures only offset resolution. It is not a claim about
full chapter layout time or frame rate; those require a real browser layout
engine and representative EPUB content.

## What was verified and what was not selected

- The existing audio prefetch/cache/native queue was retained. It already
  deduplicates sentence keys, cancels stale read-ahead, warms a four-sentence
  lead, and appends only missing native queue sessions.
- ONNX Runtime Android is pinned to `1.26.0`. Its Java API contains NNAPI and
  XNNPACK registration methods, but no provider was selected without a Folio
  model benchmark on a real Android target. CPU remains the reliable fallback.
  The API was checked against the
  [v1.26.0 Java source](https://github.com/microsoft/onnxruntime/blob/v1.26.0/java/src/main/java/ai/onnxruntime/OrtSession.java).
- A tiny inference warm-up was not retained: there is no Android measurement
  here showing that it improves first real synthesis enough to justify extra
  startup CPU/battery work. Session-only warm-up is asynchronous and retryable.
- The Android Kokoro pack is still the trusted 325,532,387-byte FP32 model.
  No reproducible, pinned Android INT8 asset and no device quality/throughput
  corpus were available, so INT8 was investigated and rejected as a default.
- Desktop queue concurrency was not changed. The application uses one queue
  worker and both desktop engines already serialize generation with a bounded
  semaphore; increasing workers would add contention without evidence of
  throughput benefit.
- The permanent current-chapter measurement clone remains because visible
  multicolumn geometry does not provide equivalent pagination and word lookup
  semantics. The adjacent-chapter clone already follows mount → measure →
  cache → unmount.
- The full current-chapter Follow Along map remains eager: visible text must be
  immediately hit-testable and playback must not wait at a page boundary. The
  map is now cheaper to build and rebuilds are coalesced; partial/idle mapping
  was not selected without browser/device measurements proving it safe.
- The existing chunk-progress publication cadence (0.008 delta or 50 ms) was
  retained. There is no browser profiler in this workbench showing that React
  renders, rather than geometry or WebView layout, are the dominant cost, so
  cursor smoothness was not traded away speculatively.
- PDF.js is already split into a lazy `pdfRuntime` chunk and its worker; no
  PDF rewrite was justified by the available evidence.
- R8/resource shrinking and Macrobenchmark/Baseline Profile were not toggled
  blindly. The final Tauri Android application module is generated outside the
  checked-in plugin, and there is no Android build toolchain in this workbench
  to verify JNI/reflection rules or package a profile safely.
