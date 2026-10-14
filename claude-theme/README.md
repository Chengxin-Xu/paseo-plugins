# Terracotta Themes

十二套 Paseo 主题，六深六浅，共用同一条在 OKLCH 里推导的色调阶梯与 WCAG 自动对比度拟合器。在 **Settings → Appearance → Theme** 里按 emoji 列出；桌面端、浏览器和手机端都能用，只要客户端连的是装了本插件的 daemon。

> 非官方项目，与 Anthropic 无关，也未获其认可。配色的明度骨架取自 Claude Code CLI 内置主题的颜色值；Claude 和 Claude Code 是 Anthropic 的商标。

![同一个界面切成六条，分别是六套锚点主题](assets/screenshot-overview.png)

| 主题 | ID | 外观 | 底色 | 卡片 | 控件 / 侧栏 | 强调色 | 性格 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 🌑 Charcoal Night | `claude-code-dark` | dark | `#1A1A1A` | `#262626` | `#373737` | `#D77757` | 复现 Claude Code CLI 的深色配色：中性灰配赤陶 |
| ☁️ Oat Latte | `claude-code-light` | light | `#FAF9F5` | `#F0EEE6` | `#E8E4D7` | `#B54821` | 燕麦奶油白配压暗的赤陶 |
| 🍫 Cocoa Night | `cocoa-night` | dark | `#1D1916` | `#2B251F` | `#3E352E` | `#D77757` | 暖褐，深色锚点的精修版 |
| 🫐 Blueberry Night | `blueberry-night` | dark | `#181A22` | `#222532` | `#323647` | `#B1B9F9` | 靛蓝配长春花紫 |
| 🌸 Sakura Latte | `sakura-latte` | light | `#FFF7F8` | `#FEE7EB` | `#FFD9E0` | `#B4415B` | 樱花粉配深玫瑰 |
| 🍵 Matcha Latte | `matcha-latte` | light | `#F6FBF4` | `#E8F1E3` | `#DBEAD1` | `#B54821` | 抹茶绿配赤陶（近互补） |
| ⚓ Harbor Night | `harbor-night` | dark | `#131B22` | `#1B2833` | `#273949` | `#00C7DF` | 深海军蓝板岩配电光亮青，与红/琥珀状态色清晰拉开 |
| 🧊 Glacier Latte | `glacier-latte` | light | `#F5FAFF` | `#E5EFF9` | `#D5E6F6` | `#0D6BCD` | 冰川冷白底配高饱和钴蓝 |
| 🔮 Velvet Night | `velvet-night` | dark | `#1D1821` | `#2A2331` | `#3C3246` | `#F27CC2` | 深紫罗兰底配明亮玫粉 |
| 🌺 Orchid Latte | `orchid-latte` | light | `#FBF7FE` | `#F1EAF9` | `#EADEF6` | `#AA408D` | 兰花淡紫昼白底配鲜莓紫红 |
| 🐬 Lagoon Night | `lagoon-night` | dark | `#101D1E` | `#162A2C` | `#213C3F` | `#F4AF2D` | 深海青绿底配暖阳亮金，高对比冷暖撞色 |
| 🌊 Lagoon Latte | `lagoon-latte` | light | `#F2FBFC` | `#E0F2F4` | `#CDEAEE` | `#00797E` | 海沫清浅底配深海青蓝 |

需要 Paseo 0.11.0 或更高版本（manifest 用了 `name`、`icon`、`media`，0.11 以前的 daemon 拒绝安装）。插件只在客户端注册主题：没有设置项，没有服务端部分，不联网、不读写文件、不起子进程。代码块的语法高亮是 Appearance 里单独的设置，不随主题变化。

![Blueberry Night：对话、代码块与改动面板](assets/screenshot-blueberry-night.png)

![Sakura Latte：等待确认的编辑与 diff 预览](assets/screenshot-sakura-latte.png)

## 配色不是手调的

`addTheme` 只收 8 个颜色，Paseo 0.11 把它们展开成面板、菜单、diff、状态色和终端的完整 token 集：

- **浅色模式**：工作区底色 `surfaceWorkspace` = `background`，左侧栏 `surfaceSidebar` = `control`，选中侧栏项与用户消息气泡 `surface3` = `border`，输入框 `input` = `control`。
- **深色模式**：左侧栏 `surfaceSidebar` = `background`，工作区底色 `surfaceWorkspace` = `raised`，选中侧栏项、下拉浮层 `popover` 与输入框 `input` = `control`，用户消息气泡 `surface3` = `border`。
- **双模式共用**：`ring` 同时映射给焦点环、Composer 占位符 `surface4`、次级弱化文字 `foregroundExtraMuted`（消息时间戳、分组标题、工具栏图标、已完成待办文字）以及内置终端 `terminal.brightBlack`；主按钮文字 `accentForeground` = `background`。

做法是在 **OKLCH** 里推导，而不是在 hex 里试。OKLCH 的明度是感知均匀的：同一条明度阶梯换个色相，视觉深浅完全一致。于是粉色主题、靛蓝主题和深海青主题的卡片"浮起来"的程度是一样的。

