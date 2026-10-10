# 拾页 · 项目手记（Project Notes）

Paseo 项目看板，版本 **0.8.0**，插件 ID `project-notes`。按项目记录任务、提示词和想法，并能从一条手记直接开工：新建工作区和 Agent，把手记作为第一条消息发出去。需要 Paseo 0.11.1 或更新版本（daemon 与 App 都要满足，旧版本会拒绝加载）。界面为简体中文。

插件市场的说明页见 [OVERVIEW.md](OVERVIEW.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- 按项目整理任务、提示词和想法，默认总览全部项目；不归入项目的记在「随手记」。
- 任务状态、编辑、重点、置顶、搜索、复制及回收站恢复。
- 项目与 worktree 共用项目归属，不同 daemon 独立存储。
- **开始处理**：用户选择项目、Local/worktree、provider、模型、推理档位或 profile 后，创建工作区和 Agent 并发送所选 prompt。可选项全部来自 Paseo 当前报告的 provider、模型和 profile（含自定义 provider），插件不写死任何 provider；所选 provider 需要至少报告一个模型。独立启动记录用于避免不确定状态下重复创建；创建工作区和 Agent 时带幂等键，连点、重试或插件重载都不会多建。被重载打断的启动显示「需要核对」，并按 Agent 标签找回已创建的会话，只查询、不补建。
- 并发编辑使用 revision 校验；确认请求支持短期幂等重试。
- **省流量同步**：界面只在前台可见时轮询（切到后台、iOS inactive、隐藏的标签页都会暂停，回到前台立即检查一次）。每次请求带上次的内容版本号：没有变化只回约 60 字节；有变化只回变化的看板，项目列表变了才带项目列表。约每 5 秒一次，一分钟无变化后放宽到每 15 秒；自己的修改立即显示。
- **命令行 / Agent 记录**：`bin/notes.mjs` 直接读写手记，与插件共用数据文件，写入有跨进程锁。

从侧栏「拾页 · 项目手记」、工作区面板、命令中心或 `/notes` 打开。`/notes` 只打开面板。

## 界面

- **一行工具栏**：项目范围（全部项目 / 随手记 / 各项目，带条数，可搜索）、任务 / 提示词 / 想法及条数、搜索、新建（手机上是「+」），其余放在「···」：回收站、按项目分组、刷新（提示保存在哪台主机、上次同步时间）。
- **任务**：宽屏是 待办 / 进行中 / 已完成 三列，各列独立滚动，列头「+」直接新建到该状态；手机上是可折叠分组（进行中在前，已完成默认收起）。卡片左侧的状态圈是唯一的快捷操作：点一下前进一步（待办 → 进行中 → 已完成 → 待办）。
- **提示词 / 想法**：列表每行都有「复制」；宽屏右侧直接显示全文与全部操作。
- **详情**：点卡片打开，含全文和全部操作——开始处理、编辑、复制、状态、置顶、重点、删除。删除直接移到回收站（无确认框，随时可恢复）。
- **编辑**：类型、保存到（新建时选择，之后固定）、标题、正文、状态、重点、置顶；「保存」在手机上固定在顶部、桌面固定在底部；标题里按回车即保存；别处改过时停用保存，可「载入最新」。
- **开始处理**：只默认展开项目、标题、初始任务和工作区方式；Agent 设置折叠为一行摘要，需要处理时自动展开。确认后表单收起为摘要，显示启动进度，完成后打开新会话。
- 同步状态平时不显示；手动刷新时显示「同步中」，同步失败时出现一行提示和「重试」。
- **颜色**：任务蓝、提示词紫、想法琥珀（类型切换、编辑器、行首图标、空状态一致）；待办灰色空心圈、进行中蓝色半圈、已完成绿色实心对勾（卡片、列头、分组标题、状态切换一致）；重点红旗、置顶琥珀图钉；项目用首字母色块，颜色按项目名计算，与其他插件里同一项目一致，随手记是青色收件箱。「开始处理」的进度区按阶段变色：进行中蓝、已开始绿、需要核对琥珀、被拒绝红。

## 安装

本目录是插件集合仓库里的一个插件。从 Git 安装时指定子目录 `project-notes`，把 `<owner>/<repo>` 换成发布这个集合的仓库：

```sh
paseo plugin add git:<owner>/<repo>:project-notes
paseo plugin ls project-notes
```

Git 安装会在插件目录执行 manifest 里的两步准备：`npm ci --omit=dev --ignore-scripts --no-audit --no-fund` 按锁文件只安装生产依赖 esbuild 和 zod（约 20 MB），`npm run build` 生成命令行工具 `bin/notes.mjs`。daemon 主机需要 npm，并能访问 npm 仓库。插件本身只用 Paseo 提供的库。

也可以从本机目录安装：`paseo plugin install /绝对路径/project-notes`。目录安装不会执行上述准备步骤；需要命令行工具时，先在插件目录运行 `npm ci --omit=dev --ignore-scripts` 和 `npm run build`（开发时用完整的 `npm ci` 即可）。

## 让 Agent 记录：命令行

在本插件目录内执行。`npm run build` 把 `server/cli.ts` 打包为 `bin/notes.mjs`，产物不进 Git。

```sh
node bin/notes.mjs --help
node bin/notes.mjs projects
node bin/notes.mjs list --project inbox --kind task
node bin/notes.mjs add --project inbox --title "待整理的任务" --high --body-file - <<'EOF'
多行任务说明…
EOF
node bin/notes.mjs update ITEM_ID --status doing
node bin/notes.mjs done ITEM_ID
```

将 `ITEM_ID` 换成已有条目的 ID。在其他目录调用时写插件目录的完整路径；通过 Git 安装时可用 `paseo plugin ls project-notes --json` 查看安装目录。

- `--project` 接受 `inbox`、项目 ID、绝对路径或项目名称；省略时按 `PASEO_AGENT_CWD` 或当前目录归属。
- `--kind task|prompt|idea`，`--status todo|doing|done`，`--high` 重点，`--pinned` 置顶，`--body-file -` 从 stdin 读正文。`--json` 输出机器可读结果。
- `list` 默认排除已完成任务和回收站；`--all` 含已完成，`--trash` 只看回收站。
- `--request-id` 可选，同一 ID 重放时幂等返回原记录。参数错误退出码为 2。
- 项目列表来自 `paseo project ls --json`，不可用时回退读取 `$PASEO_HOME/projects/projects.json`。
- 界面在前台时约 5 秒（空闲后 15 秒）内看到 CLI 新记录：版本号由看板文件内容计算，其他进程写入同样生效。

CLI 和界面使用同一 `BoardStore`。`server/store.ts` 用 `<board>.json.lock` 排他锁串行化写入，30 秒以上的残留锁视为崩溃遗留并清理。CLI 只依赖 zod 和本插件源码（`shared/schema.ts`、`server/store.ts`、`server/cli.ts`），所以只装生产依赖也能构建。

## 数据与隐私

```text
$PASEO_HOME/plugin-data/project-notes/boards/<项目ID的SHA256>.json
$PASEO_HOME/plugin-data/project-notes/launches/<launchId>.json
```

未设置 `PASEO_HOME` 时默认 `~/.paseo`；源码目录不参与数据路径计算。移动、更新或卸载源码不等于迁移或删除笔记，请单独备份上述数据目录。

笔记没有额外静态加密，不适合存密码或 API key。回收站不会自动清空，界面也没有永久删除。启动任务时，用户确认的提示词会发送给所选 provider；启动记录只保存阶段和创建的工作区、Agent 标识，不保存提示词。其他手记的增删改只写插件自己的数据文件，插件不发网络请求、不启动子进程。拥有该 daemon 访问权的客户端都可以使用此插件。

## 开发

在插件目录运行：

```sh
npm ci --ignore-scripts
npm run build
npm run typecheck
npm test
npm run test:ui          # Playwright：桌面 1120×760 与手机 390×844 各跑一遍主要流程
npm run preview:build    # 模拟数据预览：preview/dist/index.html（加 --serve 在 127.0.0.1:4693 提供）
npm run preview:shots -- --out /tmp/notes-shots   # 各视图 × 桌面/手机 × 深色/浅色截图（--timezone 默认 UTC）
```

预览不连接任何 daemon：`preview/fixtures.js` 用内存里的虚构数据模拟全部 RPC（版本号、revision 校验、启动阶段），`preview/adapter.jsx` 按宿主方式提供图标（lucide）、弹窗（桌面 520 px 对话框、手机 65 % 底部弹层）、提示与剪贴板。`?theme=light`、`?scenario=empty|slow|error|stale|many|write-error|slow-write|copy-error|options-error|launch-hold|launch-reject` 切换状态，`?panel=1` 显示工作区面板，`?nav=0` 模拟不能跳转的客户端（启动完成后停在弹层里）。缺少系统 Chromium 依赖的主机需先设置 `LD_LIBRARY_PATH`。Playwright 与单元测试固定使用 UTC 时区。

测试使用系统临时目录（`tests/setup.ts` 把 `PASEO_HOME` 指向临时目录，绝不读写真实数据），覆盖：存储缓存与失效（含同大小原地修改）、损坏文件与体积上限、跨进程锁等待/超时/残留锁、真实 CLI 进程与插件并发写入；看板版本号、增量与项目列表失效；全部 RPC（用模拟 PaseoApi，按宿主方式双向校验）；启动流程的幂等键、重复点击、跨进程重复、失败分级与中断找回；界面轮询与交互（react-test-renderer + 假时钟）；打包约定（Git 安装只装生产依赖、CLI 打包只含 zod 与本地源码、SDK 版本与 manifest 下限一致、图标与截图）；Playwright 在真实浏览器里跑新建、编辑、状态、删除与恢复、复制、开始处理、项目范围、首屏位置与无横向溢出、加载与错误状态。开发依赖的 `react-dom`、`react-test-renderer` 与 React 均固定为 `19.1.0`。

## 来源与许可

原创插件，最初是作者自用的本地插件，不含第三方代码。MIT License，见 [LICENSE](LICENSE)。
