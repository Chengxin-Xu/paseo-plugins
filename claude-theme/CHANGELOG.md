# 更新记录

## 0.5.1（2026-10-12）

按 Paseo 0.11.1 的真实表面补齐三处对比度缺口，对比度矩阵从手列的 14 项改成按表面生成的 25 项。

- **深色 `ring` 在工作区上不到 4.5:1**：深色模式的工作区底色是 `raised`，时间戳、分组标题和工具栏图标（`foregroundExtraMuted` = `ring`）画在上面只有约 4.3:1。现在 `ring` 同时对 `background` 和 `raised` 拟合，六套深色主题在工作区上都到 4.50–4.52:1；🌑 Charcoal Night 的 `ring` 从 CLI 的 `#888888` 提亮到 `#8C8C8C`。
- **深色状态徽标上的次要文字只有约 2.8:1**：宿主的状态徽标（主机、插件、任务状态，归档会话，用量套餐）把 12px 的 `mutedForeground` 画在 `border`（surface3）上。现在次要文字在徽标上也要 ≥4.1:1，六套深色主题的次要文字提亮（如 Charcoal Night `#999999` → `#B9B9B9`），徽标上到 4.11–4.13:1，和 Paseo 自带深色主题相当，仍明显比正文暗。
- **浅色选中行上的次要文字偏淡**：浅色模式选中的侧栏行是 `border`，上面的次要说明文字（`mutedForeground`）此前不到 4.1:1。现在 `mutedForeground` 同时满足底色和卡片 ≥4.5:1、选中行 ≥4.1:1，六套浅色主题的次要文字都略微加深（如 Oat Latte `#6C6A64` → `#64635D`）。
- **矩阵按表面生成**：`evaluateThemeContrast` 按工作区、侧栏、选中行、浮层、输入框、状态徽标、用户气泡、终端和主按钮逐一生成检查，阈值分阅读面、侧栏类和选中行三档，测试另外守住这次的几处缺口。界面框架上次要文字的下限（`mutedForeground` 4.1:1、`ring` 3.3:1）是保住层级的有意折中，低于 WCAG AA 对小字的要求，代码注释和 README 都照实写明，不再说成「非文字界面」的标准。

## 0.5.0（2026-10-11）

修复浅色模式 `ring` 对比度与跨色相扩展性，按 Paseo 0.11.1 真实表面映射建立 14 项对比度矩阵，并扩充 6 套鲜艳冷色变体（共 12 套主题，六深六浅）。

- **修复浅色主题 `ring` 明度过高**：Paseo 0.11 将 `colors.ring` 同时映射为 `foregroundExtraMuted`（时间戳、分组标题、工具栏图标、已完成待办文字）、Composer 输入框占位符 `surface4` 以及终端 `terminal.brightBlack`。此前 `LIGHT.ringL = 0.683` 使浅色主题下这些文字的对比度仅有 2.24:1–2.74:1；现将 `LIGHT.ringL` 下调至 `0.548` 并接入 `fitContrast` 保底，使全部 6 套浅色主题的 `ring` 对 `background` 对比度达到 **4.60:1–4.71:1（≥ 4.5:1）**、对 `raised` 卡片达到 **4.18:1–4.22:1**、对浅色侧栏与输入框底色 `control` 达到 **3.81:1–3.86:1（≥ 3:1）**，同时仍保持比 `mutedForeground`（`L = 0.524`）柔和一档的视觉层级。
- **按 Paseo 0.11.1 真实表面映射建模测试与预览**：在 `shared/palette.ts` 中新增 `resolveHostSurfaces` 与 `evaluateThemeContrast`，完整复现宿主深浅两套语义色展开规则（浅色侧栏 = `control`、深色工作区 = `raised`、用户消息气泡 `surface3` = `border`、主按钮文字 `accentForeground` = `background`），对每套主题逐项校验 14 组表面对比度，并同步更新 `scripts/preview.mjs`。
- **新增 OKLCH 自动对比度拟合 `fitContrast` 与颜色工具加固**：解决 OKLab 明度 $L$ 与 WCAG 相对亮度 $Y$ 在黄、绿、青、蓝色相段（$H \in [65^\circ, 270^\circ]$）的权重差异。已达标的现有 6 套主题（含 `Charcoal Night`、`Blueberry Night` 等锚点）色值保持不变；对任意新增色相自动沿明度轴二分微调直至满足目标对比度。同时为 `toOklch` / `luminance` 补齐 `#RRGGBB` 格式校验与纯中性灰色相归零。
- **新增 3 组（共 6 套）鲜艳冷色与高对比撞色主题**：
  - `⚓ Harbor Night`（dark，`harbor-night`）：深海军蓝底（`#131B22`）配电光亮青强调（`#00C7DF`）；
  - `🧊 Glacier Latte`（light，`glacier-latte`）：冰川冷白底（`#F5FAFF`）配高饱和钴蓝强调（`#0D6BCD`）；
  - `🔮 Velvet Night`（dark，`velvet-night`）：深紫罗兰底（`#1D1821`）配亮玫粉强调（`#F27CC2`）；
  - `🌺 Orchid Latte`（light，`orchid-latte`）：淡紫昼白底（`#FBF7FE`）配鲜莓紫红强调（`#AA408D`）；
  - `🐬 Lagoon Night`（dark，`lagoon-night`）：深海青绿底（`#101D1E`）配暖阳亮金强调（`#F4AF2D`）；
  - `🌊 Lagoon Latte`（light，`lagoon-latte`）：海沫清浅底（`#F2FBFC`）配深海青蓝强调（`#00797E`）。

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
