# 变更记录

## 0.8.1 — 2026-10-10

Security hardening after two external reviews of the published 0.8.0. Notes, the board file format and the interface stay the same, and lock files written by 0.8.0 are still understood.

- Board lock: a waiting writer now takes over a lock only when the process holding it has exited (on Linux a reused pid counts as exited, by the process start time), or after a minute when the holder cannot be checked from here (unreadable lock, another host or PID namespace). 0.8.0 removed any lock older than 30 seconds, even a live holder's. Each lock carries a random token: a writer removes only its own lock and checks it still holds the lock right before committing, and a `.reclaim` guard file lets only one of several waiters take over a stale lock. Before, two writers could hold a board at once and the later write silently replaced the earlier one.
- Overview size limits: a board file over 32 MiB, or the boards that would push one overview reply past 32 MiB in total (filled smallest first), are left out and named. The app shows a notice, marks those projects 不可用 in the project list and explains instead of showing an empty project; every other project loads as usual. Before, one oversized board, or two large boards together, made the whole overview fail. The total stays at 32 MiB because the reply is one WebSocket message: over the relay it grows by a third, and the host drops an app whose outbound queue would pass 64 MiB. In the CLI, `list` without `--project` does the same and reports what it skipped (`unavailable` in `--json`); a board left out only for the total still reads with `--project`.
- CLI input limits: `--body-file` reads only regular files and refuses, from `stat` and before reading, files over 96,000 bytes, the most a 32,000-character body can take in UTF-8. Directories, FIFOs and devices such as `/dev/zero` are refused without being opened. Standard input (`-`, and now `/dev/stdin`) stops at the same limit, and the `projects.json` fallback at 8 MiB, the limit already applied to `paseo project ls`. There is still no path allow-list: the CLI runs in the agent's own shell, which can read those files anyway.
- CLI output: human-readable output shows control characters from notes, project names and paths (ESC sequences such as OSC 52, CR, backspace, C1 controls) escaped as `\xNN`, keeping newlines and tabs; error messages too. `--json` output is unchanged. Times print in UTC and say so.
- Start dialog: provider errors and launch failures sent to the app are cut to 500 characters, including those in journals written before.
- The inbox has one description, 暂不归入项目的想法, in the projects RPC, the overview and the CLI, which used three wordings.
- Development: the fixture preview server answers a malformed request such as `GET //` with 400 and a missing build with 500 instead of exiting, and `PROJECT_NOTES_PREVIEW_PORT` sets its port (default 4693) for both the server and the Playwright config.
- Tests: lock liveness, pid reuse, unknown holders, a deterministic two-writer interleaving that lost an update on 0.8.0, a refused commit after the lock was taken over, CLI processes recovering a crashed writer's lock, overview degradation in the store, dashboard, client merge and UI, CLI input limits, escaping, UTC times and capped errors. A cache test that assumed ctime changes within one kernel clock tick now waits for the tick (it failed about 1 run in 7 before).

## 0.8.0 — 2026-10-09

开源整理：可以单独公开，并提交到 Paseo 插件市场。界面、功能和数据格式不变，已有手记照常读取。

- 需要 Paseo 0.11.1 或更新版本（原为 0.9.0）：manifest 新增英文显示名 `Project Notes`、描述、图标和截图，这些字段要求 0.11 及以上；开发依赖 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 固定为 0.11.1。
- Git 安装更轻：准备步骤改为 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，只按锁文件安装生成命令行工具所需的 esbuild 和 zod（约 20 MB，原来要装全部约 270 个开发依赖、约 350 MB），再由 `npm run build` 生成 `bin/notes.mjs`。为此看板数据结构从 `shared/board.ts` 拆到 `shared/schema.ts`，命令行工具不再引用 Paseo SDK；`shared/board.ts` 只定义 RPC 并转出这些结构，插件内的引用不变。
- 命令行读取 `projects.json` 的回退路径与插件数据目录用同一套 `PASEO_HOME` 解析，`PASEO_HOME=~` 时也能找到。
- 新增插件市场说明页 OVERVIEW.md、图标与截图（来自隔离测试 daemon 的真实界面，示例数据均为虚构）；README 改为通用安装方式，许可证署名改为「Project Notes contributors」。
- 预览数据、截图脚本和测试改用虚构的示例项目与通用 profile 名；Playwright 和单元测试固定使用 UTC 时区。
- 测试新增打包约定（Git 安装只装生产依赖、CLI 打包只含 zod 与本地源码、SDK 版本与 manifest 下限一致、图标与截图存在且不超过 400 KB）和 `PASEO_HOME` 解析。

