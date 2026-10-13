local util = require "util"           -- fetched lazily from util.lua
print("main:", util.greet("page"))
local f = assert(io.open("data/levels.json"))
print("levels:", f:read("a"))
f:close()
print("second require is the same table:", require("util") == util)
