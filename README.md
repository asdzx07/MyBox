# MyBox

基于**官方 sing-box** 的透明代理控制面板。不 fork 内核、不带任何推广内容。

> 状态：最小骨架（v0.1.0）。核心闭环已跑通，功能在持续补齐。

## 它是什么

MyBox 把「订阅 → 节点 → 分流 → 内核」这条链路做成图形化操作，并负责把
sing-box 接到系统网络栈上（tun / nftables / 路由策略 / DNS），让局域网设备
改个网关就能用。

和同类项目的区别：

- **内核用官方原版**。不做任何 fork，直接下载 SagerNet/sing-box 的官方 Release，
  所以能第一时间跟进上游版本与安全修复。
- **不重写 sing-box 的能力**。凡是内核原生支持的，就交给内核——包括
  「改策略不重启内核」这个特性。
- **零推广**。仓库里只有代码和文档。

## 不重启内核是怎么做到的

这是很多人以为需要魔改内核的地方，其实不用。

sing-box 的本地 rule-set（`type: local`）在启动时会被 `fswatch` 监听
（见上游 `route/rule/rule_set_local.go`）。文件一变，内核立刻重新加载规则集
并触发回调，**进程不动、已建立的连接不断**。

MyBox 利用这一点：每个可切换的策略对应一个 50 字节左右的「开关文件」：

```jsonc
// data/flip/obflip-<id>.json —— 开启
{ "version": 3, "rules": [{ "network": ["tcp", "udp"] }] }

// data/flip/obflip-<id>.json —— 关闭
{ "version": 3, "rules": [{ "domain": ["obflip-off.invalid"] }] }
```

策略的路由规则写成 `逻辑与(真实条件, 开关规则集)`。切换策略 = 改写这个小文件，
内核自动重载 → 新连接按新线路走。完整配置（`config.json`）不用重写，内核不用重启。

### 已在官方内核上验证

用官方 `sing-box 1.14.2`（未修改）实测：启动后往开关文件里写入内容，
内核日志立刻出现重载记录，**进程 PID 全程不变**：

```
INFO  sing-box started (0.06s)
ERROR router: reload rule-set flip: invalid character 'T' looking for beginning of value
```

（第二行是故意写入非法内容触发的，正好证明内核确实重新读取了文件。）
写入合法内容时无报错，即重载成功。成功时内核不打日志，所以看不到「已重载」——
这是 sing-box 的设计，不是没生效。

在 iStoreOS 上也验证过整条链路：面板点开关 → 开关文件内容变成
`{"version":3,"rules":[{"domain":["obflip-off.invalid"]}]}` → 内核 PID 前后都是同一个。

## 自检

```sh
BOXPILOT_ROOT=./runtime node tools/selftest.mjs --smoke
```

不带 `--smoke` 只生成配置；带上会**真的把内核拉起来 6 秒**，看它会不会 FATAL。

这一步不是多余的：`sing-box check` 只解析配置，抓不到只在启动阶段才暴露的问题。
开发过程中「空的 direct 出站」和「DNS 规则里用了 IP 型规则集」两个 FATAL
都是靠它抓出来的，`check` 当时是全部通过的。

## 架构

```
┌─ 面板（浏览器）─────────────────────────────┐
│  单文件 SPA，无构建步骤                       │
└──────────────┬──────────────────────────────┘
               │ HTTP :3036
┌──────────────▼──────────────────────────────┐
│ 面板服务端（Node + Express）                  │
│  ├─ 订阅解析   base64 / Clash YAML / sing-box │
│  ├─ 配置生成   settings → config.json         │
│  ├─ 开关管理   data/flip/*.json               │
│  └─ 系统编排   nft / ip rule / dnsmasq / 服务  │
└──────────────┬──────────────────────────────┘
               │ 生成配置 + 管理进程
┌──────────────▼──────────────────────────────┐
│ 官方 sing-box（原版二进制）                    │
│  tun + mixed 入站 + Clash API :9095          │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│ 系统网络栈                                    │
│  nftables 表 mybox · ip rule 9000+ · tun  │
└─────────────────────────────────────────────┘
```

