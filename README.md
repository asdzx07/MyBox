# BoxPilot

基于**官方 sing-box** 的透明代理控制面板。不 fork 内核、不带任何推广内容。

> 状态：最小骨架（v0.1.0）。核心闭环已跑通，功能在持续补齐。

## 它是什么

BoxPilot 把「订阅 → 节点 → 分流 → 内核」这条链路做成图形化操作，并负责把
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

BoxPilot 利用这一点：每个可切换的策略对应一个 50 字节左右的「开关文件」：

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
写入合法内容时无报错，即重载成功。

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
│  nftables 表 boxpilot · ip rule 9000+ · tun  │
└─────────────────────────────────────────────┘
```

## 目录布局（运行时）

```
/opt/boxpilot/
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

Linux（Debian / Ubuntu，systemd）：

```sh
curl -fsSL https://raw.githubusercontent.com/asdzx07/boxpilot/main/scripts/install.sh | sudo sh
```

装完浏览器打开 `http://<机器IP>:3036`，首次访问设置面板密码。

## 支持的协议

订阅格式：sing-box JSON、base64 分享链接、Clash YAML。

节点协议：VLESS（含 REALITY）、VMess、Trojan、Shadowsocks、Hysteria2、TUIC。

## 路线图

- [x] 最小闭环：订阅解析 → 配置生成 → 内核启停
- [x] 策略热切换（本地 rule-set + fswatch）
- [x] tun + nftables + ip rule 透明代理
- [x] dnsmasq 接管
- [ ] OpenWrt / iStoreOS 平台适配（procd + LuCI）
- [ ] 规则集订阅与自动更新
- [ ] 链式代理、故障转移组
- [ ] 流量统计
- [ ] 客户端 App

## 许可

MIT。内核（sing-box）为 GPL-3.0，以官方二进制形式使用，不修改、不重新分发其源码。
