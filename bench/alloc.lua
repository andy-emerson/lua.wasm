-- allocation and collection: short-lived tables and strings (the checksum
-- stays below 2^31: fengari's integers are 32-bit)
local t = {}
for i = 1, 500000 do
  t[i % 20000 + 1] = { i, tostring(i), i * 0.5 }
end
local s = 0
for i = 1, #t do s = (s + t[i][1]) % 1000000007 end
print("alloc", s)
