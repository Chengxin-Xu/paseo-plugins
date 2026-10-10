# 更新记录

## 0.4.0（2026-10-10）

整理成可以公开发布、可以提交 Paseo 插件市场的形态。

- **两套主题改了显示名**，避开 Anthropic 的产品名：🌑 Claude Code Dark → 🌑 Charcoal Night，☁️ Claude Code Light → ☁️ Oat Latte。配色逐字节不变；主题 id 仍是 `claude-code-dark`、`claude-code-light`。客户端按 id 记住选择，所以已经选中的主题不受影响，不用重选。
- 插件显示名改为 **Terracotta Themes**（原「Claude 主题」），说明里写明非官方、与 Anthropic 无关。
- manifest 新增 `name`、`description`、`icon`（原创的色卡扇图标）和 `media`（三张截图，第一张是六套主题的总览）。这些字段需要 Paseo 0.11，所以 `requirements.paseo` 从 `>=0.9.0` 提到 `>=0.11.0`（在 0.11.0 和 0.11.1 上验证过），`@getpaseo/plugin` 钉到 0.11.0，重建锁文件。
- 删掉 build 命令 `npm ci --ignore-scripts`：插件没有运行时依赖，SDK 导入都是 `import type`，Paseo 自己编译 TypeScript。Git 安装不再去装开发依赖。
- 新增 LICENSE（MIT）、OVERVIEW.md（插件市场的介绍页）和本文件。
- 测试 33 → 38 条：主题对象符合客户端的严格 schema，显示名不用 Anthropic 的产品名，图标与截图存在且尺寸合规，Paseo 下限与 SDK 钉版一致，没有 build 命令和运行时依赖，OVERVIEW 格式合规。

## 0.3.0（2026-09-22）

- 适配 Paseo 0.9：`requirements.paseo` 从 `^0.8.0` 改为 `>=0.9.0`（0.9 的 daemon 拒载 `^0.8.0`），`@getpaseo/plugin` 钉到 0.9.0，重建锁文件。`addTheme` 接口没有变化。

## 0.2.0（2026-09-22）

- 第一个版本：六套主题（三深三浅），在 OKLCH 里按同一套色调骨架推导。骨架测自 Claude Code CLI 内置主题的颜色值，彩度归零即逐字节复现其深色配色。
- `shared/color.ts` 自带 OKLCH 与 sRGB 的互转，色域外的颜色保色相、让彩度。
- `npm run preview` 用 `node:zlib` 自己编码 PNG，渲染六套主题的 UI 模拟图。
