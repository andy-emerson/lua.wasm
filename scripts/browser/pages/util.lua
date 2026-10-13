local helper = require "deep.helper"   -- a module's own require: fetched too
local M = {}
function M.greet(who) return "hello " .. who .. " " .. helper.suffix() end
return M