骨架本身是**测**出来的：读出 Claude Code CLI（`2.1.263`）内置主题对象里的颜色，逐个换算成 OKLCH 坐标：

| Paseo token | 深色 OKLCH L | 浅色 OKLCH L | CLI 主题里的来源与 Paseo 0.11 真实用途 |
| --- | --- | --- | --- |
| `background` | 0.218 | 0.982 | 页面底色 `surface0`、深色侧栏、浅色工作区、终端底色、主按钮文字 |
| `raised` | 0.269 | 0.948 | `composerSidebarBackground:"rgb(38,38,38)"`；卡片 `surface1`、深色工作区 |
| `control` | 0.337 | 0.918 | `userMessageBackground:"rgb(55,55,55)"`；输入框 `surface2`、浅色侧栏、深色浮层 |
| `border` | 0.431 | 0.872 | `subtle:"rgb(80,80,80)"`；分隔线与用户消息气泡 `surface3` |
| `mutedForeground` | 0.683（拟合到 0.786） | 0.524 | `inactive:"rgb(153,153,153)"`；次要说明文字 |
| `ring` | 0.627（拟合到 0.640） | 0.548 | `promptBorder:"rgb(136,136,136)"`；焦点环、`foregroundExtraMuted`、占位符 `surface4`、`terminal.brightBlack` |
| `accent` | 0.670 | 0.542（自动拟合） | `claude:"rgb(215,119,87)"`（色相 **H39.1°**）；主按钮与选中强调色 |

**把彩度设为 0 喂给这套骨架，出来的就是 CLI 的深色配色**，也就是 🌑 Charcoal Night：8 个值里 6 个逐字节一致，两个文字色为 Paseo 的表面提亮了。`ring` 从 `#888888` 提到 `#8C8C8C`，因为 Paseo 深色模式把它当时间戳和分组标题画在工作区（`raised`）上，`#888888` 在那里只有约 4.3:1；`mutedForeground` 从 `#999999` 提到 `#B9B9B9`，因为宿主的状态徽标把 12px 次要文字画在 `border`（`#505050`）上，`#999999` 在那里只有约 2.8:1。这条有测试守着（`tests/palette.test.ts`）。其余十一套不是"另外画的主题"，而是同一套骨架换了色相。

### 彩度是递增的

浅色系测出来有个细节：**表面越深，彩度越高**（`#FAF9F5` C0.005 → `#DAD5C4` C0.024）。这正是奶油色和冰川蓝看起来"有设计"而不是"发灰"的原因。这条斜坡被抽成 `surfaceC: [0.22, 0.45, 0.75, 1.0]`，全家族共用。

### 刻意的偏离与自动对比度拟合（`fitContrast`）

- **`background` 是补的**：终端主题没有自己的底色（它继承终端）。深色 `#1A1A1A` 压在 composer 侧栏色下面一档，浅色用奶油白 `#FAF9F5`。
- **浅色 `ring` 针对 `foregroundExtraMuted` 调校到 L=0.548**：宿主把 `ring` 用作时间戳、分组标题、工具栏图标、输入框占位符和终端亮黑。`L=0.548` 让浅色 `ring` 既保持比 `mutedForeground`（`L=0.524`）柔和一档的层级，又在 `background` 上达到 **4.60–4.71:1（≥4.5:1）**、在 `raised` 上达到 **4.18–4.22:1**、在 `control` 上达到 **3.81–3.86:1**。
- **按宿主真实表面拟合 `mutedForeground` 与 `ring`**：深色 `ring` 对 `background` 和工作区 `raised` 同时拟合到 ≥4.5:1（六套深色主题在工作区上 4.50–4.52:1）。`mutedForeground` 除了底色和卡片 ≥4.5:1，还要在它出现的高亮表面上 ≥4.1:1：选中的侧栏行，以及状态徽标的底色 `border`（surface3）。浅色在这些表面上是 4.10–4.13:1；深色徽标从约 2.8:1 提到 4.11–4.13:1，和 Paseo 自带深色主题徽标的约 4.05:1 相当，次要文字仍明显比正文暗（对比 1.75–1.96 倍）。几组约束取更深（浅色）或更亮（深色）的那个结果，所以只会更清楚，不会变淡。
- **有意的折中，不是另一套标准**：在侧栏、浮层、输入框、选中行和徽标这些「界面框架」上，次要文字的下限低于 WCAG AA 对小字的 4.5:1。`mutedForeground` 是 4.1:1，`ring`（12px 的时间戳、分组标题）是 3.3:1，`accent` 是 3.5–3.7:1。要把时间戳也提到 4.5:1，它就会和次要文字一样深浅，层级就没了。实测浅色 `ring` 在选中行上是 3.30–3.34:1，深色是 3.54–3.59:1。正文所在的工作区仍全部 ≥4.5:1。
- **跨色相 WCAG 自动对比度拟合（`fitContrast`）**：OKLab 感知明度 $L$ 与 WCAG 相对亮度 $Y = 0.2126R + 0.7152G + 0.0722B$ 对绿、青、蓝通道权重不同，固定 `L=0.542` 在黄/绿/青/蓝色相段（$H \in [65^\circ, 270^\circ]$）会落到 4.0–4.4:1。`fitContrast` 对已达标的颜色原样返回（保证现有锚点主题逐字节不变），对不足 4.5:1 的色相保持色相与彩度、自动微调明度 $L$ 直至在 `background` 和 `raised` 上同时过 4.5:1。
- **🫐 Blueberry 与冷色深色主题的强调色明度**：`#B1B9F9` 保留它自己的 `L=0.8025`；`⚓ Harbor Night`（亮青 `#00C7DF`）、`🔮 Velvet Night`（亮玫粉 `#F27CC2`）、`🐬 Lagoon Night`（亮金 `#F4AF2D`）同样采用高明度鲜亮强调色，使深色界面下的主按钮文字（`accentForeground` = `background`）与表面文字双向对比度均高于 6.0:1。

