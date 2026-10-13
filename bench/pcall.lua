-- error handling: every pcall is a protected call, every error an unwind
local n = 0
for i = 1, 200000 do
  if not pcall(error, "x") then n = n + 1 end
end
print("pcall", n)
