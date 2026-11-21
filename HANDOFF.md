# Handoff — branch `claude/nice-pascal-rflxa7`, written 2026-11-21

A session note, not a durable document: delete it before this branch
merges. It says where the project stands, what was decided in the last
session, what is still open, and how to pick up.

## The project in one paragraph

lua.wasm is stock Lua 5.4.8 (verbatim) on verbatim musl 1.2.6, compiled
to one WebAssembly module with four imports (`luaw.write`, `luaw.now`,
`luaw.read`, `luaw.call`), no WASI, no Emscripten. `lua.js` is that
module inlined into one classic script: a page includes it and writes
`<script type="text/lua">` tags; Lua calls the page through functions
the page registers in `Lua.js`. A release carries two things for
consumers — `lua.js` and the tarball `lua-wasm-sdk-<version>.tar.gz`
(the archive `lua.wasm` is linked from, for C/C++/Rust programs that
link Lua into their own module) — plus `lua.wasm` itself, attached as
the certified build the witnesses ran on. The working agreement is
`AGENTS.md` (the Human decides, merges and closes decisions; the Agent
plans, builds and recommends; one commit = one code pass or one doc
pass, each with an `Evidence:` line).

## Where the branch stands

`main` is at the merge of #78 (M6, the tarball), 2026-10-14. This
branch is restarted from that `main` and carries nothing but this file.
Every witness is green on `main` under both toolchains: clang-20
(witness.yml, run 38656621405) and the zig recipe (deep-witness.yml,
run 38657398835).

Done since v0.3.1: M5 (the bridge, #76) and M6 (the tarball, #78).
Milestones and their order are on #71.

## What the last session decided (the Human, 2026-10-15)

- **CI toolchain:** the Makefile defaults (llvm.org clang-20, lld-20,
  libclang-rt-20-dev-wasm32). zig 0.15.1 is the alternative recipe,
  witnessed by the deep witness, and compiles the native musl oracle.
  Under zig the link passes `-rtlib=none` and names LLVM's builtins
  (`MUSL_RTLIB`), because zig's compiler-rt carries a weak libm that lld
  keeps over musl's behind an archive. Recorded in the design record.
- **`lua.wasm` stays attached** to releases as the certified build, not
  as a product. Wording fix pending in README "Use it", doc/wasm.md and
  the release notes (listed on #69).
- **Node:** a supported host for `lua.js` applications once `lua.js`
  loads without a page (#69); a program that was never a web program is
  better served by native Lua — a recommendation, not a prohibition.
  #74 (interactive `lua -i` under Node) closed as not planned.
- **npm:** not needed; distribute by URL (the site, versioned paths, SRI
  hashes) and download/vendoring. #79 holds npm with its reopen trigger
  (a JavaScript application asks, or the free CDN mirrors are wanted).
  Not yet formally closed — close it with that trigger.
- **Name:** leaning **LuaJS** (project), file `lua.js`, module
  `lua.wasm`, tarball `luajs-sdk-<version>`. Not closed. Checked: `luajs`
  and `lua-js` are free on npm (moot without npm); the dotted `lua.js`
  on npm is someone else's transpiler (irrelevant without npm);
  `luajs.com` was free on 2026-10-13; `luajs` as a GitHub organization
  could not be checked from the container — open github.com/luajs in a
  browser (404 = free). Rejected after discussion: LunaJS (unownable
  word), Lunula (empty), LuaScript (the Roblox "Lua script" neighbourhood
  and the "it's a language" reading), lua.wasm (accurate, unfindable).
- **Site front page:** a draft `index.html` for luajs.com was delivered
  (artifact https://claude.ai/artifact/C4uJ1BiyAJeF3bPtrU2mPz; the file
  was sent in chat). The Human did not like it; no revision was asked
  for. Treat it as a starting point at most.

## Open issues, in the Human's order (#71)

1. **Optimization:** #66 numeric workload and `-fhosted` (needs a yes on
   adding a workload), #65 per-phase start-up timing, #64 Firefox throw
   reproducer and upstream report (the report waits on a go), #63 the
   fib gap at engine level, #77 bridge call overhead. The Human has not
   said which opens the branch.
2. **Packaging, #69** (rewritten 2026-10-15): the name and domain (the
   Human's), `lua.js` loading under Node (`document` guard,
   `Lua.create()`), one version stamp across the three files, a header
   for `luaw_openlibs`, Pages with versioned paths and SRI, the wording
   fix above. #80 holds examples and where they live (the Human's lean:
   the site, not the README).
3. **Re-org and cleanup, #70** (two notes from M6 added as a comment).
4. **v0.4.0.**

## How to build and witness here (this container has no clang-20)

```sh
S=<scratchpad>; # binaryen is at $S/binaryen-pkg/node_modules/binaryen/bin/wasm-opt
apt-get install -y libclang-rt-18-dev-wasm32   # LLVM's wasm32 builtins
make wasm lua-js sdk sdk-check embed-check \
  WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
  WASM_CLANGXX="python3 -m ziglang c++" \
  WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
  MUSL_RTLIB=/usr/lib/llvm-18/lib/clang/18/lib/wasi/libclang_rt.builtins-wasm32.a \
  WASM_OPT="node $S/binaryen-pkg/node_modules/binaryen/bin/wasm-opt" \
  EMBED_CC=clang-18 NODE="node --experimental-wasm-exnref"
node --experimental-wasm-exnref scripts/interface-witness.mjs lua.wasm   # 105 checks
NODE_PATH=$S/binaryen-pkg/node_modules node --experimental-wasm-exnref scripts/eh-check.mjs lua.wasm
node --experimental-wasm-exnref scripts/suite-witness.mjs lua.wasm tests
make differential NATIVE_MUSL_CC="python3 -m ziglang cc" WASM_OPT=""
# browsers: NODE_PATH=$(npm root -g)/playwright/node_modules:$(npm root -g) \
#   CHROMIUM=/opt/pw-browsers/chromium-1194/chrome-linux/chrome \
#   node scripts/lua-js-witness.mjs lua.js lua.wasm --engine chromium   # 54 checks
```

Node here is 22, hence the flag; CI uses Node 24.15+ unflagged.

## Session conventions to carry over

Commits are authored by Andy Emerson
(`156483017+andy-emerson@users.noreply.github.com`) with the Agent as
co-author (answered yes for the session); subject states what is now
true; `Evidence:` line; a progress account at the end of a commit's
work. No model identifiers in anything pushed. The Human approves
plans piecewise; "go" on one step is not "go" on the plan. A PR opens
only after the repo-scale code review and documentation review (as
independent reads); the Human merges; the branch restarts from `main`.
