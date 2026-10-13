-- the math library, printed at full precision: musl's libm on both sides,
-- so every bit must agree
local xs = { 0, -0.0, 1e-300, 1e-10, 0.1, 0.5, 1, 1.5, 2, math.pi / 4, math.pi / 2, math.pi, 3, 10, 100, 1e5, 1e10, 1e100, 1e300,
  -1e-10, -0.5, -1, -2, -math.pi, -10, -1e100, 0.9999999999999999, 1.0000000000000002, 2^52, 2^53, 2^63, 1/0, -1/0, 0/0 }
local fs = { "sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "sqrt", "floor", "ceil", "abs" }
for _, name in ipairs(fs) do
  local f = math[name]
  for _, x in ipairs(xs) do
    io.write(name, "(", string.format("%.17g", x), ") = ", string.format("%.17g", f(x)), "\n")
  end
end
for _, x in ipairs(xs) do
  io.write(string.format("log2(%.17g)=%.17g log10=%.17g log3=%.17g atan2(x,2)=%.17g atan2(2,x)=%.17g\n",
    x, math.log(x, 2), math.log(x, 10), math.log(x, 3), math.atan(x, 2), math.atan(2, x)))
end
local pairs_ = { {2, 0.5}, {2, 10}, {2, -2}, {-2, 3}, {-2, 0.5}, {10, 308}, {10, 309}, {10, -324}, {0, 0}, {0, -1}, {1e10, 1e10}, {-8, 1/3}, {0.5, 1e300}, {1.0000001, 1e8}, {math.pi, math.pi} }
for _, p in ipairs(pairs_) do
  local ok, fm = pcall(math.fmod, p[1], p[2])
  local ok2, md = pcall(function() return p[1] % p[2] end)
  io.write(string.format("pow(%.17g, %.17g) = %.17g  fmod = %s  mod = %s\n", p[1], p[2], p[1] ^ p[2], ok and string.format("%.17g", fm) or fm, ok2 and string.format("%.17g", md) or md))
end
for _, x in ipairs({ 0.1, 1/3, 2/3, 1e-7, 123456.789, 2^-1074, 2^1023 }) do
  local m, e = math.frexp and math.frexp(x) or nil, nil
  io.write(string.format("%.17g: ldexp-ish %.17g %.17g; modf %.17g %.17g\n", x, x * 2^10, x / 2^10, math.modf(x)))
end
print(math.modf(3.7), math.modf(-3.7), math.modf(1/0), math.modf(0/0))
print(math.huge // 1, -math.huge // 1, math.huge % 2, pcall(math.random, 0), pcall(math.random, 3, 2))
math.randomseed(42)
local r = {} for i = 1, 5 do r[i] = math.random(1000) end print(table.concat(r, " "))
math.randomseed(42, 7)
r = {} for i = 1, 5 do r[i] = string.format("%.17g", math.random()) end print(table.concat(r, " "))
print(math.random(0), math.random(math.mininteger, math.maxinteger) ~= nil)
print(string.format("%.17g %.17g %.17g", math.exp(1), math.log(math.exp(1)), math.sqrt(2) * math.sqrt(2)))
print(math.floor(1e308 * 10), math.ceil(-1e308 * 10), math.floor(2^63), math.ceil(-2^63 - 1025), pcall(math.floor, "x"))
print(3 % math.huge, -3 % math.huge, 3 % -math.huge, math.fmod(3, math.huge), math.fmod(1, 0/0), 1e308 * 10 == math.huge)