## 0.7.2 — 2026-09-23

- 修复：手机、折叠屏等原生 App 上，项目列表和启动选项里的搜索框不再与下方内容重叠（共享 kit 的搜索框在纵向布局里会把所在行压成 0 高度，网页端不受影响）。

## 0.7.1 — 2026-09-23

- 共享 kit v3 调色板：深色主题下颜色更亮（霓虹感），新增天蓝、青柠、洋红色相与渐变、光晕工具；文字颜色对比度仍 ≥ 4.5:1。功能与布局不变。

## 0.7.0 — 2026-09-23

加颜色：状态和类别一眼可辨，布局、数据与操作不变。

- 类型固定配色：任务蓝（方框勾）、提示词紫（对话框图标，替换原来的终端图标）、想法琥珀（灯泡）。类型切换（条数着色，手机宽度够时也显示图标）、编辑器、列表行首、空状态都用同一颜色；宽屏列表的选中行用该类型的浅色底。
- 任务状态用形状和颜色同时区分：待办灰色空心圈、进行中蓝色半圈、已完成绿色实心对勾。卡片、看板列头（图标、名称、条数，下方一条同色细线）、手机分组标题、详情和编辑器的状态切换全部一致；状态切换里当前状态用同色浅底和边框（文字保持正文色，保证对比度）。
- 重点改为红旗、置顶为琥珀图钉，卡片与列表的信息行、详情和编辑器里的开关一致（打开时着色，关闭时灰色）。详情里的「删除」改为红色垃圾桶图标，仍然只是移到回收站。
- 项目用首字母色块，颜色按项目名计算，与其他插件里同一项目一致；随手记是固定的青色收件箱，已移除的项目为灰色。用在项目筛选按钮、选择项目列表、全部项目视图的卡片和列表、按项目分组的标题、编辑器的「保存到」和「开始处理」的目标项目。
- 回收站：标题和菜单入口带红色垃圾桶，每行的「恢复」是绿色按钮，行首显示类型颜色。
- 「开始处理」：工作区方式带彩色图标（独立 Worktree 青绿、项目目录靛蓝）；启动进度区按阶段着色并带进度条——进行中蓝、已开始绿、需要核对琥珀、被拒绝红；服务器给出的原因直接显示在进度区里，不再另起一条红色提示。提示词详情里的「开始处理」是蓝色按钮。
- 空状态按类型着色，读取失败为红色，同步中断为琥珀色提示条。
- 类型切换的图标按实际宽度显示：手机约 370 px 起、桌面约 790 px 起（条数位数多时相应放宽），更窄时只保留名称和彩色条数，「全部项目」和右侧按钮不会被挤压。桌面搜索框基准宽度从 240 px 调为 200 px（仍可缩到 140 px），让侧栏展开时约 800 px 宽的界面也能显示图标。
- 预览新增 `?nav=0`（不能跳转的客户端）和「启动被拒绝」「启动完成」两个截图视图；组件测试新增 2 项颜色语义检查（共 63 项），界面测试不变（桌面与手机各 10 项）。

## 0.6.0 — 2026-09-23

界面重做，数据、RPC 与同步方式不变。

