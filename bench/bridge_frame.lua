-- the bridge, a frame end to end: 60 frames of 2,000 entities moved in Lua,
-- their positions handed to the page each frame, which renders them into a
-- buffer and returns a checksum
local render = bridge.render
local n = 2000
local xs, ys, vx, vy = {}, {}, {}, {}
for i = 1, n do xs[i] = i % 97; ys[i] = i % 89; vx[i] = (i % 7) - 3; vy[i] = (i % 5) - 2 end
local check = 0
for f = 1, 60 do
  for i = 1, n do
    local x, y = xs[i] + vx[i], ys[i] + vy[i]
    if x < 0 or x > 640 then vx[i] = -vx[i] end
    if y < 0 or y > 480 then vy[i] = -vy[i] end
    xs[i], ys[i] = x, y
  end
  check = check + render(xs, ys, n)
end
print(string.format("%.0f", check))
