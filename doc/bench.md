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
date and commit. Two sets are kept: the **current** tables, taken
after the optimization round of
[`history/perf-research-2026-10-13.md`](history/perf-research-2026-10-13.md),
and the **baseline** taken before it (issue #54), so the round's effect
is readable. The machine is one CI-class container, so absolute times
are not comparable across tables, and ratios between the two sets
carry run-to-run noise of a few percent (Wasmoon's own medians move
that much between the sets); the ratio within a table is the claim.

## What they say

- **Load to first print**: lua.wasm now starts ahead of Wasmoon in
  every engine, cold and warm — Chromium 58/30 ms against 70/40,
  Firefox 114/93 against 123/100, WebKit 57/37 against 101/46 — where
  the baseline was behind in Chromium and Firefox. fengari, being
  JavaScript, is still fastest in Firefox and WebKit and level in
  Chromium.
- **Pure interpretation** (`fib`): Wasmoon is still ahead, and the gap
  narrowed — 0.77× → 0.87× in Chromium, 0.81× → 0.88× in WebKit (both
  significant now), 1.07× ours in Firefox. The two run the same
  interpreter; what remains is compilation (Emscripten's and ours
  differ in libc, allocator and link) and is open.
- **Error handling** (`pcall`): lua.wasm is 2.1× Wasmoon in Chromium
  and 2.7× in WebKit — Lua errors stay inside wasm here and round-trip
  through JavaScript there — but **0.74× in Firefox**, where
  SpiderMonkey's wasm exception throw costs about 27 µs and fengari,
  throwing JavaScript exceptions, is faster than both.
- **Game-shaped frames** (`frame`: update, sort, neighbours): lua.wasm
  ahead in every engine, 1.1–1.3×.
- **Allocation** and **strings**: within a few percent either way in
  Chromium and WebKit; Wasmoon slightly ahead in Firefox and on
  allocation in WebKit.
- **fengari** is 4–15× behind both wasm engines on everything except
  Firefox's `pcall`, where it leads.

## Workloads

| name | what it exercises |
|---|---|
| `fib` | function calls and arithmetic, no allocation: `fib(30)` |
| `pcall` | 200,000 protected calls that each raise and catch an error |
| `alloc` | 500,000 short-lived tables and strings, then a checksum |
| `string` | 50,000 `string.format`s, `table.concat`, a `gsub` over 500 KB, `gmatch` |
| `frame` | 60 frames of 2,000 entities: update, `table.sort` by a total key, neighbour count |

## Current: Chromium 141

Run: chromium 141.0.7390.37, 2026-10-13, lua.wasm at 831b834, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 353.0 | 363.4 | 1.03× | 0.665 | 1487.2 | 4.21× | < 0.001 |
| fib | 107.9 | 94.0 | 0.87× | 0.005 | 1476.8 | 13.69× | < 0.001 |
| frame | 154.6 | 183.8 | 1.19× | 0.048 | 1982.4 | 12.82× | < 0.001 |
| pcall | 138.9 | 289.7 | 2.09× | < 0.001 | 605.9 | 4.36× | < 0.001 |
| string | 84.0 | 75.7 | 0.90× | 0.543 | 827.8 | 9.86× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 58 | 70 | 1.20× | 58 | 1.00× |
| warm | 30 | 40 | 1.33× | 34 | 1.13× |

## Current: Firefox 151

Run: firefox 151.0, 2026-10-13, lua.wasm at 831b834, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 1906.0 | 1799.5 | 0.94× | 0.044 | 2593.5 | 1.36× | < 0.001 |
| fib | 635.5 | 680.0 | 1.07× | 0.010 | 2266.0 | 3.57× | < 0.001 |
| frame | 1034.5 | 1300.5 | 1.26× | < 0.001 | 4102.0 | 3.97× | < 0.001 |
| pcall | 5535.0 | 4068.5 | 0.74× | < 0.001 | 2655.5 | 0.48× | < 0.001 |
| string | 406.0 | 385.0 | 0.95× | 0.051 | 1135.5 | 2.80× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 114 | 123 | 1.08× | 78 | 0.68× |
| warm | 93 | 100 | 1.08× | 62 | 0.67× |

## Current: WebKit 26.5

Run: webkit 26.5, 2026-10-13, lua.wasm at 831b834, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 351.5 | 322.0 | 0.92× | 0.102 | 1717.5 | 4.89× | < 0.001 |
| fib | 121.0 | 106.5 | 0.88× | 0.010 | 1222.5 | 10.10× | < 0.001 |
| frame | 162.0 | 179.0 | 1.10× | 0.034 | 2352.5 | 14.52× | < 0.001 |
| pcall | 958.0 | 2621.5 | 2.74× | < 0.001 | 879.5 | 0.92× | 0.021 |
| string | 68.0 | 65.5 | 0.96× | 0.507 | 953.0 | 14.01× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 57 | 101 | 1.76× | 54 | 0.94× |
| warm | 37 | 46 | 1.23× | 20 | 0.54× |

## Baseline

The tables below are the run before the optimization round, kept for
the comparison above; the current tables are the claim.

## Baseline: Chromium 141

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

## Baseline: Firefox 151

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

## Baseline: WebKit 26.5

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
