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
date and commit. Two sets are kept: the **current** tables, taken with
the bridge (the `js` library over `luaw.call`) and its four workloads, and the **baseline** taken
before the optimization round (issue #54), so the distance travelled is
readable; the optimization round's own tables are cited in
[`history/perf-research-2026-10-13.md`](history/perf-research-2026-10-13.md).
The machine is one CI-class container, so absolute times are not
comparable across tables, and ratios between the two sets carry
run-to-run noise of a few percent; the ratio within a table is the
claim.

## What they say

- **The bridge, data crossing**: a frame's positions handed to the page
  each frame (`bridge_frame`) runs 24× Wasmoon in Chromium, 9× in
  Firefox, 31× in WebKit, and 2–5× fengari; a table of 100 numbers out
  and its sum back (`bridge_table`) 8–24× Wasmoon and 2–4× fengari.
  Wasmoon converts a Lua table through its binding layer element by
  element; fengari reads it through a wrapper per element; here it is
  one copy each way.
- **The bridge, scalar calls** (`bridge_call`, 200,000 calls out):
  1.10× Wasmoon in Chromium, 1.33× in WebKit, **0.61× in Firefox**;
  1.7–1.9× fengari in Chromium and WebKit, 0.69× in Firefox. A call
  here is an encode, the import, a re-entry for the result buffer and a
  decode; Firefox's wasm-to-JavaScript boundary is the costliest of the
  three engines (as its `pcall` row also shows), and a pre-allocated
  result buffer would remove one crossing per call (an optimization
  item).
- **The bridge, the other way** (`bridge_in`, 50,000 strings handed to
  Lua): 1.5× Wasmoon in Chromium, 1.2× in WebKit, 0.26× in Firefox;
  behind fengari everywhere (0.1–0.6×): fengari calls a Lua function
  directly, ours resumes the resident program with a message per step.
- **Error handling** (`pcall`): 1.9× Wasmoon in Chromium and 2.8× in
  WebKit — Lua errors stay inside wasm here and round-trip through
  JavaScript there — but **0.75× in Firefox**, where SpiderMonkey's
  wasm exception throw costs about 27 µs (#64) and fengari, throwing
  JavaScript exceptions, is faster than both.
- **Pure interpretation** (`fib`): Wasmoon is ahead, 0.90× in Chromium
  and WebKit (significant), 1.08× ours in Firefox; unexplained at the
  build level (#63).
- **Game-shaped frames** (`frame`): lua.wasm ahead in every engine,
  1.15–1.27×. **Allocation** and **strings**: within 8% either way.
- **Load to first print**: with the bridge, lua.js is 24 KB larger and
  cold start is now level to slightly behind Wasmoon (0.90–0.96×:
  62 vs 56 ms in Chromium, 105 vs 99 Firefox, 75 vs 72 WebKit) and
  ahead warm (1.04–1.14×); fengari, being JavaScript, starts fastest
  everywhere (#65 is the per-phase breakdown).
- **fengari** is 4–15× behind both wasm engines on compute in Chromium
  and WebKit and 1.4–4× in Firefox, where it leads on `pcall`; and it
  leads everywhere on calls into Lua.

## Workloads

| name | what it exercises |
|---|---|
| `fib` | function calls and arithmetic, no allocation: `fib(30)` |
| `pcall` | 200,000 protected calls that each raise and catch an error |
| `alloc` | 500,000 short-lived tables and strings, then a checksum |
| `string` | 50,000 `string.format`s, `table.concat`, a `gsub` over 500 KB, `gmatch` |
| `frame` | 60 frames of 2,000 entities: update, `table.sort` by a total key, neighbour count |
| `bridge_call` | the bridge, scalars: 200,000 calls out to a registered `add(a, b)` |
| `bridge_table` | the bridge, a table crossing: 2,000 tables of 100 numbers out, their sums back |
| `bridge_frame` | the bridge, a frame end to end: 60 frames of 2,000 entities moved in Lua, their positions handed to the page each frame, rendered into a buffer, a checksum back |
| `bridge_in` | the bridge, the other way: the page hands Lua 50,000 ten-byte strings, one call (one step of the resident program, for lua.wasm) each |

Each bridge workload calls a `bridge` table that every implementation
registers in its own idiom: ours through `Lua.js` by copy, Wasmoon
through `global.set` with its table conversion, fengari through
`js.global` with its value wrappers and, the other way, its this-first
calling convention adapted as its documentation shows
(`bench/bench-page.html`).

## Current: Chromium 141

Run: chromium 141.0.7390.37, 2026-10-14, lua.wasm at 538455f, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 356.8 | 337.4 | 0.95× | 0.168 | 1403.8 | 3.93× | < 0.001 |
| bridge_call | 618.5 | 677.8 | 1.10× | 0.005 | 1148.6 | 1.86× | < 0.001 |
| bridge_frame | 37.7 | 898.9 | 23.88× | < 0.001 | 193.9 | 5.15× | < 0.001 |
| bridge_in | 132.8 | 200.5 | 1.51× | < 0.001 | 80.6 | 0.61× | < 0.001 |
| bridge_table | 55.4 | 732.9 | 13.23× | < 0.001 | 158.0 | 2.85× | < 0.001 |
| fib | 102.9 | 93.0 | 0.90× | 0.009 | 1410.7 | 13.72× | < 0.001 |
| frame | 142.0 | 180.0 | 1.27× | < 0.001 | 1863.9 | 13.13× | < 0.001 |
| pcall | 144.6 | 273.1 | 1.89× | < 0.001 | 572.3 | 3.96× | < 0.001 |
| string | 71.3 | 76.8 | 1.08× | 0.102 | 854.6 | 11.99× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 62 | 56 | 0.90× | 44 | 0.70× |
| warm | 30 | 33 | 1.10× | 29 | 0.96× |

## Current: Firefox 151

Run: firefox 151.0, 2026-10-14, lua.wasm at 538455f, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 1760.0 | 1616.0 | 0.92× | < 0.001 | 2533.5 | 1.44× | < 0.001 |
| bridge_call | 1523.0 | 935.0 | 0.61× | < 0.001 | 1054.0 | 0.69× | < 0.001 |
| bridge_frame | 188.5 | 1659.0 | 8.80× | < 0.001 | 423.5 | 2.25× | < 0.001 |
| bridge_in | 1421.5 | 369.0 | 0.26× | < 0.001 | 137.5 | 0.10× | < 0.001 |
| bridge_table | 160.0 | 1331.0 | 8.32× | < 0.001 | 288.0 | 1.80× | < 0.001 |
| fib | 620.0 | 670.0 | 1.08× | < 0.001 | 2122.5 | 3.42× | < 0.001 |
| frame | 1016.5 | 1189.0 | 1.17× | < 0.001 | 3856.0 | 3.79× | < 0.001 |
| pcall | 5236.0 | 3951.0 | 0.75× | < 0.001 | 2489.0 | 0.48× | < 0.001 |
| string | 411.0 | 386.0 | 0.94× | 0.110 | 1066.5 | 2.59× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 105 | 99 | 0.94× | 77 | 0.73× |
| warm | 80 | 92 | 1.14× | 57 | 0.71× |

## Current: WebKit 26.5

Run: webkit 26.5, 2026-10-14, lua.wasm at 538455f, Wasmoon 1.16.0, fengari-web 0.1.4; 20 rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.

| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |
|---|--:|--:|--:|--:|--:|--:|--:|
| alloc | 308.0 | 291.0 | 0.94× | 0.010 | 1587.5 | 5.15× | < 0.001 |
| bridge_call | 646.0 | 860.5 | 1.33× | < 0.001 | 1123.5 | 1.74× | < 0.001 |
| bridge_frame | 41.5 | 1273.5 | 30.69× | < 0.001 | 220.0 | 5.30× | < 0.001 |
| bridge_in | 238.5 | 285.0 | 1.19× | < 0.001 | 91.0 | 0.38× | < 0.001 |
| bridge_table | 44.0 | 1036.0 | 23.55× | < 0.001 | 158.5 | 3.60× | < 0.001 |
| fib | 118.0 | 106.0 | 0.90× | < 0.001 | 1116.0 | 9.46× | < 0.001 |
| frame | 155.0 | 177.5 | 1.15× | < 0.001 | 1977.5 | 12.76× | < 0.001 |
| pcall | 916.5 | 2597.0 | 2.83× | < 0.001 | 948.5 | 1.03× | 0.194 |
| string | 64.5 | 62.0 | 0.96× | 0.472 | 946.0 | 14.67× | < 0.001 |

Load to first print (ms from navigation; cold = fresh context, warm = cached; 10 rounds):

| | lua.wasm | Wasmoon | ratio | fengari | ratio |
|---|--:|--:|--:|--:|--:|
| cold | 75 | 72 | 0.96× | 49 | 0.66× |
| warm | 39 | 41 | 1.04× | 20 | 0.51× |

## Baseline: the run before the optimization round

Kept for the comparison above; the current tables are the claim.

### Chromium 141

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

### Firefox 151

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

### WebKit 26.5

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
