-- the bridge, scalars: 200,000 calls out to a registered add(a, b)
local add = bridge.add
local s = 0
for i = 1, 200000 do s = add(s, i) end
print(string.format("%.0f", s))
