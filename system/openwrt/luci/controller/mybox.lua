-- MyBox LuCI 兜底页：主面板挂了时，能在这里看状态、启停服务。
-- 安装：cp 到 /usr/lib/lua/luci/controller/mybox.lua，然后 /etc/init.d/uhttpd restart
module("luci.controller.mybox", package.seeall)

function index()
  entry({"admin", "services", "mybox"}, template("mybox/status"), "MyBox 服务状态", 90).dependent = false
  entry({"admin", "services", "mybox", "status"}, call("action_status")).leaf = true
  entry({"admin", "services", "mybox", "service"}, call("action_service")).leaf = true
end

local function sh(cmd)
  local f = io.popen(cmd .. " 2>/dev/null")
  local out = f:read("*a") or ""
  f:close()
  return out:gsub("%s+$", "")
end

function action_status()
  local panel = sh("/etc/init.d/mybox-panel status 2>/dev/null | grep -q running && echo running || echo stopped")
  local kernel = sh("/etc/init.d/mybox-kernel status 2>/dev/null | grep -q running && echo running || echo stopped")
  local kver = sh("/opt/mybox/bin/sing-box version 2>/dev/null | head -1")
  local pver = sh("cat /opt/mybox/VERSION 2>/dev/null")
  local port = sh("cat /opt/mybox/data/port 2>/dev/null")
  if port == "" or not port:match("^%d+$") then port = "3036" end
  luci.http.prepare_content("application/json")
  luci.http.write_json({
    panel = panel,
    kernel = kernel,
    kernel_version = kver,
    panel_version = pver,
    port = port,
  })
end

function action_service()
  local svc = luci.http.formvalue("svc") -- "panel" | "kernel"
  local op = luci.http.formvalue("op")   -- "start" | "stop" | "restart"
  if svc ~= "panel" and svc ~= "kernel" then
    luci.http.status(400, "bad svc")
    return
  end
  if op ~= "start" and op ~= "stop" and op ~= "restart" then
    luci.http.status(400, "bad op")
    return
  end
  os.execute("/etc/init.d/mybox-" .. svc .. " " .. op .. " >/dev/null 2>&1")
  luci.http.prepare_content("application/json")
  luci.http.write_json({ ok = true })
end
