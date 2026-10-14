// interface-witness.mjs -- the host-interface witness for lua.wasm:
// every import and export of the contract, each with the
// behaviour the design record assigns it, plus the adversarial battery
// the former WASI reactor's stress witness ran (contained stack overflow,
// mid-flight death and replacement, a 50k-frame pump, GC under
// allocation pressure).
//
//   node scripts/interface-witness.mjs lua.wasm
//
// Exits 0 only if every check passes. Each check names what it asserts.
import { readFileSync } from 'node:fs';
import { createLua } from './host.mjs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/interface-witness.mjs <lua.wasm>'); process.exit(2); }
const bytes = readFileSync(file);
const module = await WebAssembly.compile(bytes);

let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' -- ' + String(detail).slice(0, 200) : ''}`); }
}
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

async function fresh(opts = {}) {
  const out = { stdout: '', stderr: '' };
  const lua = await createLua(module, { stdout: s => { out.stdout += s; }, stderr: s => { out.stderr += s; }, ...opts });
  lua.out = out;
  lua.take = () => { const o = { ...out }; out.stdout = ''; out.stderr = ''; return o; };
  return lua;
}
const trapOf = (f) => { try { f(); return null; } catch (e) { return e; } };

console.log('imports and exports');
{
  const lua = await fresh();
  eq('the module imports exactly luaw.{call,now,read,write}', lua.imports, ['luaw.call', 'luaw.now', 'luaw.read', 'luaw.write']);
  /* the export list is the API: nothing of Lua's or the libc's leaks out
     (clang hides wasm symbols by default; --export-dynamic exports only
     what is marked default visibility) */
  eq('the module exports exactly memory, _initialize, the __cpp_exception tag and the luaw_* functions',
     WebAssembly.Module.exports(module).map(e => `${e.kind}:${e.name}`).sort(),
     ['function:_initialize', 'function:luaw_alloc', 'function:luaw_exit_code', 'function:luaw_free',
      'function:luaw_fs_get', 'function:luaw_fs_list', 'function:luaw_fs_mkdir', 'function:luaw_fs_put', 'function:luaw_fs_remove',
      'function:luaw_init', 'function:luaw_last_error', 'function:luaw_main', 'function:luaw_message',
      'function:luaw_run', 'function:luaw_setenv', 'function:luaw_start', 'function:luaw_step',
      'memory:memory', 'tag:__cpp_exception']);
}

console.log('the bridge: values by copy through luaw.call');
{
  const lua = await fresh();
  lua.init();
  const seen = [];
  lua.js.echo = (v) => v;
  lua.js.add = (a, b) => a + b;
  lua.js.record = (...args) => { seen.push(args); return args.length; };
  lua.js.boom = () => { throw new Error('boom from JavaScript'); };
  lua.js.bytes = (b) => b;
  lua.js.big = (n) => 'x'.repeat(n);
  lua.js.obj = () => ({ a: 1, b: [1, 2.5, 'three', null, true], c: { d: 'deep' } });
  lua.js.map = () => new Map([[1, 'one'], ['k', 'v']]);
  lua.js.promise = () => Promise.resolve(1);
  lua.js.cycle = () => { const a = {}; a.self = a; return a; };
  lua.js.fn = () => () => 1;
  /* a Lua-side deep equality, printed per case, so each round trip is one line */
  lua.run(`
    local function same(a, b)
      if type(a) ~= type(b) then return false end
      if type(a) ~= "table" then
        if a ~= a and b ~= b then return true end   -- NaN
        return a == b and math.type(a) == math.type(b)
      end
      for k, v in pairs(a) do if not same(v, b[k]) then return false end end
      for k in pairs(b) do if a[k] == nil then return false end end
      return true
    end
    _G.same = same
    local cases = { nil, false, true, 0, 1, -1, math.maxinteger, math.mininteger, 1.5, -0.0, 1/0, -1/0, 0/0,
      "", "héllo", "with\\0nul", {}, {1, 2, 3}, {a = 1, b = "two"}, {1, 2, x = "mixed"}, {{{{"deep"}}}}, {[1.5] = "float key", [true] = "bool key"} }
    local out = {}
    for i = 1, 23 do
      local v = cases[i]
      local ok, r = pcall(js.call, "echo", v)
      out[#out + 1] = tostring(ok and same(r, v))
    end
    print(table.concat(out, " "))
  `);
  eq('23 values round-trip unchanged (nil, booleans, integers at both limits, floats incl. -0, inf, nan, strings incl. NUL, tables: sequence, hash, mixed, nested, float and boolean keys)',
     lua.take().stdout, ('true ').repeat(22) + 'true\n');
  lua.run('print(js.call("add", 2, 3), js.call("add", 2.5, 1), js.call("add", "a", "b"), js.call("record", 1, nil, 3), js.call("record"))');
  eq('arguments cross in order, nil included; results come back typed', [lua.take().stdout, seen], ['5\t3.5\tab\t3\t0\n', [[1, null, 3], []]]);
  lua.run('local t = js.call("obj") print(t.a, #t.b, t.b[2], t.b[3], t.b[4], t.b[5], t.c.d) local m = js.call("map") print(m[1], m.k)');
  eq('a JavaScript object arrives as a table, an Array as a sequence (null inside becomes nil), a Map by its keys', lua.take().stdout, '1\t5\t2.5\tthree\tnil\ttrue\tdeep\none\tv\n');
  lua.run('local b = js.call("bytes", js.bytes("\\0\\255\\1")) print(#b, b:byte(1, 3)) print(#js.call("big", 1000000))');
  eq('bytes cross as bytes both ways (js.bytes marks them); a 1 MB string crosses', lua.take().stdout, '3\t0\t255\t1\n1000000\n');
  lua.run('print(pcall(js.call, "boom")) print(pcall(js.call, "nope")) print(pcall(js.call, {})) print(pcall(js.call, "echo", print)) print(pcall(js.call, "cycle")) print(pcall(js.call, "fn"))');
  eq('a throwing function is a Lua error with its message; a missing name, a bad name, a function argument, a cycle and a function result are each refused with a stated reason', lua.take().stdout,
     "false\tboom from JavaScript\n" +
     "false\tno such function 'nope' (the host registered none by that name)\n" +
     "false\tbad argument #1 to 'js.call' (string expected, got table)\n" +
     "false\tvalue does not cross: function\n" +
     "false\tvalue does not cross: nesting deeper than 64 (a cycle?)\n" +
     "false\tvalue does not cross: function\n");
  lua.run('local t = {} local c = t for i = 1, 70 do c.n = {} c = c.n end print(pcall(js.call, "echo", t))');
  eq('a Lua table nested past 64 is refused on the way out', lua.take().stdout, 'false\tvalue does not cross: table nesting deeper than 64 (a cycle?)\n');
  /* warm once (the allocator's steady state, Lua's string table), then
     measure: a leak per call would show as growth; freed buffers do not */
  lua.run('for i = 1, 20000 do js.call("echo", {i, "s", {i}}) end collectgarbage() collectgarbage()');
  const before = lua.memory.buffer.byteLength;
  lua.run('for i = 1, 20000 do js.call("echo", {i, "s", {i}}) end collectgarbage() collectgarbage()');
  eq('20k more calls with table results do not grow linear memory (buffers are freed)', lua.memory.buffer.byteLength - before, 0);
  eq('js is a global and package.preload has it too', (lua.run('print(type(js), type(js.call), type(package.preload.js))'), lua.take().stdout), 'table\tfunction\tfunction\n');
  lua.run('print(js.add(40, 2), js.echo("direct"), rawget(js, "add") == js.add, pcall(js.nope))');
  eq('the direct form js.name(...) is js.call("name", ...), made once; a missing name fails at the call', lua.take().stdout, "42\tdirect\ttrue\tfalse\tno such function 'nope' (the host registered none by that name)\n");
}

console.log('the bridge: tokens, await, when, poll');
{
  const lua = await fresh();
  lua.init();
  const resolvers = {};
  lua.js.later = (name) => new Promise((resolve, reject) => { resolvers[name] = { resolve, reject }; });
  lua.js.soon = (v) => Promise.resolve(v);
  lua.js.unsendable = () => Promise.resolve(() => 1);
  const tick = () => new Promise(r => setTimeout(r, 0));   // let settled promises run their callbacks
  lua.run('t = js.soon({1, 2}) print(tostring(t):match("^js%.Token%(%d+%)$") ~= nil, t:settled(), pcall(t.await, t))');
  eq('a promise arrives as a token: unsettled at once; await outside the resident program is refused with a stated reason', lua.take().stdout,
     'true\tfalse\tfalse\tawait: only the resident program can wait for a token (use :when or js.poll)\n');
  await tick();
  eq('the settlement waits in the host until the next run or step', lua.pendingSettlements(), 1);
  lua.run('print(t:settled())');
  eq('the next run delivers it before running the chunk', lua.take().stdout, 'true\n');
  lua.run('local ok, v = t:await() print(ok, v[1], v[2])');
  eq('await on a settled token returns at once with ok and the value, from any chunk', lua.take().stdout, 'true\t1\t2\n');
  /* a resident program: two tokens in flight, one awaited, one with a
     continuation; the host settles them in the opposite order */
  lua.start(`
    local a, b = js.later("a"), js.later("b")
    b:when(function (ok, v) print("b settled first:", ok, v) end)
    coroutine.yield("waiting")
    local ok, v = a:await()
    print("a awaited:", ok, v.n)
    local ok2, v2 = js.later("c"):await()
    print("c awaited:", ok2, v2)
    return "end"
  `, '=tokens');
  eq('start runs to the first yield', [lua.step(), lua.message()], [1, 'waiting']);
  resolvers.b.resolve('B'); await tick();
  eq('a step delivers b\'s settlement: its continuation runs on that step; a is still pending so the program yields again', [lua.step(), lua.take().stdout], [1, 'b settled first:\ttrue\tB\n']);
  eq('steps without settlements just yield (await loops on the frame)', lua.step(), 1);
  resolvers.a.resolve({ n: 1 }); await tick();
  eq('a settles: await returns on the next step, and the program runs on to its next await', [lua.step(), lua.take().stdout], [1, 'a awaited:\ttrue\t1\n']);
  resolvers.c.reject(new Error('c failed')); await tick();
  eq('a rejection is ok=false with the message; the program finishes', [lua.step(), lua.take().stdout], [0, 'c awaited:\tfalse\tc failed\n']);
  lua.run('u2 = js.unsendable()');
  await tick();
  lua.run('print(u2:await())');
  eq('a settled value that cannot cross settles as an error', lua.take().stdout, 'false\tvalue does not cross: function\n');
  lua.run('js.soon(1):when(function () error("in the continuation") end)');
  await tick();
  lua.run('print("ran")');
  eq('an error in a when continuation is reported on stderr and does not stop the next chunk', lua.take(), { stdout: 'ran\n', stderr: 'js: error in a when continuation: (embedded):1: in the continuation\n' });
  /* delivered entries are dropped on both sides: batches of tokens with
     continuations leave linear memory flat once the allocator is warm
     (a batch of 20k at once is the allocator's high-water case and
     settles over more batches; 2k is the steady state) */
  for (let i = 0; i < 3; i++) { lua.run('for i = 1, 2000 do js.soon(i):when(function () end) end'); await tick(); lua.run('collectgarbage() collectgarbage()'); }
  const flat = lua.memory.buffer.byteLength;
  for (let i = 0; i < 5; i++) { lua.run('for i = 1, 2000 do js.soon(i):when(function () end) end'); await tick(); lua.run('collectgarbage() collectgarbage()'); }
  eq('10k more tokens with continuations, delivered, leave linear memory flat', lua.memory.buffer.byteLength - flat, 0);
  lua.run('p1 = js.soon("p")');
  await tick();
  lua.run('print(p1:settled(), #js.poll())');
  eq('the run delivered it before the chunk ran; js.poll by hand then finds nothing more', lua.take().stdout, 'true\t0\n');
  lua.run('u = js.soon("q")');
  await tick();
  lua.start('local list = js.poll() print(#list, u:settled()) coroutine.yield() print(#js.poll(), list[1].ok, list[1].value, type(list[1].id))');
  lua.step();
  eq('inside the resident program the same holds: the step delivers, a hand poll after it is empty and the token is settled', lua.take().stdout, '0\ttrue\n');
}

console.log('init / run / errors');
{
  const lua = await fresh();
  eq('luaw_init returns 0', lua.init(), 0);
  eq('luaw_init again is a no-op 0', lua.init(), 0);
  eq('luaw_run ok status', lua.run('x = 1 + 1'), 0);
  eq('state persists between runs', (lua.run('print(x)'), lua.take().stdout), '2\n');
  eq('print goes to stdout, io.stderr to stderr, in order', (lua.run('io.write("a") io.stderr:write("b") io.write("c\\n")'), lua.take()), { stdout: 'ac\n', stderr: 'b' });
  eq('a runtime error returns LUA_ERRRUN (2)', lua.run('error("boom")', '=chunk'), 2);
  eq('luaw_last_error carries the stock message', lua.lastError(), 'chunk:1: boom');
  eq('a syntax error returns LUA_ERRSYNTAX (3)', lua.run('x = = 1', '=chunk'), 3);
  eq('syntax error message', lua.lastError(), "chunk:1: unexpected symbol near '='");
  eq('last error is null after a successful run', (lua.run('x = 2'), lua.lastError()), null);
  /* stderr is unbuffered, so each io.stderr:write is its own host write;
     the host's stream decoder must reassemble a character split in two */
  eq('multi-byte output survives being split across writes', (lua.run('io.stderr:write("\\xc3") io.stderr:write("\\xa9\\n")'), lua.take().stderr), 'é\n');
  eq('stdout is line-buffered like a terminal: held until the newline, after an unbuffered stderr write', (lua.run('io.write("x") io.stderr:write("y") io.write("z\\n")'), lua.take()), { stdout: 'xz\n', stderr: 'y' });
}

console.log('stdin through read');
{
  const lua = await fresh({ stdin: 'first\nsecond\n' });
  lua.init();
  lua.run('print(io.read("l")) print(io.read("n")) print(io.read("l")) print(io.read("l"))');
  eq('io.read sees the host bytes, then end of input', lua.take().stdout, 'first\nnil\nsecond\nnil\n');
}
{
  const lua = await fresh();
  lua.init();
  lua.run('print(io.read("a") == "", io.read("l"))');
  eq('no stdin: read("a") is "" and read("l") is nil', lua.take().stdout, 'true\tnil\n');
  /* the host can refill stdin between runs, and can be asked per line
     (how lua.js serves data-stdin and data-stdin="prompt") */
  lua.setStdin('again\n');
  lua.run('print(io.read("l"), io.read("l"))');
  eq('setStdin replaces what is left to read', lua.take().stdout, 'again\tnil\n');
  const lines = ['one', 'two', null];
  lua.setPrompt(() => lines.shift());
  lua.run('print(io.read("l"), io.read("l"), io.read("l"))');
  eq('setPrompt is asked for a line whenever stdin is empty, until it answers null', lua.take().stdout, 'one\ttwo\tnil\n');
  lua.setPrompt(null);
}

console.log('the clock');
{
  const t0 = 1700000000000;
  const lua = await fresh({ now: () => t0 });
  lua.init();
  lua.run('print(os.time(), os.date("!%Y-%m-%d %H:%M:%S"), os.clock())');
  eq('os.time/os.date come from now(); os.clock starts at 0', lua.take().stdout, '1700000000\t2023-11-14 22:13:20\t0.0\n');
  let t = t0;
  const lua2 = await fresh({ now: () => (t += 250) });
  lua2.init();
  lua2.run('local a = os.clock() local b = os.clock() print(b > a, b - a)');
  eq('os.clock advances with now() (relative, seconds)', lua2.take().stdout, 'true\t0.25\n');
  /* os.clock is wall time since the VM was created (luaw_init), not
     since the first clock read: host time between init and the first
     read counts, as idle time does for a process */
  let t2 = t0;
  const lua3 = await fresh({ now: () => t2 });
  lua3.init();                       /* origin: t0 */
  t2 = t0 + 2000;
  lua3.run('print(os.clock())');
  eq('os.clock counts from luaw_init', lua3.take().stdout, '2.0\n');
  let t3 = t0;
  const lua4 = await fresh({ now: () => t3 });
  t3 = t0 + 5000;                    /* host setup before main: not counted */
  lua4.main(['lua', '-e', 'print(os.clock())']);
  eq('os.clock counts from luaw_main', lua4.take().stdout, '0.0\n');
  /* a coarse host clock (Firefox rounds timers to 1 ms) must not repeat
     an instant: musl derives temp-file names from the clock alone */
  const frozen = await fresh({ now: () => t0 });
  frozen.init();
  frozen.run('local seen, n = {}, 0 for i = 1, 300 do local f = io.tmpfile() f:close() local name = os.tmpname() assert(not seen[name], name) seen[name] = true os.remove(name) n = n + 1 end print(n)');
  eq('300 os.tmpname/io.tmpfile with a frozen now(): all distinct, none failing', [frozen.lastError(), frozen.take().stdout], [null, '300\n']);
}

console.log('files');
{
  const lua = await fresh();
  lua.init();
  eq('fs.put creates a file', lua.fs.put('/lib/util.lua', 'return function(a) return a * 2 end'), 0);
  eq('fs.put with a relative path lands under /', lua.fs.put('data.txt', 'one\ntwo\n'), 0);
  eq('fs.list shows both, absolute', lua.fs.list().sort(), ['/data.txt', '/lib/util.lua']);
  eq('fs.get returns the bytes', lua.fs.getText('/data.txt'), 'one\ntwo\n');
  eq('fs.get of a missing file is null', lua.fs.get('/nope'), null);
  lua.run('package.path = "/lib/?.lua" print(require("util")(21), io.open("/data.txt"):read("l")) local f = io.open("/out.txt", "w") f:write("from lua\\n") f:close()');
  eq('Lua requires and reads what the host put', lua.take().stdout, '42\tone\n');
  eq('the host reads what Lua wrote', lua.fs.getText('/out.txt'), 'from lua\n');
  eq('fs.remove: 0 then -ENOENT (-2)', [lua.fs.remove('/data.txt'), lua.fs.remove('/data.txt')], [0, -2]);
  eq('fs.remove of a directory prefix is -EISDIR (-21)', lua.fs.remove('/lib'), -21);
  eq('fs.put over a directory prefix is -EISDIR', lua.fs.put('/lib', 'x'), -21);
  lua.run('print(io.open("/data.txt")) print(os.remove("/zz")) local n = os.tmpname() print(n:match("^/tmp/lua_") ~= nil, os.remove(n))');
  eq('errno text and numbers are Linux\'s', lua.take().stdout, 'nil\t/data.txt: No such file or directory\t2\nnil\t/zz: No such file or directory\t2\ntrue\ttrue\n');
  lua.run('print(io.open("")) print(os.remove("")) print(os.rename("", "/x"))');
  eq('the empty path is ENOENT, as on Linux (package.searchpath relies on it)', lua.take().stdout, 'nil\t: No such file or directory\t2\nnil\t: No such file or directory\t2\nnil\tNo such file or directory\t2\n');
  /* positions are 64-bit, files live in 32-bit memory: a write past what
     memory can hold fails as EFBIG and never lands at the position
     truncated to 32 bits (unbuffered, so the write is the syscall) */
  lua.run('local f = io.open("/big.txt", "w") f:setvbuf("no") f:write("head") print(f:seek("set", 2^32)) print(f:write("x")) f:close()');
  eq('a write at offset 2^32 is "File too large" (EFBIG, 27) and the file is untouched', [lua.take().stdout, lua.fs.getText('/big.txt')], ['4294967296\nnil\tFile too large\t27\n', 'head']);
}

console.log('environment and local time');
{
  const lua = await fresh({ now: () => 1710054000000 });
  lua.init();
  lua.run('print(os.getenv("HOME"), os.getenv("TZ"))');
  eq('the environment starts empty', lua.take().stdout, 'nil\tnil\n');
  eq('luaw_setenv returns 0', lua.setenv('HOME', '/home/lua'), 0);
  lua.run('print(os.getenv("HOME"))');
  eq('os.getenv sees it', lua.take().stdout, '/home/lua\n');
  lua.setenv('HOME', null);
  lua.run('print(os.getenv("HOME"))');
  eq('a null value removes it', lua.take().stdout, 'nil\n');
  lua.run('print(os.date("%H:%M %Z"))');
  eq('no TZ, no /etc/localtime: local time is UTC', lua.take().stdout, '07:00 UTC\n');
  lua.setenv('TZ', 'EST5EDT,M3.2.0,M11.1.0');
  lua.run('print(os.date("%H:%M %Z"))');
  eq('a POSIX TZ rule is honoured (DST started that morning)', lua.take().stdout, '03:00 EDT\n');
  lua.setenv('TZ', null);
  lua.fs.put('/etc/localtime', readFileSync('/usr/share/zoneinfo/Australia/Lord_Howe'));
  lua.run('print(os.date("%H:%M %Z"))');
  eq('/etc/localtime zone file (musl mmaps it) is honoured, half-hour zone', lua.take().stdout, '18:00 +11\n');
}

console.log('luaw_main (stock lua.c)');
{
  const lua = await fresh({ stdin: 'typed\n' });
  eq('lua -v exits 0', lua.main(['lua', '-v']), 0);
  eq('and prints the banner', lua.take().stdout, 'Lua 5.4.8  Copyright (C) 1994-2025 Lua.org, PUC-Rio\n');
  lua.fs.put('/s.lua', 'print(#arg, arg[0], arg[1], arg[-1], ...) print(io.read("l"))');
  eq('a script with arguments exits 0', lua.main(['lua', '/s.lua', 'x']), 0);
  eq('arg table, varargs and stdin are the command line\'s', lua.take().stdout, '1\t/s.lua\tx\tlua\tx\ntyped\n');
  eq('a missing script exits 1', lua.main(['lua', '/missing.lua']), 1);
  eq('with lua.c\'s message on stderr', lua.take().stderr, 'lua: cannot open /missing.lua: No such file or directory\n');
  lua.setenv('LUA_INIT', 'X = 99');
  eq('-e with LUA_INIT', (lua.main(['lua', '-e', 'print(X)']), lua.take().stdout), '99\n');
  eq('a failing chunk exits 1', lua.main(['lua', '-e', 'error("e")']), 1);
}

console.log('os.exit (D3)');
{
  const lua = await fresh();
  lua.init();
  const e = trapOf(() => lua.run('io.write("flushed") os.exit(3)'));
  check('os.exit traps out of luaw_run as a WebAssembly.RuntimeError', e instanceof WebAssembly.RuntimeError, e);
  eq('buffered output was flushed first', lua.take().stdout, 'flushed');
  eq('luaw_exit_code holds the status', lua.exitCode(), 3);
  eq('luaw_last_error says VM exited', lua.lastError(), 'VM exited');
  eq('every later entry refuses: run, start, step, init, main', [lua.run('x=1'), lua.start('x=1'), lua.step(), lua.init(), lua.main(['lua', '-v'])], [2, 2, 2, 2, 1]);
  const lua2 = await fresh();
  lua2.init();
  const e2 = trapOf(() => lua2.run('local ok = pcall(os.exit, 5) print("survived", ok)'));
  check('pcall cannot intercept os.exit', e2 instanceof WebAssembly.RuntimeError && lua2.exitCode() === 5 && lua2.take().stdout === '', e2);
  const lua3 = await fresh();
  lua3.init();
  trapOf(() => lua3.run('os.exit(true)'));
  eq('os.exit(true) is status 0', lua3.exitCode(), 0);
  const lua4 = await fresh();
  const e4 = trapOf(() => lua4.main(['lua', '-e', 'os.exit(7)']));
  check('os.exit inside luaw_main traps the same way', e4 instanceof WebAssembly.RuntimeError && lua4.exitCode() === 7, e4);
}

console.log('the resident program and the message channel');
{
  const lua = await fresh();
  lua.init();
  eq('luaw_start loads the program', lua.start('local first = ... print("got", first) local r = coroutine.yield("ping") print("host said", r) local r2 = coroutine.yield(42) print("then", r2) coroutine.yield({}) return "done"'), 0);
  eq('step 1: the host message is the chunk\'s argument; yield("ping") -> LUA_YIELD + message', [lua.step('hello'), lua.message(), lua.take().stdout], [1, 'ping', 'got\thello\n']);
  eq('step 2: the host message is yield\'s result; a number yields as its string', [lua.step('pong'), lua.message(), lua.take().stdout], [1, '42', 'host said\tpong\n']);
  eq('step 3: no message -> nil; a table yields no message', [lua.step(), lua.message(), lua.take().stdout], [1, null, 'then\tnil\n']);
  eq('step 4: the program finishes -> 0, return values are not messages', [lua.step(), lua.message()], [0, null]);
  eq('step 5: no program -> LUA_ERRRUN with the reason', [lua.step(), lua.lastError()], [2, 'no resident program (luaw_start first)']);
  eq('luaw_start of a bad chunk returns LUA_ERRSYNTAX', [lua.start('x = = 1', '=p'), lua.lastError()], [3, "p:1: unexpected symbol near '='"]);
  eq('a program that errors mid-flight: status 2, message, program released', (lua.start('coroutine.yield("alive") error("died")'), [lua.step(), lua.message(), lua.step(), lua.lastError(), lua.step()]), [1, 'alive', 2, '(program):1: died', 2]);
  eq('a replacement program starts clean; finishing clears the last message', (lua.start('coroutine.yield("new") return 1'), [lua.step(), lua.message(), lua.step(), lua.message()]), [1, 'new', 0, null]);
  eq('a message with embedded NUL round-trips', (lua.start('local m = ... coroutine.yield(#m .. ":" .. m)'), lua.step('a\0b'), lua.message()), '3:a\0b');
}

console.log('adversarial');
{
  const lua = await fresh();
  lua.init();
  eq('a stack overflow is a contained Lua error', (lua.run('local function f() return 1 + f() end f()', '=so'), (lua.lastError() || '').includes('stack overflow')), true);
  eq('the VM is alive afterwards', (lua.run('print("alive")'), lua.take().stdout), 'alive\n');
  eq('a C-stack-deep recursion (string.gsub into Lua) is contained too', (lua.run('local function g(s) return (s:gsub(".", g)) end g("x")', '=cs'), /stack overflow|C stack overflow/.test(lua.lastError() || '')), true);
  eq('an error object that is not a string is reported', (lua.run('error({code = 1})'), lua.lastError()), '(error object is not a string)');
  const t = performance.now();
  lua.start('local n = 0 while true do n = n + 1 coroutine.yield(n) end');
  let last = 0, status = 1;
  for (let i = 0; i < 50000 && status === 1; i++) { status = lua.step(); last = i; }
  eq('a 50k-frame pump stays alive', [status, last], [1, 49999]);
  console.log(`       (50,000 steps in ${Math.round(performance.now() - t)} ms)`);
  eq('memory stays usable: a 50 MB string', lua.run('local s = string.rep("x", 50 * 1024 * 1024) assert(#s == 52428800) s = nil collectgarbage()'), 0);
  /* a fresh VM: right after a stack overflow, stock Lua's collector paces
     itself off the 16 MB stack the overflow left, and garbage builds up
     for a cycle (native Lua does the same); that is not what this
     measures */
  const gcvm = await fresh();
  gcvm.init();
  gcvm.start('for i = 1, 200 do local t = {} for j = 1, 2000 do t[j] = { j, tostring(j), string.rep("x", j % 50) } end if i % 50 == 0 then coroutine.yield(math.floor(collectgarbage("count"))) end end return "ok"');
  const counts = [];
  for (let s = gcvm.step(); s === 1; s = gcvm.step()) counts.push(Number(gcvm.message()));
  check('GC under allocation pressure keeps memory flat across yields (KB: ' + counts.join(' ') + ')',
        counts.length === 4 && Math.max(...counts) < 2 * Math.min(...counts) && Math.max(...counts) < 2048, counts);
  /* collectgarbage("count") is Lua's accounting; the module's linear
     memory is the host's. A caught error allocates nothing in native
     Lua (longjmp) and must allocate nothing here either: the exception
     object lives in a static slot (port/luaw-eh.cpp). The leak this
     guards against was ~17 bytes per error, 3.5 MB per 200k. */
  const errvm = await fresh();
  errvm.init();
  errvm.run('for i = 1, 1000 do pcall(error, "warm") end collectgarbage() collectgarbage()');
  const before = errvm.memory.buffer.byteLength;
  errvm.run('for i = 1, 200000 do pcall(error, "x") end collectgarbage() collectgarbage()');
  eq('200k caught errors do not grow linear memory (the exception object is freed)', errvm.memory.buffer.byteLength - before, 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
