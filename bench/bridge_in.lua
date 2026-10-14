-- the bridge, the other way: the page hands Lua 50,000 ten-byte strings, one
-- call (or one step, for lua.wasm's resident program) each; Lua tallies them.
-- The page drives this one: it defines handle, calls it 50,000 times its own
-- way, then runs finish.
total = 0
function handle(m) total = total + #m end
function finish() print(total) end