- 去掉大标题、英文眉题、说明文字和底部说明，改为一行工具栏：项目范围、任务 / 提示词 / 想法（带条数）、搜索、新建（手机上是「+」）和「···」（回收站、按项目分组、刷新）。第一条手记的标题距界面顶部：桌面从约 476 px 到 104 px，手机从约 604 px 到 135 px。
- 任务卡片只保留标题、一两行摘要和一行「重点 · 项目 · 时间」；状态圈是唯一的快捷操作，点一下前进一步。其余操作（开始处理、编辑、复制、状态、置顶、重点、删除）集中到点开后的详情里。全部项目视图才显示项目名。
- 手机上任务改为可折叠分组（进行中、待办、已完成，已完成默认收起），不再横向切换状态；宽屏的提示词、想法、按项目分组和回收站改为左列表右详情，列表每行都能直接复制。
- 编辑与新建合为同一弹层：保存固定可见（手机顶部、桌面底部），标题回车即保存，标题为空时保存不可用；在别处被修改时停用保存，可「载入最新」。删除改为直接移到回收站并提示，不再二次确认；「置顶」「重点」可在详情里直接切换。
- 「开始处理」弹层：说明缩成一行，Agent 设置折叠为一行摘要（需要处理时自动展开），两列排布；确认后表单收起，只显示进度与结果。复制结果改用轻提示。
- 同步状态平时不显示，只在手动刷新或同步失败时出现；读取失败给出「重试」。首次加载显示骨架行。
- 统一使用共享 UI 套件（`client/kit.tsx`），颜色全部来自主题，图标与宿主一致。修复网页端卡片内按钮嵌套导致的点击穿透问题。
- 新增模拟数据预览（`npm run preview:build`）、截图脚本（`npm run preview:shots`）和 Playwright 界面测试（`npm run test:ui`，桌面与手机各 10 项）；组件测试新增 5 项（共 61 项）。

## 0.5.0 — 2026-09-22

- 适配 Paseo 0.9.0：manifest 改为 `"paseo": ">=0.9.0"`，开发依赖固定 `@getpaseo/plugin`、`@getpaseo/client`、`@getpaseo/protocol` 0.9.0。0.8 的 daemon / App 不再加载本插件。
- 看板同步改为按内容版本号：`project-notes.dashboard` 接受上次的 `revision`，没有变化只回 `{ unchanged: true, revision }`（约 60 字节），有变化只回变化的看板，项目列表变化时才带项目列表。版本号由看板文件内容和项目列表计算，插件、CLI、其他进程或手工修改都会生效；插件重启后相同内容得到相同版本号。旧客户端不带版本号时仍拿到完整数据。
- 界面只在前台可见时轮询：App 进入后台或 iOS inactive、面板所在标签被隐藏（布局尺寸为 0）时暂停，回到前台立即检查一次。约每 5 秒一次，一分钟无变化后放宽到每 15 秒；自己的修改直接用写入结果更新并回到 5 秒。后台轮询不再触发重新渲染，派生列表与卡片做了缓存。
- 服务端按文件 inode / 大小 / mtime / ctime 缓存已解析的看板，轮询时只 `stat`，只重读变化的文件；读取并行且有上限。Paseo 项目列表在各 RPC 间共享：`project.update` 事件立即失效，另有 30 秒兜底过期；8 秒超时，失败时沿用上次列表。
- 启动任务：创建工作区和 Agent 时带 0.9 幂等键（`project-notes:<launchId>:workspace|agent`），重复点击、重试或新旧插件进程重叠都不会多建；被插件重载打断的启动按 Agent 标签查询已创建的会话（只查询、不补建）。读取代理选项的各调用加超时，总计控制在 24 秒内。启动记录改用唯一临时文件写入。
- 打开结果时显式传 `serverId`（0.9 导航参数），始终打开发起启动的主机上的会话。启动状态查询同样只在前台轮询。
- 删除未被引用的 `client/web.ts`（用 `window.open` / `Linking.openURL` 的旧外链工具）。插件界面没有打开外部链接的入口，因此没有改接 `openExternalUrl`。
- 测试从 13 项扩充到 56 项：存储缓存、锁、真实 CLI 进程并发、看板版本号与增量、全部 RPC、启动幂等与中断、界面轮询（react-test-renderer）。

## 0.4.0

- 新增命令行 `bin/notes.mjs`，Agent 和脚本可直接读写手记；插件与 CLI 通过 `<board>.json.lock` 跨进程串行化写入。

## 0.3.0

- 从作者自用的本地插件整理为独立插件。
