# NetProxy 集成补丁说明（sing-box Clash 兼容 + KSU 安全区）

本 fork 在 v3.30.0 基础上做了两类改动，供 NetProxy Magisk 模块的 WebUI 使用。
改动以 commit 形式保存在 `main` 上，模块侧可直接 clone 本仓库构建面板。

## 1. 恢复 sing-box 的 Clash 兼容支持

3.23.0（commit `4adb487`）移除了 sing-box 原生 gRPC API 与「sing-box 提供的 Clash API 兼容」，
`detectCore` 只剩 honk/dae/mihomo 三个分支，sing-box 后端会被当成 mihomo 或 unknown。
本仓库把 Clash 通道上的兼容层补回来：

| 位置                                      | 改动                                                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/assembly/version.ts`                 | `/sing-?box/i` → `Core.Singbox`（sing-box `/version` 返回 `"sing-box <ver>"`），并配 sing-box 图标与仓库链接                   |
| `src/assembly/backend.ts`                 | 新增 `Core.Singbox`；`isNonMihomoCore` 纳入 singbox；能力表新增 `modeSwitch`、`traceLogLevel`、`extraLogLevels`、`memoryStats` |
| `src/assembly/overview.ts`                | `/memory` 流改由 `can('memoryStats')` 决定是否订阅（sing-box 无该端点，硬订阅会无限重连）                                      |
| `src/components/controls/ProxiesCtrl.tsx` | 模式选择器改挂 `modeSwitch`（sing-box 支持 `PATCH /configs` 切 `clash_mode`）                                                  |
| `src/assembly/logs.ts`                    | sing-box 支持 trace / fatal / panic 级别，按能力放开                                                                           |

已逐项核对 sing-box v1.15 的 Clash API：`/proxies`、`/providers/proxies`、`/group/{name}/delay`、
`/proxies/{name}/delay`、`/rules`、`/configs`(GET/PATCH)、`/cache/{fakeip,dns}/flush`、`/dns/query`、
`/connections`(GET/DELETE) 均存在；`/version` 形如 `{"version":"sing-box 1.15.x"}`；CORS 允许 `*` 与 `Authorization`。

## 2. KSU / MMRL WebUI 安全区

KernelSU 在页面引入 `https://mui.kernelsu.org/internal/insets.css` 后自动进入边到边（edge-to-edge），
并通过 JS 动态注入 `--safe-area-inset-*`（MMRL 的 WebUI X 用 `--window-inset-*`）。

- `src/assets/main.css`：在**所有 `@import` 之后**、`:root, body` 上定义
  `--np-safe-* = max(var(--safe-area-inset-*), env(safe-area-inset-*))`；
- 各处 `env(safe-area-inset-*)` 改为 `var(--np-safe-*)`（App.vue / HomePage.vue 的内联样式、CtrlsBar / BackendSwitchToast / DialogWrapper 的 class）；
- `index.html` 引入 `internal/insets.css`。

两个必须注意的坑（都踩过）：

1. 自定义规则若写在 `@import` 之前，CSS 规范会让后续 `@import` 失效，Tailwind/daisyUI 整份样式被丢弃（产物 CSS 从 260 KB 掉到 27 KB，页面错位）。
2. Tailwind 任意值类里不能带空格：`pt-[var(--np-safe-top,0px)]` 正确，写成 `var(--np-safe-top, 0px)` 会被 class 属性切成两个无效类名，规则根本不会生成。

## 构建与验收

```bash
pnpm install
FONT=none pnpm build              # 产物在 dist/
node scripts/verify-dist.mjs dist # 本机验收，必须通过
```

`verify:dist` 会检查：本地资源引用、入口 CSS 尺寸与 14 项结构标记（含两条安全区 padding 规则）、
入口 JS 尺寸与动态分块、sing-box / 安全区标记、insets.css 引用；`--serve` 额外起本地 HTTP 抓一遍；
`--reference <官方 dist>` 会要求官方 CSS 的普通类选择器 100% 覆盖。
