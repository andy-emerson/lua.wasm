// loader.js -- the part of lua.js that makes <script type="text/lua"> work
// in HTML (D8 in doc/history/browser-native-2026-10-13.md). Not a module:
// scripts/build-lua-js.mjs wraps this and host.mjs into the one classic
// script lua.js, so `createLua` is in scope here.
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
//   8    lua.wasm is looked up beside lua.js (the inline build needs no
//        lookup); data-wasm on the lua.js tag overrides
// The Lua global is the JavaScript surface (row 11); this cycle exposes
// Lua.ready (resolves once the page's tags have run) and Lua.exitCode.

(function () {
  'use strict';

  const loaderTag = document.currentScript;
  const wasmUrl = (loaderTag && loaderTag.dataset.wasm) ||
    (loaderTag && loaderTag.src ? new URL('lua.wasm', loaderTag.src).href : 'lua.wasm');

  const LUA_YIELD = 1;

  // --- lazy require (D8 row 4) ----------------------------------------------
  // A page cannot fetch synchronously, so a module that is not in the
  // filesystem is fetched by yielding to the page: the script (a coroutine)
  // yields FETCH..name, the page fetches name.lua beside itself into the
  // filesystem and resumes with "ok" or an error. The search and the load
  // are done in Lua rather than through the C require, whose lua_call
  // boundary would stop a module's own require from yielding. What a
  // program sees is require's contract: package.preload, package.path,
  // one load per name, package.loaded, the loader's two results.
  const FETCH = '\0lua.js:fetch:';
  const REQUIRE_SHIM = `
    local loaded, preload, searchpath = package.loaded, package.preload, package.searchpath
    local function load_from(name, path)
      local f, err = loadfile(path)
      if not f then error("error loading module '" .. name .. "' from file '" .. path .. "':\\n\\t" .. err, 3) end
      local r = f(name, path)
      if r ~= nil then loaded[name] = r end
      if loaded[name] == nil then loaded[name] = true end
      return loaded[name], path
    end
    function require(name)
      name = tostring(name)
      local v = loaded[name]
      if v ~= nil then return v end
      local pre = preload[name]
      if pre then
        local r = pre(name, ":preload:")
        if r ~= nil then loaded[name] = r end
        if loaded[name] == nil then loaded[name] = true end
        return loaded[name], ":preload:"
      end
      local path, err = searchpath(name, package.path)
      if path then return load_from(name, path) end
      local msg = "module '" .. name .. "' not found:\\n\\tno field package.preload['" .. name .. "']" .. err
      if not coroutine.isyieldable() then
        error(msg .. "\\n\\t(lua.js: cannot fetch from here; list it in data-files)", 2)
      end
      local answer = coroutine.yield("\\0lua.js:fetch:" .. name)
      if answer ~= "ok" then error(msg .. "\\n\\t(lua.js: " .. tostring(answer) .. ")", 2) end
      path, err = searchpath(name, package.path)
      if not path then error(msg .. err, 2) end
      return load_from(name, path)
    end`;

  const state = {
    lua: null,
    exited: false,      // os.exit happened: every later entry refuses
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
      sink.error(`VM exited (status ${state.exitCode}); this script did not run\n`);
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

  // os.exit (and abort) leave the VM as a trap; record and refuse from now on
  function trapped(e, sink) {
    if (e instanceof WebAssembly.RuntimeError) {
      state.exited = true;
      state.exitCode = state.lua.exitCode();
      sink.print(`[exit ${state.exitCode}]\n`);
      return;
    }
    sink.error(`lua.js: ${e && e.message ? e.message : e}\n`);
  }

  // --- boot ----------------------------------------------------------------------
  async function boot() {
    const bytes = typeof LUA_WASM_INLINE !== 'undefined' ? LUA_WASM_INLINE()
      : await fetch(wasmUrl).then(r => { if (!r.ok) throw new Error(`fetch ${wasmUrl}: ${r.status}`); return r.arrayBuffer(); });
    const lua = await createLua(bytes, {
      stdout: t => state.sink && state.sink.print(t),
      stderr: t => state.sink && state.sink.error(t),
    });
    state.lua = lua;
    const r = lua.init();
    if (r !== 0) throw new Error(`luaw_init failed: ${r}`);
    if (lua.run(REQUIRE_SHIM, '=lua.js') !== 0) throw new Error('require shim: ' + lua.lastError());
    const tags = Array.from(document.querySelectorAll('script[type="text/lua"]'));
    for (const tag of tags) await runTag(tag);
  }

  const ready = new Promise((resolve, reject) => {
    const go = () => boot().then(resolve, (e) => { console.error('lua.js: ' + (e && e.message ? e.message : e)); reject(e); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
    else go();
  });

  window.Lua = {
    ready,
    get exitCode() { return state.exitCode; },
  };
})();
