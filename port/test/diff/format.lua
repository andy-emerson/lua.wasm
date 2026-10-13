-- number formatting and parsing: tostring, string.format, tonumber, the
-- float<->integer rules, string.pack, utf8 -- everything that leans on
-- the libc's printf/strtod and must be bit-exact
local vals = { 0, -0.0, 1, -1, 0.1, 1/3, 2/3, 1e15, 1e16, 1e100, 1e-100, 1e308, 2^53, 2^53 + 1,
  2^63, -2^63, 123456789012345678, math.pi, -math.pi, math.huge, -math.huge, 0/0,
  5e-324, 2.2250738585072014e-308, 1.7976931348623157e308, 255, 0xff, 1e3, 100.0, 3.0 }
for _, v in ipairs(vals) do
  print(v, tostring(v), math.type(v), string.format("%.14g|%.17g|%g|%e|%f|%a|%.3f|%10.2f|%-8g|", v, v, v, v, v, v, v, v, v))
end
for _, v in ipairs({ 0, 1, -1, 255, 65535, 2^31, -2^31, 2^53, math.maxinteger, math.mininteger }) do
  if math.type(v) == "integer" then
    print(string.format("%d|%5d|%-5d|%05d|%x|%X|%o|%i|%u|%c", v, v, v, v, v, v, v, v, v, 65))
  end
end
print(string.format("%q", 0.1), string.format("%q", 1/3), string.format("%q", 2^63), string.format("%q", math.huge), string.format("%q", -math.huge), string.format("%q", 0/0))
print(string.format("%q", "a\nb\0c\"d\\e\1\255"), string.format("%q", 10), string.format("%q", math.mininteger))
print(string.format("%s|%10s|%-10s|%.2s|%5.1s|", "abc", "abc", "abc", "abc", "abc"))
print(string.format("%5.2f%%", 99.555), string.format("%+d %+d % d", 1, -1, 1), string.format("%#x %#o", 255, 8))
for _, s in ipairs({ "10", " 10 ", "0x10", "1e2", "1E2", ".5", "5.", "-0", "+1", "0x1p4", "0x.8", "1e", "e1", "", " ", "10 x",
  "inf", "nan", "0x", "1_000", "１", "99999999999999999999", "0x7fffffffffffffff", "0xffffffffffffffff", "0x10000000000000000",
  "9223372036854775807", "9223372036854775808", "-9223372036854775808", "1e400", "-1e400", "4.9e-324", "2e-324" }) do
  local n = tonumber(s)
  print(("%q"):format(s), n, math.type(n), tonumber(s, 10), tonumber(s, 16), tonumber(s, 36))
end
print(tonumber("ff", 16), tonumber("zz", 36), tonumber("8", 8), tonumber("1.5", 10), tonumber(nil), pcall(tonumber))
print(3 // 2, 3.0 // 2, 3 % -2, -3 % 2, 3.5 % -2, 7 // 0.0, -7 // 0.0, 0/0 ~= 0/0, pcall(function() return 1 // 0 end))
print(1 == 1.0, math.tointeger(3.0), math.tointeger(3.5), math.tointeger("8"), 2^53 == 2^53 + 1, math.ult(1, -1), 5 >> 1, -1 >> 1, 1 << 63, 1 << 64)
print(math.floor(-0.5), math.ceil(-0.5), math.floor(2^62 + 0.5), math.fmod(7, 3), math.fmod(-7, 3), math.fmod(7, -3), math.fmod(7.5, 2), math.abs(math.mininteger), math.maxinteger + 1 == math.mininteger)
print(string.pack("<i4", 1):byte(1, -1))
print(string.unpack("<i4", "\1\0\0\0"), string.pack(">d", 1.5):byte(1, -1))
print(string.pack("z s1 B", "hi", "x", 255):byte(1, -1))
print(string.packsize("i4 i8 d f j n"), pcall(string.pack, "i17", 1))
print(utf8.char(72, 228, 8364, 128512), utf8.len("Hä€😀"), utf8.codepoint("€", 1), utf8.offset("Hä€", 3), #utf8.char(0x7fffffff))
for p, c in utf8.codes("aé€") do io.write(p, ":", c, " ") end print()
print(pcall(utf8.codepoint, "\xff"), utf8.len("\xff"), utf8.charpattern)
print(10 .. 20, 1.5 .. "", -0.0 .. "", 2^63 .. "", math.mininteger .. "", 1e100 .. "")
print(#tostring(1/3), tostring(1e15), tostring(1e16), tostring(123456789012), tostring(0.1 + 0.2))
print(string.format("%.99f", 1/3):sub(1, 40), string.format("%.0f", 0.5), string.format("%.0f", 1.5), string.format("%.0f", 2.5))
print(string.format("%g %g %g %g", 1e-5, 1e-4, 123456, 1234567), string.format("%#g %#.3g", 1.0, 1.0))
print(("%5s|%-5s|"):format(true, nil), ("%s"):format(setmetatable({}, { __tostring = function() return "T!" end })))
print(pcall(string.format, "%d", 1.5), pcall(string.format, "%d", "x"), pcall(string.format, "%z", 1))
print(math.max(1, 2.5), math.min(-1, -1.0), math.type(math.max(1, 2.0)), 8 | 1, 7 & 2, 5 ~ 3, ~0, 3.0 | 0, pcall(function() return 3.5 | 0 end))
