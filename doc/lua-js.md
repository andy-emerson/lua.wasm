# lua.js: Lua in a web page

Reference for `lua.js`, the one file that runs `<script type="text/lua">`
tags in HTML and gives JavaScript the `Lua` global. Its reader is the
page author or web developer using it; how it is built and why its
defaults are what they are is in
[`history/browser-native-2026-10-13.md`](history/browser-native-2026-10-13.md)
(D8), and the module it carries is described in [`wasm.md`](wasm.md).

## The file

`lua.js` is a classic script — `<script src="lua.js"></script>`, no
`type="module"`, no build step, no server requirement — that carries
`lua.wasm` inside it, so a page works from any static server or from a file opened from
disk. Releases attach it; `make lua-js` builds it. The inline form costs
about 40% more compressed than the module alone — the price of one
file; the README carries the sizes of the current build.

It needs a browser with the standard WebAssembly exception-handling
encoding: Chrome 137, Firefox 131 and Safari 18.4 or later by
webassembly.org's feature data (stated; CI runs current engines).

## Script tags

```html
<script src="lua.js"></script>
<script type="text/lua">
  print("Hello from " .. _VERSION)
</script>
```

Tags run **once the document has been parsed (`DOMContentLoaded`), in document order**, in **one
Lua state** for the page: a global set in one tag is visible in the
next (chunk-level `local`s are private, as always). Each tag is a chunk
named by its `id` or `(lua script N)`.

**Output.** `print` and `io.write` land in a `<pre class="lua-output">`
inserted right after the tag (at the end of the body for a tag in
`<head>`). An error lands beside it in a `<pre class="lua-error">`,
named by the chunk and line (`first:4: boom`), and in `console.error`.
Style both classes as you like.

| attribute | effect |
|---|---|
| `src="main.lua"` | fetch and run that file instead of the tag's text; the chunk is named `@main.lua` |
| `data-output="#id"` | output goes into that element; `data-output="console"` to the console only |
| `data-stdin="text"` | what `io.read` sees, then end of input; absent: end of input at once; `data-stdin="prompt"` asks the visitor with `window.prompt` per read |
| `data-files="util.lua data/levels.json"` | fetched beside the page into the same paths under `/` before the tag runs |

**Files and `require`.** The module has an in-memory filesystem whose
root is the working directory. `require "util"` finds `/util.lua` if
it is there; if not, the script asks the page, which fetches
`util.lua` beside itself (dots become slashes: `require "deep.helper"`
fetches `deep/helper.lua`), puts it in the filesystem and resumes — so
modules need no listing. A module's own `require`s are served the
same way. What a program sees is stock `require`: its results, its
use of `package.loaded`, `package.preload` and `package.path`, and its
error messages byte for byte (the witness compares them with native
Lua). Two limits: a `require` called from inside a C function (a
`table.sort` comparator, a `string.gsub` callback) cannot pause to
fetch and fails with the stock "module not found" message plus a hint
(put the module in the filesystem first: in a page, list it in
`data-files`); and a fetch that fails appends its reason to that
message. Data files are never fetched implicitly: list
them in `data-files`.

**Animation and long programs.** Every tag runs as the module's
resident coroutine, so a top-level `coroutine.yield()` returns control
to the page and the script resumes on the next animation frame:

```lua
while running do
  draw()
  coroutine.yield()
end
```

A tag that never yields runs to completion. One program is resident at
a time: a later tag waits until a yielding one finishes, so put a game
loop last. One visible consequence: inside a tag
`coroutine.isyieldable()` is true and `coroutine.running()` is not the
main thread, where the `lua` command line would say otherwise.

**`os.exit`** ends the VM for the page: the tag shows `[exit N]`, and
every later tag reports `VM exited (status N)` instead of running.

**Local time** is the visitor's: before the first tag, `lua.js` writes
a zone file for the browser's time zone to `/etc/localtime`, built
from the browser's own rules for the current year ±1 with a POSIX rule
for dates beyond, so `os.date`, `os.time`, `isdst` and `%Z` behave as
on a machine set to that zone. Where the browser has no lettered
abbreviation for the zone, `%Z` shows the numeric form (`+0530`).

**Limits of fetching.** `src` and `data-files` use `fetch`: they need
the file on the same origin as the page (or CORS headers), and they do
not work from a `file://` page — inline tags do.

## The `Lua` global

What a page's own JavaScript gets. A call from JavaScript prints to the
console (its terminal), not to the page, unless redirected.

