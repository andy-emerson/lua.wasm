-- a game-shaped frame, 60 times: update entities, sort by x, count
-- neighbours (the sort key is total -- x then id -- so the result does not
-- depend on the sort algorithm or its randomized pivot)
local N = 2000
local es = {}
for i = 1, N do es[i] = { id = i, x = i * 7 % 1000, y = i * 13 % 1000, vx = (i % 5) - 2, vy = (i % 3) - 1 } end
local hits = 0
for frame = 1, 60 do
  for i = 1, N do
    local e = es[i]
    e.x = (e.x + e.vx) % 1000
    e.y = (e.y + e.vy) % 1000
  end
  table.sort(es, function (a, b) if a.x ~= b.x then return a.x < b.x end return a.id < b.id end)
  for i = 2, N do
    if es[i].x - es[i - 1].x < 1 and math.abs(es[i].y - es[i - 1].y) < 2 then hits = hits + 1 end
  end
end
print("frame", hits)
