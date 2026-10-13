-- coroutines, closures, metatables, goto, integer/float loops, to-be-closed
-- variables, the garbage collector's observable behaviour (never counts)
local function show(...) print(select("#", ...), ...) end
local co = coroutine.create(function(a, b)
  show("start", a, b, coroutine.isyieldable(), coroutine.status(coroutine.running()))
  local c = coroutine.yield(a + b)
  show("resumed with", c)
  local d, e = coroutine.yield(c * 2)
  show("again", d, e)
  return "done", 1, 2
end)
show(coroutine.status(co), coroutine.isyieldable())
show(coroutine.resume(co, 1, 2))
show(coroutine.status(co))
show(coroutine.resume(co, 10))
show(coroutine.resume(co, "x", "y"))
show(coroutine.status(co), coroutine.resume(co))
local gen = coroutine.wrap(function() for i = 1, 3 do coroutine.yield(i) end end)
show(gen(), gen(), gen(), gen(), pcall(gen))
show(select(2, coroutine.running()), coroutine.close(coroutine.create(print)), pcall(coroutine.close, coroutine.running()))
local cl = coroutine.create(function() local x <close> = setmetatable({}, { __close = function(_, e) print("closing with", e) end }) coroutine.yield(1) end)
coroutine.resume(cl) show(coroutine.close(cl), coroutine.status(cl))
local dead = coroutine.create(function() error("boom") end)
show(coroutine.resume(dead)) show(coroutine.close(dead), coroutine.status(dead))
show(pcall(coroutine.yield))
show(coroutine.resume(coroutine.create(function() return pcall(coroutine.yield, "through pcall") end)))
local wrapped = coroutine.wrap(function() local ok, e = pcall(function() coroutine.yield("in pcall") error("after") end) return ok, e end)
show(wrapped()) show(wrapped())
-- closures and upvalues
local function counter() local n = 0 return function() n = n + 1 return n end end
local c1, c2 = counter(), counter() show(c1(), c1(), c2(), c1())
local fns = {} for i = 1, 3 do fns[i] = function() return i end end show(fns[1](), fns[2](), fns[3]())
local j = 0 local fs2 = {} while j < 3 do j = j + 1 local k = j fs2[j] = function() return k, j end end show(fs2[1](), fs2[3]())
-- metatables
local mt = {}
mt.__add = function(a, b) return "add" end mt.__eq = function() return true end mt.__lt = function() return true end mt.__le = function() return false end
mt.__call = function(self, x) return "called " .. tostring(x) end mt.__len = function() return 42 end mt.__concat = function(a, b) return "cat" end
mt.__unm = function() return "neg" end mt.__idiv = function() return "idiv" end mt.__band = function() return "band" end mt.__shl = function() return "shl" end mt.__bnot = function() return "bnot" end
mt.__index = function(t, k) return "idx:" .. tostring(k) end mt.__newindex = function(t, k, v) rawset(t, k, v .. "!") end mt.__tostring = function() return "OBJ" end mt.__name = "MyType"
local a, b = setmetatable({}, mt), setmetatable({}, mt)
show(a + 1, 1 + a, a == b, a ~= b, a < b, a <= b, a > b, a(5), #a, a .. "x", "x" .. a, -a, a // 1, a & 1, a << 1, ~a, a.foo, a[1], tostring(a))
a.bar = "v" show(rawget(a, "bar"), a.bar, getmetatable(a) == mt, getmetatable("x").__index == string)
show(pcall(function() return a % 1 end), pcall(function() return a < 1 end), pcall(function() return 1 < a end))
mt.__metatable = "locked" show(getmetatable(a), pcall(setmetatable, a, {}))
local weak = setmetatable({}, { __mode = "k" }) weak[{}] = 1 weak[a] = 2 collectgarbage() local n = 0 for _ in pairs(weak) do n = n + 1 end show(n)
local wv = setmetatable({ {}, 1, "s" }, { __mode = "v" }) collectgarbage() show(#wv, wv[1], wv[2], wv[3])
local order = {} for i = 1, 3 do setmetatable({}, { __gc = function() order[#order + 1] = i end }) end collectgarbage() collectgarbage() show(table.concat(order, " "))
show(collectgarbage("isrunning"), collectgarbage("step", 0), collectgarbage("incremental"), collectgarbage("generational"), collectgarbage("incremental"), type(collectgarbage("count")), collectgarbage("stop"), collectgarbage("isrunning"), collectgarbage("restart"), collectgarbage("isrunning"))
show(pcall(collectgarbage, "bogus"), collectgarbage("setpause", 100), collectgarbage("setpause", 200), collectgarbage("setstepmul", 100), collectgarbage("setstepmul", 100))
-- control flow
local s = {} for i = 10, 1, -3 do s[#s + 1] = i end for i = 1.0, 2.0, 0.5 do s[#s + 1] = i end for i = math.maxinteger - 1, math.maxinteger do s[#s + 1] = "m" end for i = 1, 0 do s[#s + 1] = "never" end show(table.concat(s, " "))
for i = 1, 3 do for j = 1, 3 do if j == 2 then goto continue end io.write(i, j, " ") ::continue:: end end print()
do local i = 1 ::top:: if i <= 3 then io.write(i, " ") i = i + 1 goto top end print() end
show(1 and 2, nil and 2, false or "x", nil or false, not 0, not nil, 1 == 1.0, "1" == 1, 0.1 + 0.2 == 0.3, math.type(2^2), 7 // 2 * 2 + 7 % 2)
show((function(...) return select("#", ...), ... end)(nil, nil), (function(...) local t = { ... } return #t, t[3] end)(1, nil, 3))
local tbc = {} do local x <close> = setmetatable({}, { __close = function() tbc[#tbc + 1] = "x" end }) local y <close> = setmetatable({}, { __close = function() tbc[#tbc + 1] = "y" end }) local z <close> = nil end show(table.concat(tbc))
show(pcall(function() local c <const> = 1 return c end), load("local c <const> = 1 c = 2"))
show(string.format("%d", 3), 3 | 0, math.type(3 // 1), math.type(3 / 1), 2^53 // 1, (2^53 + 1) // 1 == 2^53 // 1, 1e308 // 1e-308)
local big = {} for i = 1, 100000 do big[i] = i end show(#big, big[50000], select("#", table.unpack(big, 1, 200)))
local str = {} for i = 1, 10000 do str[#str + 1] = tostring(i) end show(#table.concat(str), #str)
show(debug.getinfo(1, "l").currentline, debug.getinfo(print).what, debug.getinfo(show, "S").short_src, debug.getinfo(show, "S").linedefined, (debug.getinfo(1, "S").source))
show(xpcall(function() return "ok", 2 end, print), xpcall(error, function(e) return "handled " .. tostring(e) end, "E"))
show(string.dump(function() return 1 end):sub(1, 4) == "\27Lua", load(string.dump(function(a) return a * 2 end))(21), pcall(load(string.dump(show)), 1))
show(#string.dump(load("return 1")), #string.dump(load("return 1"), true) < #string.dump(load("return 1")))
show(_VERSION, type(_G), _G._G == _G, type(_ENV), rawequal(_ENV, _G), package.config:sub(1, 1), type(package.path), package.loaded.string == string, type(package.searchers), #package.searchers)
show(require("string") == string, package.loaded["no"], pcall(require, "no"))