| | |
|---|---|
| `await Lua.ready` | resolves (with `Lua`) once the VM exists and the page's tags have run; every function below throws before that, even while a tag is still running (the two properties, `message` and `exitCode`, read `null`) |
| `Lua.run(source, name?)` | run a chunk to completion; throws an `Error` carrying the Lua message |
| `Lua.start(source, name?)` | load a program as the resident coroutine |
| `await Lua.step(msg?)` | resume it once: resolves `1` while it is alive and yielded, `0` when it finished; throws on error. `msg` is what its `coroutine.yield()` returns (the chunk's `...` on the first step). A lazy `require` inside the program is served before `step` resolves |
| `Lua.message` | the string (or number) the program yielded on the last step, or `null` |
| `Lua.files.put(path, data)` | a string or `Uint8Array`; parents are created |
| `Lua.files.get(path)` / `getText(path)` | bytes / text, or `null` |
| `Lua.files.list()` / `remove(path)` / `mkdir(path)` | the rest of the filesystem |
| `Lua.env(name, value)` | set an environment variable (`null` removes it); the environment starts empty |
| `Lua.on('print', fn)` / `Lua.on('error', fn)` | where output and errors of JavaScript calls go; `null` restores the console |
| `Lua.exitCode` | after `os.exit`: its status; `Lua.run`, `start`, `step`, `files.*` and `env` throw `VM exited (status N)` from then on |

| `Lua.js` | the bridge's table: `Lua.js.name = fn` is `js.name(...)` in Lua (below); usable before `ready` |

## The bridge: `Lua.js` and `js`

The page registers functions by assigning them into `Lua.js`; Lua
calls them as `js.name(...)`. Nothing else on the page is reachable
from Lua, and values cross **by copy** — never by reference:

| crosses | as |
|---|---|
| `nil`, booleans | `null`/`undefined`, booleans |
| integers, floats | numbers; an integer beyond 2^53 is a `BigInt`; a JavaScript integer-valued number is a Lua integer, other numbers are floats |
| strings | strings (UTF-8); `js.bytes(s)` sends a string as a `Uint8Array`; a `Uint8Array` (or any buffer) arrives as a Lua string |
| tables | a sequence is an `Array` (a `null` inside ends the sequence on the way back); other keys make a plain object when every key is a string, else a `Map`; the 1-based array part joins the `Map` under its numbers |
| a promise (from JavaScript) | a **token** (below) |
| functions, DOM nodes, class instances, cycles | do not cross: a Lua error says why (`value does not cross: function`) |

A call is synchronous and returns the function's one result. A
function that throws is a Lua error carrying the exception's message.
A name nobody registered fails at the call: `no such function 'x'`.
One call carries at most 16 MiB and 64 levels of nesting.

**Promises and tokens.** A function that returns a promise hands Lua a
token at once. The token is a small table:

```lua
local t = js.fetchText("a.txt")       -- a token; the request is in flight
t:when(function (ok, v) ... end)      -- run this when it settles
local ok, v = t:await()               -- or wait for it: ok is false on rejection, v the message
print(t:settled())                    -- true once the outcome has arrived
```

`await` yields the resident program to the page and resumes on the
frame after the promise settles; several tokens can be in flight. It
only works inside a tag's program (or `Lua.start`'s): from a `Lua.run`
chunk, use `:when` — the continuation runs on the next `Lua.run` or
`Lua.step`, since the module never runs on its own. `js.poll()` is the
primitive both are built on: it returns the settlements delivered since
the last call, and a program that wants to own its loop can use it
directly. An error inside a `when` continuation goes to the console
(`js: error in a when continuation: ...`) and does not stop the program.
Fire-and-forget calls should use `:when`, or the outcome is kept until
someone asks for it.

**Built in**, replaceable by assigning over them: `js.log(...)`
(`console.log`), `js.now()` (ms since the epoch), `js.fetch(url)` (a
token: the body as bytes, or an error naming the URL and status).

```html
<script src="lua.js"></script>
<script>
  Lua.js.add = (a, b) => a + b;
  Lua.js.pick = (list) => list[Math.floor(Math.random() * list.length)];
  Lua.js.later = (v, ms) => new Promise(r => setTimeout(() => r(v), ms));
</script>
<script type="text/lua">
  print(js.add(2, 3), js.pick({"a", "b", "c"}))
  local a, b = js.later("a", 40), js.later("b", 1)     -- both in flight
  b:when(function (ok, v) print("b first:", v) end)
  print("a:", select(2, a:await()))
</script>
```

**HTML and JavaScript from Lua** are the page's to grant, the same
way: register a function that does it. Nothing in `lua.js` evaluates
code or writes markup on Lua's behalf.

```html
<script src="lua.js"></script>
<script>
  Lua.js.html = (id, markup) => { document.getElementById(id).innerHTML = markup; };
  Lua.js.eval = (code) => eval(code);        // grants Lua the whole page: only for Lua you wrote
</script>
<div id="out"></div>
<script type="text/lua">
  js.html("out", "<b>" .. _VERSION .. "</b> at " .. os.date())
  print(js.eval("document.title"))
</script>
```

A page that registers neither has a Lua that can print and nothing
more, whatever the script's source; one that registers `eval` has
handed that source the page. Register what the program needs, by name.

Why by copy, in one sentence: a proxy-and-handle bridge spends what
wasm is good at (isolation, deterministic memory, predictable speed) on
per-property boundary crossings and garbage-collector entanglement on
both sides; copy-across keeps them, and a frame's worth of work crosses
as one table. The decision, its alternatives and its reopen trigger are
in [`history/browser-native-2026-10-13.md`](history/browser-native-2026-10-13.md) (D11).

```html
<script src="lua.js"></script>
<script>
  Lua.ready.then(async () => {
    Lua.run('print(2^10)');                         // console: 1024.0
    Lua.js.title = (t) => { document.title = t; };  // callable from any later chunk as js.title(...)
    Lua.start('local n = 0 while true do n = n + 1 coroutine.yield(n) end');
    const tick = async () => { await Lua.step(); document.title = Lua.message; requestAnimationFrame(tick); };
    tick();
  });
</script>
```

## Building and testing it

`make lua-js` assembles `lua.js` from `scripts/host.mjs` (the
module's JavaScript side, shared with the Node witnesses),
`scripts/loader.js` (the tags and the `Lua` global) and `lua.wasm`
(base64), and prints the sizes above. `scripts/lua-js-witness.mjs
lua.js lua.wasm --engine <chromium|firefox|webkit>` opens one page per
behaviour above (`scripts/browser/pages/`) in a real engine from a
plain static server — and one page as `file://` — and asserts on the
output elements, the error elements and the console; the time page
runs under three zones (New York, Kolkata, Sydney) against `Intl` as
the oracle; the bridge page covers the table above, two promises in
flight, `when`, `await`, the built-ins and the error rule. CI runs it
in all three engines on every change.
