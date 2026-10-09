# MyBox 🚀

基于 **官方原版 sing-box** 的现代化透明代理控制面板与网络管理系统。

[![Release](https://img.shields.io/badge/version-v1.0.0-blue.svg)](https://github.com/asdzx07/mybox/releases)
[![sing-box](https://img.shields.io/badge/sing--box-official%20binary-orange.svg)](https://github.com/SagerNet/sing-box)
[![Platform](https://img.shields.io/badge/platform-OpenWrt%20%7C%20iStoreOS%20%7C%20Linux-green.svg)](https://github.com/asdzx07/mybox)
[![License](https://img.shields.io/badge/license-MIT-purple.svg)](./LICENSE)

---

## 📖 简介

**MyBox** 是一款轻量、优雅且高效的旁路由 / 软路由透明代理控制面板。它将「订阅管理 → 节点调度 → 目标分流 → 内核编排」全流程图形化，并自动完成系统网络栈（TUN / nftables / 路由策略 / dnsmasq / Fake-IP）的深度接管。

### 为什么选择 MyBox？

- **原版官方内核**：坚持使用 `SagerNet/sing-box` 官方原版 Release 二进制，安全透明，第一时间无缝同步官方最新特性与安全修复。
- **真·零断流热切换**：巧妙利用 sing-box 原生的 `rule-set: local` 规则集监听机制，分流策略和节点切换**无需重启内核进程**，已有会话与连接零中断。
- **直连零开销不进内核**：基于 `route_exclude_address_set`，国内流量与私网 IP 彻底绕过 TUN 网卡，包直接在系统路由层送出，**省去内核转发、嗅探与加解密开销**。
- **纯粹纯净，零推广**：无任何内置推荐节点、无推广引流返利，只有极致的代码与直观的面板。

---

## ✨ 核心特性

| 功能模块 | 说明 |
| :--- | :--- |
| ⚡ **0 断流热重载** | 独立设计策略状态开关（Flip State），无需重写完整配置或重启服务，毫秒级热切换。 |
| 🛡️ **直连真旁路** | 私网地址与国内直连 IP 规则集物理级绕过 TUN，直连网络千兆跑满零损耗。 |
| 🎯 **智能目标分流** | 内置 AI、流媒体、Google、YouTube、国内直连等预设规则；支持根据 rulesets、域名后缀（domain_suffix）及单域名自定义分流。 |
| 📱 **局域网设备控制** | 一键扫描局域网真实在线设备，支持按 IP 定制策略（如：NAS 强制直连防封号、电视盒子全局代理、手机电脑规则分流）。 |
| 📈 **实时监控与统计** | 高精度实时带宽上下行折线图波形展示；全量活动连接明细查看，支持实时关键字搜索与一键清空/断开。 |
| 📦 **全协议订阅解析** | 支持 Base64 节点链接、Clash YAML、sing-box JSON 等多种订阅格式；全面支持 VLESS（REALITY）、VMess、Trojan、Shadowsocks、Hysteria 2、TUIC。 |
| 🌐 **DNS 深度防污染** | 支持 dnsmasq 协同接管与 Fake-IP 模式，有效屏蔽 HTTPS/SVCB 绕过，杜绝 DNS 泄漏，内置防广告过滤（AdBlock）。 |
| 🚀 **一键安装与在线升级** | 脚本全自动探测平台与架构（x86_64 / aarch64 等），面板内置版本更新检测，支持一键无感热升级。 |

---

## ⚡ 不重启内核是如何实现的？

很多代理客户端修改规则或切换节点需要重启内核进程，导致下载中断或游戏掉线。MyBox 使用singbox官方内核平滑切换：

1. **原理**：sing-box 官方原生的本地规则集（`type: local`）由 `fswatch` 进行文件监听（源码见上游 `route/rule/rule_set_local.go`）。文件内容发生变动时，内核立即重新加载该规则集并触发热回调，**进程不动、PID 不变、已有连接不断**。
2. **状态轻量化**：MyBox 为每个策略分配一个微型的状态文件（约 50 字节）：
   ```jsonc
   // data/flip/flip-<id>.json —— 启用
   { "version": 3, "rules": [{ "network": ["tcp", "udp"] }] }

   // data/flip/flip-<id>.json —— 停用
   { "version": 3, "rules": [{ "domain": ["obflip-off.invalid"] }] }
   ```
3. 路由规则通过 `逻辑与(目标条件, 开关规则集)` 执行。面板切换开关只需改写对应小文件，新建立的连接立即走新线路。

---

## 🚀 快速安装

### 1. 一键安装脚本

在终端中以 `root` 权限执行以下命令：

**OpenWrt / iStoreOS（安装为 procd 系统服务）：**
```sh
curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sh
```

**Debian / Ubuntu / Linux（安装为 systemd 系统服务）：**
```sh
curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sudo sh
```

> [!TIP]
> 安装脚本将自动检测您的硬件架构（x86_64、aarch64 等）及系统环境，自动拉取对应平台的 Node.js 运行时与官方原版 sing-box 二进制程序。

### 2. 访问控制面板

安装完成后，在浏览器中打开：
```
http://<路由器或服务器IP>:3036
```
首次访问将提示您设置管理密码，设置完成后即可登录控制台。

---

## 🔄 系统更新与维护

### 在线一键更新（推荐）
在 Web 面板左侧进入【系统设置】，点击【检查更新】，检测到最新版本后直接点击【立即更新】，系统将平滑拉取最新代码并热重启面板服务。

### 终端手动更新
在 SSH 终端中执行更新脚本即可：
```sh
/opt/mybox/scripts/update.sh
```

### 密码重置
若遗忘面板登录密码，可通过终端一键重置：
```sh
node /opt/mybox/server/tools/reset-password.mjs <新密码>
```

---

## 🏗️ 架构拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                       Web 控制台 (SPA)                       │
│    仪表盘 / 节点管理 / 目标分流 / 局域网控制 / 实时连接 / 系统设置    │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP (:3036)
┌──────────────────────────────▼──────────────────────────────┐
│                    MyBox 服务端 (Node.js)                    │
│  ├─ 订阅解析引擎 (Clash / Base64 / sing-box)                 │
│  ├─ 配置编译器 (生成标准 sing-box 1.14+ 候选与正式配置)        │
│  ├─ 热状态管理 (data/flip/*.json)                           │
│  ├─ 局域网设备扫描与策略绑定 (ARP / /tmp/dhcp.leases)          │
│  └─ 系统网络栈编排 (nftables / ip rule / dnsmasq)            │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC / Clash API (:9095)
┌──────────────────────────────▼──────────────────────────────┐
│                   官方原版 sing-box 内核                     │
│  TUN 模式 · Mixed 代理端口 · Fake-IP DNS · 规则路由引擎        │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                        Linux 系统网络栈                       │
│  nftables 表 mybox · ip rule 优先级 9000+ · mybox-tun 设备    │
└─────────────────────────────────────────────────────────────┘
```

---

## 📂 运行时目录结构

```
/opt/mybox/
├── bin/
│   └── sing-box              # 官方 Release 原版二进制
├── etc/
│   └── config.json           # 最终运行的 sing-box 配置
├── data/
│   ├── settings.json         # 用户配置持久化存储
│   ├── clients.json          # 局域网设备规则持久化
│   ├── flip/                 # 策略 0 断流热切换开关文件
│   ├── rulesets/             # 节点直连等本地规则集
│   └── panel-port            # 面板自定义端口配置
├── panel/                    # Web 面板静态资源
├── server/                   # 后端 Express 服务与核心驱动模块
└── scripts/                  # 启动、安装与更新维护脚本
```

---

## 💻 常见问题 (FAQ)

<details>
<summary><b>Q: 为什么我访问国内网站非常快，且连接列表里没有大量直连连接？</b></summary>
这是 MyBox 的特色优势之一。通过将国内 IP 与私网 CIDR 置入 TUN 的 <code>route_exclude_address_set</code>，国内直连流量完全不经过内核，不占用 TUN 路由，直接在物理网卡层面秒发，实现了极致的“零损耗”。
</details>

<details>
<summary><b>Q: 支持哪些节点代理协议？</b></summary>
全面支持 VLESS（包含 XTLS Vision 及 REALITY）、VMess、Trojan、Shadowsocks、Hysteria 2、TUIC 等当前所有主流现代协议。
</details>

<details>
<summary><b>Q: 如何配合家庭主路由作为旁路由使用？</b></summary>
只需将局域网内其他设备（电脑/手机/电视盒子）的网络设置中：
1. <b>IP 地址</b>：设为同一网段静态 IP 或 DHCP 自动获取；
2. <b>默认网关</b>：填写运行 MyBox 的设备 IP；
3. <b>DNS 服务器</b>：填写运行 MyBox 的设备 IP。
所有设备流量即可由 MyBox 自动接管并分流。
</details>

---

## 📄 开源许可证

本项目基于 [MIT License](./LICENSE) 协议开源。
包含的 sing-box 内核遵循其上游 [GPL-3.0 License](https://github.com/SagerNet/sing-box/blob/main/LICENSE)，以官方原版二进制形式集成使用，不修改也不重新分发其源码。
