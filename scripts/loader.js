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

  function runTag(tag) {
    const lua = state.lua;
    const sink = makeSink(tag);
    state.sink = sink;
    if (state.exited) {
      sink.error(`VM exited (status ${state.exitCode}); this script did not run\n`);
      return Promise.resolve();
    }
    const stdin = stdinFor(tag);
    lua.setStdin(stdin === null ? '' : stdin);
    lua.setPrompt(stdin === null ? () => window.prompt('Lua is reading from stdin:') : null);
    const name = chunkName(tag);
    const source = tag.textContent;
    return new Promise((done) => {
      let status;
      try {
        status = lua.start(source, name);
        if (status !== 0) { sink.error(lua.lastError() + '\n'); done(); return; }
      } catch (e) { trapped(e, sink); done(); return; }
      const step = () => {
        let s;
        try { s = lua.step(); }
        catch (e) { trapped(e, sink); done(); return; }
        if (s === LUA_YIELD) { requestAnimationFrame(step); return; }
        if (s !== 0) sink.error(lua.lastError() + '\n');
        done();
      };
      step();
    });
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
