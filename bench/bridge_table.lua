-- the bridge, a table crossing: 2,000 tables of 100 numbers out, their sums back
local sum = bridge.sum
local total = 0
for i = 1, 2000 do
  local t = {}
  for j = 1, 100 do t[j] = i + j end
  total = total + sum(t, 100)
end
print(string.format("%.0f", total))
