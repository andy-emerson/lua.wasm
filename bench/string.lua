-- strings: build, format, pattern-replace, concatenate
local parts = {}
for i = 1, 50000 do parts[#parts + 1] = string.format("%05d:%s", i, ("x"):rep(i % 7)) end
local text = table.concat(parts, "\n")
local replaced, count = text:gsub("(%d+):(x*)", "%2=%1")
local n = 0
for word in replaced:gmatch("%S+") do n = n + #word end
print("string", #text, count, n)