## 目录布局（运行时）

```
/opt/mybox/
├── bin/sing-box              官方二进制
├── etc/config.json           内核配置（生成物）
├── data/
│   ├── settings.json         面板设置（唯一的真相来源）
│   ├── flip/                 策略开关文件
│   ├── rulesets/             节点直连等小规则集
│   ├── geodata/              GeoSite / GeoIP（.srs）
│   └── panel-port            面板端口
└── panel/                    面板静态文件
```

## 安装

**OpenWrt / iStoreOS**（SSH 以 root 登录后执行）：

```sh
curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sh
```

**Debian / Ubuntu**（systemd）：

```sh
curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sudo sh
```

装完浏览器打开 `http://<机器IP>:3036`，首次访问设置面板密码。

脚本自己识别平台：OpenWrt 上装 procd 服务、下载 musl 版 Node；
Debian 上装 systemd 单元、用系统的 Node（没有就 apt 装）。
内核一律从 SagerNet/sing-box 官方 Release 下载，按平台选 glibc / musl 版。

## 直连不进内核

「国内直连、国外代理」这类用法里，直连的流量本来就不该经过内核。
MyBox 用 sing-box 原生的 `route_exclude_address_set` 实现：

- 把「目标是直连 / 拒绝」的策略涉及的 IP 集合（`geoip-cn` 等）加上一份
  私网 CIDR，写成一个本地规则集
- 塞进 tun 的 `route_exclude_address_set`

结果是内核**不给这些地址建路由**，包根本进不了 tun——不是「进了内核再判定直连」，
而是压根不进来。省掉的是内核的转发、嗅探和匹配开销。

在 iStoreOS（x86_64，sing-box 1.14.2）上实测：tun 的路由表里只有 74 条
（被代理的目标），**私网段 0 条**，`114.114.114.0/24`、`223.5.5.0/24` 这类
国内地址都不在表里。同时 DNS 侧也分开了——`www.google.com` 解析到
`198.19.0.2`（FakeIP，会进内核），`www.baidu.com` 解析到 `183.2.172.177`
（真实国内 IP，不进内核）。

### 一个必须绕开的坑：兜底出站不能是空的 direct

`route.final` 不能直接指向一个只有 `{"type":"direct"}` 的出站。sing-box 的
detour 校验里有这么一条（`common/dialer/detour.go`）：

```
detour to an empty direct outbound makes no sense
```

DNS 服务器不写 `detour` 时会去取默认出站，于是整份配置直接 FATAL 起不来。
所以 MyBox 固定生成一个叫「兜底」的 selector，成员是 `[直连, 拒绝, …各分组]`、
默认走直连，`route.final` 指向它——行为等价于 final=直连，但能通过校验。

## 支持的协议

订阅格式：sing-box JSON、base64 分享链接、Clash YAML。

节点协议：VLESS（含 REALITY）、VMess、Trojan、Shadowsocks、Hysteria2、TUIC。

## 路线图

- [x] 最小闭环：订阅解析 → 配置生成 → 内核启停
- [x] 策略热切换（本地 rule-set + fswatch）
- [x] tun + nftables 透明代理
- [x] dnsmasq 接管
- [x] OpenWrt / iStoreOS 平台适配（procd）
- [x] 直连不进内核（`route_exclude_address_set`）
- [ ] LuCI 兜底页（面板打不开时能启停服务）
- [ ] 规则集订阅与自动更新
- [ ] 链式代理、故障转移组
- [ ] 流量统计
- [ ] 客户端 App

## 许可

MIT。内核（sing-box）为 GPL-3.0，以官方二进制形式使用，不修改、不重新分发其源码。
