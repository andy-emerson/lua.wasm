// loader.js -- the part of lua.js that makes <script type="text/lua"> work
// in HTML (D8 in doc/history/browser-native-2026-10-13.md). Not a module:
// scripts/build-lua-js.mjs wraps this, host.mjs and lua.wasm itself
// (LUA_WASM_INLINE, base64) into the one classic script lua.js, so
// `createLua` and the module's bytes are in scope here and nothing is
// fetched to start.
//
// What a page author gets with no JavaScript written (the D8 rows):
//   1,2  a tag's print output appears on the page where the tag sits, an
//        error there in red and in the console; data-output="#id" sends
//        output to that element, data-output="console" to the console only
//   5,6  one Lua state for the page; tags run after the page has loaded,
//        in document order
//   7    data-stdin="text" is what io.read sees, then end of input; no
//        attribute: end of input; data-stdin="prompt" asks via window.prompt
//   9    os.exit ends the VM: the status shows, later tags refuse
//   10   every tag runs as the resident coroutine: a top-level
//        coroutine.yield() returns to the page and resumes next animation
//        frame; a tag that never yields runs to completion
// The Lua global is the JavaScript surface (row 11): Lua.ready resolves
// once the page's tags have run, and every other member throws before
// that (doc/lua-js.md lists them).