### sRGB 装不下的部分

浅色底色在 L=0.982 那么亮的地方，sRGB 能容纳的彩度非常有限。🌸 Sakura 的底色请求 C0.0128，实际只拿到 C0.0087。色域拟合器的选择是**保色相、让彩度**：直接裁 RGB 通道会把粉色扭成别的颜色。所以浅色主题是"奶盖在上面"的观感：页面接近白，卡片才吃色。这是 sRGB 的硬约束，不是配置没调够。

## 看一眼

```bash
npm run preview   # 生成 preview/dist/themes.png，十二套主题的 UI 模拟图
```

产物在 `preview/dist/`（已 git ignore）。`scripts/preview.mjs` 按 Paseo 0.11 的真实表面分配绘制侧栏、选中行、工作区、用户气泡（`border`）、主次按钮和带占位符（`ring`）的输入框。

## 校验

测试用 Node 自带 runner（`node --test` + 类型擦除），不引入 vitest，依赖树 17 个包，全是开发依赖。65 条断言分五层：

- **色彩转换与拟合**：8 个已知色 OKLCH 往返无损；中性灰色相与彩度归零；非法 hex 抛错；色域外的颜色保住色相（漂移 <1.5°）；`fitContrast` 在全色相环 0°–360° 上保证浅色强调色对底色和卡片均 ≥4.5:1。
- **忠实度**：配方仍然复现 CLI 的深色配色（除 `ring` 提到 `#8C8C8C`、`mutedForeground` 提到 `#B9B9B9` 外逐字节一致）和 `#B1B9F9`。
- **宿主表面对比度矩阵（25 项/主题）**：每个主题对象都符合客户端的严格 schema；按 Paseo 0.11.1 的表面展开，把每个文字 token 放到它真实出现的每个表面上校验：工作区 `foreground` ≥7:1、`mutedForeground` / `ring` / `accent` ≥4.5:1；侧栏、浮层和输入框 `foreground` ≥7:1、`mutedForeground` ≥4.1:1、`ring` ≥3.3:1、`accent` ≥3.7:1；选中的侧栏行 `foreground` ≥7:1、`mutedForeground` ≥4.1:1、`ring` ≥3.3:1、`accent` ≥3.5:1；状态徽标 `mutedForeground` ≥4.1:1；用户气泡 `foreground` ≥7:1；终端 `foreground` ≥7:1、`ring`（亮黑）≥4.5:1；主按钮文字 ≥4.5:1；表面层级单调；次要文字与正文至少差 1.7 倍。
- **一致性**：同一明暗档内，各主题次要文字对比度的最大与最小值之差小于均值的 5%。主题 id 固定不变，显示名不用 Anthropic 的产品名。
- **打包**：manifest 与 `oss-export.json` 覆盖层合规，图标是 ≥512 px 的正方形 PNG 且 `icon.svg` 色卡与锚点主题一致，截图存在且每张 ≤400 KB；Paseo 版本下限与 `@getpaseo/plugin` 的钉版一致；没有 build 命令和运行时依赖；锁文件只指向 registry.npmjs.org；OVERVIEW 格式合规。

```bash
npm run typecheck
npm test
```

## 加一套自己的主题

在 `shared/palette.ts` 的 `SPECS` 里加一条，八行：

```ts
{
  id: "peach-latte",
  name: "🍑 Peach Latte",
  appearance: "light",
  surfaceHue: 45,          // OKLCH 色相角
  surfaceChroma: 0.05,     // border 的彩度，其余按斜坡递减
  accentHue: 30,
  accentChroma: LIGHT_ACCENT_CHROMA,
}
```

明度、对比度和层级由配方与 `fitContrast` 负责，不用自己试 hex。再把新的 id 和名字加进 `tests/palette.test.ts` 开头的两份清单。`id` 发布后就别再改：客户端按 `<插件 id>/theme/<主题 id>` 记住用户的选择，改了 id 用户就会被退回默认主题；显示名可以随便改。然后：

```bash
npm run typecheck && npm test && npm run preview
paseo plugin reload <插件 id>
```

## 许可

MIT，见 [LICENSE](LICENSE)。
