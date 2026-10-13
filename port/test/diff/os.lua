-- the os library: dates under a POSIX TZ rule (set by the runner), time
-- normalisation, the environment, the locale answer, and an exit status
local function show(...) print(select("#", ...), ...) end
local stamps = { 0, 1, 86399, 86400, 951782400, 1000000000, 1234567890, 1710054000, 1710057599, 1710057600, 1730000000,
  1730613599, 1730613600, 2147483647, 2147483648, 4102444800, -1, -86401, 253402300799 }
for _, t in ipairs(stamps) do
  print(t, os.date("%Y-%m-%d %H:%M:%S %Z %z %a %A %b %B %j %U %W %w %u %p %I %y %C %e %D %F %R %T %n%t|%%", t), os.date("!%c", t), os.date("!%x %X", t))
end
show(os.date("!*t", 1710054000).isdst, os.date("*t", 1710054000).isdst, os.date("*t", 1710050400).isdst)
local d = os.date("*t", 1234567890)
local keys = {} for k in pairs(d) do keys[#keys + 1] = k end table.sort(keys)
for _, k in ipairs(keys) do io.write(k, "=", tostring(d[k]), " ") end print()
show(os.time(d), os.time(os.date("!*t", 1234567890)), os.time({ year = 2000, month = 1, day = 1 }), os.time({ year = 2000, month = 1, day = 1, hour = 0 }))
show(os.time({ year = 2024, month = 13, day = 32, hour = 25, min = 61, sec = 61 }), os.time({ year = 2024, month = 0, day = 0 }), os.time({ year = 2024, month = 3, day = 10, hour = 2, min = 30 }))
show(os.time({ year = 2024, month = 3, day = 10, hour = 2, min = 30, isdst = true }), os.time({ year = 2024, month = 3, day = 10, hour = 2, min = 30, isdst = false }))
show(pcall(os.time, { year = 2024, month = 1 }), pcall(os.time, { year = "x", month = 1, day = 1 }), pcall(os.time, { year = 2024, month = 1, day = 1.5 }))
show(pcall(os.time, { year = 1e10, month = 1, day = 1 }), pcall(os.time, { year = -1e10, month = 1, day = 1 }), pcall(os.date, "%Y", 1e18), pcall(os.date, "%Y", -1e18))
show(os.difftime(10, 5), math.type(os.difftime(1, 0)), pcall(os.difftime, 5))
show(os.date("%Y", 2^31), os.date("!%Y-%m-%d", 2^33), os.date("!%Y", -2^31), os.date("!%Y-%m-%d %H:%M:%S", 2^39))
show(type(os.time()), math.type(os.time()), os.time() > 1700000000, type(os.clock()), os.clock() >= 0, os.clock() < 60)
show(os.getenv("TZ"), os.getenv("PATH"), os.getenv("NO_SUCH_VAR"), pcall(os.getenv))
show(os.setlocale(), os.setlocale("C"), os.setlocale("POSIX"), os.setlocale("pt_BR"), os.setlocale("en_US.UTF-8"), os.setlocale("xx_YY"), os.setlocale(nil, "numeric"), os.setlocale("C", "all"))
show(pcall(os.setlocale, "C", "bogus"))
show(os.setlocale("pt_BR"), tonumber("3,4"), tonumber("3.4"), string.format("%.2f", 1.5), os.setlocale("C"))
show(os.execute(), math.type(os.clock()), type(os.tmpname()))
show(os.date("%d/%m/%Y", 0), os.date("!%H:%M", 3600 * 25.5), os.date("", 0), os.date("x", 0), os.date("!%%Y", 0))
show(pcall(os.date, "%E"), pcall(os.date, "%Ec", 0), pcall(os.date, "%Oy", 0), pcall(os.date, "%q", 0), pcall(os.date, "%5d", 0))
show(pcall(os.date, 5, 0), pcall(os.date, "*t", -1), os.date("*t", -1).year)
show(os.getenv("HOME"), os.getenv(""), os.getenv("="))
io.write("before exit\n")
io.stderr:write("stderr before exit\n")
os.exit(3)
print("never printed")