(function () {
  'use strict';

  const LUA_YIELD = 1;

  // --- lazy require (D8 row 4) ----------------------------------------------
  // A page cannot fetch synchronously, so a module that is not in the
  // filesystem is fetched by yielding to the page: the script (a coroutine)
  // yields FETCH..name, the page fetches name.lua beside itself into the
  // filesystem and resumes with "ok" or an error. The search and the load
  // are done in Lua rather than through the C require, whose lua_call
  // boundary would stop a module's own require from yielding. What a
  // program sees is require's contract: package.preload, package.path,
  // one load per name, package.loaded, the loader's two results, and the
  // stock error texts (asserted against native lua by the files page).
  const FETCH = '\0lua.js:fetch:';
  const REQUIRE_SHIM = `
    local loaded, preload, searchpath = package.loaded, package.preload, package.searchpath
    local function load_from(name, path)
      local f, err = loadfile(path)
      -- level 0: stock raises this from inside the C searcher, so it carries no position
      if not f then error("error loading module '" .. name .. "' from file '" .. path .. "':\\n\\t" .. err, 0) end
      local r = f(name, path)
      if r ~= nil then loaded[name] = r end
      if loaded[name] == nil then loaded[name] = true end
      return loaded[name], path
    end
    -- the "no file" lines stock require lists after the preload field,
    -- each searcher's list behind its own newline and tab: package.path,
    -- then package.cpath, then (for a dotted name) the all-in-one
    -- loader's search of cpath for the root name
    local function notfound(name)
      local _, err = searchpath(name, package.path)
      local _, cerr = searchpath(name, package.cpath)
      local msg = "module '" .. name .. "' not found:\\n\\tno field package.preload['" .. name .. "']\\n\\t" .. err .. "\\n\\t" .. cerr
      local root = name:match("^([^.]+)%.")
      if root then msg = msg .. "\\n\\t" .. select(2, searchpath(root, package.cpath)) end
      return msg
    end
    function require(...)
      local name = ...
      local t = type(name)
      if t == "number" then name = tostring(name)
      elseif t ~= "string" then
        error("bad argument #1 to 'require' (string expected, got " .. (select("#", ...) == 0 and "no value" or t) .. ")", 2)
      end
      local v = loaded[name]
      if v then return v end
      local pre = preload[name]
      if pre then
        local r = pre(name, ":preload:")
        if r ~= nil then loaded[name] = r end
        if loaded[name] == nil then loaded[name] = true end
        return loaded[name], ":preload:"
      end
      local path, err = searchpath(name, package.path)
      if path then return load_from(name, path) end
      local msg = notfound(name)
      if not coroutine.isyieldable() then
        error(msg .. "\\n\\t(lua.js: cannot fetch from here; list it in data-files)", 2)
      end
      local answer = coroutine.yield("\\0lua.js:fetch:" .. name)
      if answer ~= "ok" then error(msg .. "\\n\\t(lua.js: " .. tostring(answer) .. ")", 2) end
      path = searchpath(name, package.path)
      if not path then error(msg, 2) end
      return load_from(name, path)
    end`;

  const state = {
    lua: null,
    booted: false,      // the VM exists and the page's tags have run (Lua.ready)
    exited: false,      // os.exit happened (or the VM trapped): every later entry refuses
    why: null,          // the refusal's reason once exited
    exitCode: null,
    sink: null,         // where the running tag's output goes
    tags: 0,
  };

  // --- output ---------------------------------------------------------------
  function makeSink(tag) {
    const where = tag.dataset.output;
    if (where === 'console') return { print: t => console.log(t.replace(/\n$/, '')), error: t => console.error(t) };
    let el = null;                         // the output element, made on first use
    if (where) {
      el = document.querySelector(where);
      if (!el) { el = place(tag, 'lua-error'); el.textContent = `lua.js: data-output ${where}: no such element\n`; }
    }
    const output = () => el ?? (el = place(tag, 'lua-output'));
    return {
      print: t => { output().appendChild(document.createTextNode(t)); },
      error: t => {
        const e = document.createElement('pre');
        e.className = 'lua-error';
        e.textContent = t;
        if (el) el.after(e); else place(tag, null, e);
        console.error(t);
      },
    };
  }

  // put an element (a new <pre> of the given class, or the one given)
  // right after the tag, or at the end of the body when the tag is in <head>
  function place(tag, cls, el = null) {
    if (!el) { el = document.createElement('pre'); el.className = cls; }
    if (tag.parentNode === document.head || !tag.parentNode) document.body.appendChild(el);
    else tag.after(el);
    return el;
  }

  // --- stdin ------------------------------------------------------------------
  function stdinFor(tag) {
    const v = tag.dataset.stdin;
    if (v === undefined) return '';
    if (v === 'prompt') return null;          // ask the visitor per read
    return v;
  }

  // --- running one tag ---------------------------------------------------------
  function chunkName(tag) {
    state.tags++;
    return '=' + (tag.id ? tag.id : `(lua script ${state.tags})`);
  }

  // --- local time (D5, D8 row 14) --------------------------------------------
  // musl's local time is /etc/localtime, a TZif file. The page writes one
  // for the visitor's zone from the browser's own rules: Intl gives the
  // UTC offset and abbreviation at any instant; transitions over the
  // current year +-1 are found by a daily scan refined to the second;
  // standard time is the smaller offset of the year (DST moves clocks
  // forward, in either hemisphere); and a POSIX rule in the footer (what
  // musl applies beyond the table) is derived when both years agree on
  // the month / week / weekday / time of each change.
  function zoneFile(tz) {
    const offsetFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    const abbrFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    const part = (fmt, t) => fmt.formatToParts(new Date(t * 1000)).find(p => p.type === 'timeZoneName').value;
    const offsetAt = (t) => {            // seconds east of UTC
      const m = /GMT([+-])(\d\d):(\d\d)/.exec(part(offsetFmt, t));
      return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60) : 0;
    };
    const abbrAt = (t) => {
      const a = part(abbrFmt, t);
      if (/^[A-Za-z]{3,6}$/.test(a)) return a;
      const o = offsetAt(t), s = o < 0 ? '-' : '+', h = Math.floor(Math.abs(o) / 3600), mi = Math.floor(Math.abs(o) % 3600 / 60);
      return s + String(h).padStart(2, '0') + String(mi).padStart(2, '0');
    };
    const year = new Date().getUTCFullYear();
    const start = Date.UTC(year - 1, 0, 1) / 1000, end = Date.UTC(year + 2, 0, 1) / 1000;
    // transitions: instants where the offset changes, to the second. A
    // zone changes at most once a month, so probe month boundaries (36
    // Intl calls) and binary-search inside a month that changed; a daily
    // scan would cost ~1,100 calls, most of the page's start-up time.
    const trans = [];
    let prev = offsetAt(start);
    for (let m = 0; m < 36; m++) {
      const t = Date.UTC(year - 1, m, 1) / 1000, next = Math.min(Date.UTC(year - 1, m + 1, 1) / 1000, end);
      if (offsetAt(next) === prev) continue;
      let lo = t, hi = next;
      while (hi - lo > 1) { const mid = lo + Math.floor((hi - lo) / 2); if (offsetAt(mid) === prev) lo = mid; else hi = mid; }
      prev = offsetAt(hi);
      trans.push(hi);
    }
    // types: (offset, abbreviation) pairs, isdst by the smaller-offset rule
    const offsets = [offsetAt(start), ...trans.map(offsetAt)];
    const std = Math.min(...offsets);
    const types = [], typeOf = (t) => {
      const o = offsetAt(t), a = abbrAt(t);
      let i = types.findIndex(x => x.off === o && x.abbr === a);
      if (i < 0) { i = types.length; types.push({ off: o, abbr: a, dst: o !== std }); }
      return i;
    };
    typeOf(start);                       // the type before the first transition comes first
    const transTypes = trans.map(typeOf);
    // the POSIX footer rule, when the two full years agree
    const footer = posixRule(types, trans, transTypes, year, offsetAt);
    return encodeTzif(types, trans, transTypes, footer);
  }

  // "EST5EDT,M3.2.0,M11.1.0"-style rule from this year's and next year's
  // transitions, or just the standard time if there is no DST or the years
  // disagree (musl then keeps the last table entry beyond the window)
  function posixRule(types, trans, transTypes, year, offsetAt) {
    const q = (abbr) => /^[A-Za-z]+$/.test(abbr) ? abbr : '<' + abbr + '>';
    const off = (sec) => {                 // POSIX offsets are west-positive
      const s = sec > 0 ? '-' : '', a = Math.abs(sec);
      const h = Math.floor(a / 3600), m = Math.floor(a % 3600 / 60);
      return s + h + (m ? ':' + String(m).padStart(2, '0') : '');
    };
    const stdType = types.find(t => !t.dst), dstType = types.find(t => t.dst);
    if (!dstType) return q(stdType.abbr) + off(stdType.off);
    const ruleOf = (y) => {
      const inYear = trans.map((t, i) => [t, transTypes[i]]).filter(([t]) => new Date(t * 1000).getUTCFullYear() === y);
      if (inYear.length !== 2) return null;
      const m = inYear.map(([t, ti]) => {
        const before = offsetAt(t - 1);     // wall time before the change
        const d = new Date((t + before) * 1000);
        const dom = d.getUTCDate(), last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        const week = dom + 7 > last ? 5 : Math.ceil(dom / 7);
        const hh = d.getUTCHours(), mm = d.getUTCMinutes();
        return { to: types[ti].dst, rule: `M${d.getUTCMonth() + 1}.${week}.${d.getUTCDay()}` + (hh === 2 && mm === 0 ? '' : `/${hh}${mm ? ':' + String(mm).padStart(2, '0') : ''}`) };
      });
      const s = m.find(x => x.to), e = m.find(x => !x.to);
      return s && e ? `${s.rule},${e.rule}` : null;
    };
    const r1 = ruleOf(year), r2 = ruleOf(year + 1);
    if (!r1 || r1 !== r2) return q(stdType.abbr) + off(stdType.off);
    return q(stdType.abbr) + off(stdType.off) + q(dstType.abbr) + (dstType.off - stdType.off === 3600 ? '' : off(dstType.off)) + ',' + r1;
  }

  // a TZif version-2 file: the 32-bit block (times clamped) then the 64-bit
  // block, each with the transitions, the types, the abbreviations; then the
  // footer rule
  function encodeTzif(types, trans, transTypes, footer) {
    const abbrs = []; let chars = '';
    for (const t of types) { abbrs.push(chars.length); chars += t.abbr + '\0'; }
    const enc = new TextEncoder();
    const charBytes = enc.encode(chars), footBytes = enc.encode('\n' + footer + '\n');
    const block = (wide) => {
      const tsz = wide ? 8 : 4;
      const n = trans.length, size = 44 + n * tsz + n + types.length * 6 + charBytes.length;
      const b = new Uint8Array(size), dv = new DataView(b.buffer);
      b.set(enc.encode('TZif2'), 0);
      let p = 20;
      for (const c of [0, 0, 0, n, types.length, charBytes.length]) { dv.setUint32(p, c); p += 4; }
      for (const t of trans) {
        if (wide) { dv.setBigInt64(p, BigInt(t)); p += 8; }
        else { dv.setInt32(p, Math.max(-0x80000000, Math.min(0x7fffffff, t))); p += 4; }
      }
      for (const i of transTypes) b[p++] = i;
      for (let i = 0; i < types.length; i++) { dv.setInt32(p, types[i].off); b[p + 4] = types[i].dst ? 1 : 0; b[p + 5] = abbrs[i]; p += 6; }
      b.set(charBytes, p);
      return b;
    };
    const a = block(false), c = block(true);
    const out = new Uint8Array(a.length + c.length + footBytes.length);
    out.set(a, 0); out.set(c, a.length); out.set(footBytes, a.length + c.length);
    return out;
  }

  // --- files (D8 rows 3, 4) ------------------------------------------------------
  // fetch a URL relative to the page; returns bytes, or throws with the status
  async function fetchBytes(url) {
    const r = await fetch(new URL(url, document.baseURI));
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  // data-files="a.lua data/x.json": each fetched beside the page into the
  // same path under /, before the tag runs
  async function putFiles(tag, sink) {
    const list = (tag.dataset.files || '').split(/\s+/).filter(Boolean);
    for (const f of list) {
      try {
        const bytes = await fetchBytes(f);
        const r = state.lua.fs.put('/' + f.replace(/^\.?\//, ''), bytes);
        if (r !== 0) throw new Error(`${f}: cannot put into the filesystem (${r})`);
      } catch (e) { sink.error(`lua.js: data-files: ${e.message}\n`); }
    }
  }

  // the module name a script asked for, fetched as name/with/slashes.lua
  // beside the page and put where package.path's ./?.lua finds it
  async function fetchModule(name) {
    const rel = name.replace(/\./g, '/') + '.lua';
    const bytes = await fetchBytes(rel);
    const r = state.lua.fs.put('/' + rel, bytes);
    if (r !== 0) throw new Error(`${rel}: cannot put into the filesystem (${r})`);
  }

  async function runTag(tag) {
    const lua = state.lua;
    const sink = makeSink(tag);
    state.sink = sink;
    if (state.exited) {
      sink.error(`${state.why}; this script did not run\n`);
      return;
    }
    const stdin = stdinFor(tag);
    lua.setStdin(stdin === null ? '' : stdin);
    lua.setPrompt(stdin === null ? () => window.prompt('Lua is reading from stdin:') : null);
    await putFiles(tag, sink);
    let name, source;
    if (tag.src) {
      name = '@' + tag.src.split('/').pop();
      try { source = new TextDecoder().decode(await fetchBytes(tag.src)); }
      catch (e) { sink.error(`lua.js: src: ${e.message}\n`); return; }
    } else {
      name = chunkName(tag);
      source = tag.textContent;
    }
    let s;
    try { s = lua.start(source, name); }
    catch (e) { trapped(e, sink); return; }
    if (s !== 0) { sink.error(lua.lastError() + '\n'); return; }
    let answer = null;                     // what the next resume hands to yield
    for (;;) {
      try { s = lua.step(answer); }
      catch (e) { trapped(e, sink); return; }
      answer = null;
      if (s !== LUA_YIELD) break;
      const msg = lua.message();
      if (msg !== null && msg.startsWith(FETCH)) {
        try { await fetchModule(msg.slice(FETCH.length)); answer = 'ok'; }
        catch (e) { answer = e.message; }
      } else {
        await new Promise(requestAnimationFrame);
      }
    }
    if (s !== 0) sink.error(lua.lastError() + '\n');
  }

  // os.exit (and abort) leave the VM as a trap, which the module records
  // (luaw_last_error reads "VM exited" from then on); any other trap is
  // a bug, named as such. Either way the VM is finished: record and
  // refuse from now on.
  function ended(e) {
    const lua = state.lua;
    state.exited = true;
    if (lua.lastError() === 'VM exited') {
      state.exitCode = lua.exitCode();
      state.why = `VM exited (status ${state.exitCode})`;
      return true;
    }
    state.exitCode = null;
    state.why = `VM trapped (${e && e.message ? e.message : e})`;
    return false;
  }
  function trapped(e, sink) {
    if (e instanceof WebAssembly.RuntimeError) {
      if (ended(e)) sink.print(`[exit ${state.exitCode}]\n`);
      else sink.error(`lua.js: ${state.why}\n`);
      return;
    }
    sink.error(`lua.js: ${e && e.message ? e.message : e}\n`);
  }

  // --- boot ----------------------------------------------------------------------
  async function boot() {
    // compile through the streaming entry point even from inline bytes:
    // the engine's streaming pipeline compiles in parallel as it reads
    const bytes = LUA_WASM_INLINE();
    const module = typeof WebAssembly.compileStreaming === 'function'
      ? await WebAssembly.compileStreaming(new Response(bytes, { headers: { 'content-type': 'application/wasm' } }))
      : await WebAssembly.compile(bytes);
    const lua = await createLua(module, {
      stdout: t => state.sink && state.sink.print(t),
      stderr: t => state.sink && state.sink.error(t),
    });
    state.lua = lua;
    const r = lua.init();
    if (r !== 0) throw new Error(`luaw_init failed: ${r}`);
    if (lua.run(REQUIRE_SHIM, '=lua.js') !== 0) throw new Error('require shim: ' + lua.lastError());
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) lua.fs.put('/etc/localtime', zoneFile(tz));
    } catch (e) { console.warn('lua.js: local time stays UTC: ' + (e && e.message ? e.message : e)); }
    const tags = Array.from(document.querySelectorAll('script[type="text/lua"]'));
    for (const tag of tags) await runTag(tag);
    state.sink = jsSink;               // from here, output belongs to JavaScript calls
    state.booted = true;
  }

  const ready = new Promise((resolve, reject) => {
    const go = () => boot().then(resolve, (e) => { console.error('lua.js: ' + (e && e.message ? e.message : e)); reject(e); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  });

  // --- the JavaScript surface (D8 row 11): the module's own contract ----------
  // A call from JavaScript is started from JavaScript, so its terminal is
  // the console (row 1) unless Lua.on('print' | 'error', fn) redirects it.
  const consoleSink = {
    print: t => console.log(t.replace(/\n$/, '')),
    error: t => console.error(t.replace(/\n$/, '')),
  };
  const jsSink = { print: consoleSink.print, error: consoleSink.error };
  state.sink = jsSink;

  // ready means the VM exists *and* the page's tags have run: a call that
  // slipped in between would print into the running tag's output
  const vm = () => {
    if (!state.booted) throw new Error('lua.js: not ready yet (await Lua.ready)');
    if (state.exited) throw new Error(state.why);
    return state.lua;
  };
  const guarded = (f) => {
    const lua = vm();
    try { return f(lua); }
    catch (e) {
      if (e instanceof WebAssembly.RuntimeError) { ended(e); throw new Error(state.why); }
      throw e;
    }
  };
  const fail = (lua) => { throw new Error(lua.lastError()); };

  window.Lua = {
    /* resolves (with Lua) once lua.wasm is loaded, the VM exists and the page's tags have run */
    ready: ready.then(() => window.Lua),
    /* run a chunk to completion; throws with the Lua message on error */
    run: (source, name = '=(JavaScript)') => guarded(lua => { if (lua.run(source, name) !== 0) fail(lua); }),
    /* the resident program: start it, then step it (once per frame); step
       resolves 1 while it is alive and yielded, 0 when it finished, and
       serves any lazy require along the way; msg reaches its yield */
    start: (source, name = '=(program)') => guarded(lua => { if (lua.start(source, name) !== 0) fail(lua); }),
    step: async (msg = null) => {
      let answer = msg;
      for (;;) {
        const s = guarded(lua => lua.step(answer));
        if (s !== LUA_YIELD) { if (s !== 0) fail(state.lua); return 0; }
        const m = state.lua.message();
        if (m === null || !m.startsWith(FETCH)) return 1;
        try { await fetchModule(m.slice(FETCH.length)); answer = 'ok'; }
        catch (e) { answer = e.message; }
      }
    },
    /* what the program yielded on the last step, or null */
    get message() { return state.lua ? state.lua.message() : null; },
    /* the in-memory filesystem; put takes a string or bytes, get returns bytes */
    files: {
      put: (path, data) => guarded(lua => { const r = lua.fs.put(path, data); if (r !== 0) throw new Error(`put ${path}: ${r}`); }),
      get: (path) => guarded(lua => lua.fs.get(path)),
      getText: (path) => guarded(lua => lua.fs.getText(path)),
      list: () => guarded(lua => lua.fs.list()),
      remove: (path) => guarded(lua => lua.fs.remove(path)),
      mkdir: (path) => guarded(lua => lua.fs.mkdir(path)),
    },
    /* set (or, with null, remove) an environment variable */
    env: (name, value) => guarded(lua => lua.setenv(name, value)),
    /* where output and errors of JavaScript calls go; null restores the console */
    on: (event, fn) => {
      if (event !== 'print' && event !== 'error') throw new Error(`lua.js: unknown event ${event}`);
      jsSink[event] = fn ?? consoleSink[event];
    },
    get exitCode() { return state.exitCode; },
  };
})();
