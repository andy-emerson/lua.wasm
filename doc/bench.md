# Benchmark: lua.js against Wasmoon and fengari-web

What the numbers below are: `scripts/bench-witness.mjs` (`make bench`)
loads lua.js, [Wasmoon](https://github.com/ceifa/wasmoon) 1.16.0 and
[fengari-web](https://github.com/fengari-lua/fengari-web) 0.1.4 — the
two other ways to run Lua in a browser — in the same page under the
same real engine, runs the five workloads in `bench/` on a fresh
instance each time for 20 rotated rounds, and reports medians, each
peer's ratio to lua.wasm (above 1: lua.wasm is faster) and a two-sided
Mann–Whitney p. Every implementation printed the same result for every
workload, so the three are doing the same computation. Load to first
print is measured on three pages written as each project's README
shows (`bench/load-*.html`), from navigation to the first `print`,
cold (a fresh browser context) and warm (the same context again).
Workloads are written for Lua 5.3 and 5.4 (fengari is 5.3).

A number is only as good as its run: each table names its engine,
date and commit. These are the **baseline**, taken before any
optimization work (issue #54); the machine is one CI-class container,
so absolute times are not comparable across tables, ratios are.

## What they say

- **Error handling** (`pcall`): lua.wasm is 2.5× Wasmoon in Chromium
  and 3.3× in WebKit — Lua errors stay inside wasm here and round-trip
  through JavaScript there — but **0.78× in Firefox**, where
  SpiderMonkey's wasm exception throw costs about 27 µs and fengari,
  throwing JavaScript exceptions, is faster than both.
- **Game-shaped frames** (`frame`: update, sort, neighbours): lua.wasm
  ahead in every engine, 1.2–1.4×.
- **Pure interpretation** (`fib`): Wasmoon is ahead — 0.81× in WebKit
  (significant), 0.77× in Chromium (not significant at 20 rounds),
  1.08× ours in Firefox. The two run the same interpreter; the
  difference is in how it is compiled, and is the first thing the
  optimization work looks at.
- **Allocation** and **strings**: within a few percent either way in
  Chromium and WebKit; Wasmoon slightly ahead in WebKit.
- **fengari** is 4–14× behind both wasm engines on everything except
  Firefox's `pcall`.
- **Load to first print**: lua.wasm is behind Wasmoon cold in Chromium
  (75 vs 66 ms) and Firefox (137 vs 123), level warm in Firefox and
  WebKit, behind warm in Chromium (47 vs 41), and ahead cold in WebKit.
  fengari, being JavaScript, starts fastest everywhere. The one-file
  form (`lua.js` carries the module) cannot stream-compile and the
  loader builds the visitor's zone file before the first tag; both are
  targets.

## Workloads

| name | what it exercises |
|---|---|
| `fib` | function calls and arithmetic, no allocation: `fib(30)` |
| `pcall` | 200,000 protected calls that each raise and catch an error |
| `alloc` | 500,000 short-lived tables and strings, then a checksum |
| `string` | 50,000 `string.format`s, `table.concat`, a `gsub` over 500 KB, `gmatch` |
| `frame` | 60 frames of 2,000 entities: update, `table.sort` by a total key, neighbour count |

## Chromium 141

Run: chromium 141.0.7390.37, 2026-10-13, lua.wasm at 0af7271, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 351.3 | 382.1 | 1.09× | 0.004 | 1514.7 | 4.31× | < 0.001 |
| fib | 126.4 | 98.0 | 0.77× | 0.267 | 1566.9 | 12.39× | < 0.001 |
| frame | 157.3 | 224.4 | 1.43× | < 0.001 | 2067.8 | 13.15× | < 0.001 |
| pcall | 129.7 | 321.0 | 2.47× | < 0.001 | 612.1 | 4.72× | < 0.001 |
| string | 77.0 | 79.4 | 1.03× | 0.829 | 960.2 | 12.48× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 75 | 66 | 0.89× | 62 | 0.83× |
| warm | 47 | 41 | 0.88× | 35 | 0.75× |

## Firefox 151

Run: firefox 151.0, 2026-10-13, lua.wasm at 0af7271, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 1765.0 | 1717.0 | 0.97× | 0.756 | 2619.0 | 1.48× | < 0.001 |
| fib | 648.5 | 700.5 | 1.08× | 0.003 | 2270.0 | 3.50× | < 0.001 |
| frame | 1059.0 | 1274.0 | 1.20× | < 0.001 | 4337.0 | 4.10× | < 0.001 |
| pcall | 5367.5 | 4193.5 | 0.78× | < 0.001 | 2697.0 | 0.50× | < 0.001 |
| string | 429.0 | 384.5 | 0.90× | 0.003 | 1158.0 | 2.70× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 137 | 123 | 0.90× | 95 | 0.69× |
| warm | 112 | 115 | 1.03× | 75 | 0.67× |

## WebKit 26.5

Run: webkit 26.5, 2026-10-13, lua.wasm at 0af7271, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 344.5 | 321.0 | 0.93× | 0.016 | 1742.5 | 5.06× | < 0.001 |
| fib | 127.0 | 103.5 | 0.81× | < 0.001 | 1214.5 | 9.56× | < 0.001 |
| frame | 158.5 | 200.0 | 1.26× | 0.005 | 2268.0 | 14.31× | < 0.001 |
| pcall | 822.0 | 2706.0 | 3.29× | < 0.001 | 1001.5 | 1.22× | < 0.001 |
| string | 72.0 | 68.0 | 0.94× | 0.433 | 1011.0 | 14.04× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 103 | 115 | 1.12× | 65 | 0.63× |
| warm | 53 | 55 | 1.03× | 24 | 0.45× |
