# 服务器浏览器 Server Browser 0.9

Paseo 插件：在 daemon 所在的 Linux 主机上运行 Chromium，手机和电脑在 Paseo 面板里看同一幅实时画面，可以点击、输入和导航；
浏览器 Agent 通过专用 MCP 操作同一个会话，你随时可以接管。无需另外暴露远程桌面或浏览器端口。

- 要求 Paseo 0.11.1 及以上，daemon 主机为 Linux。
- 界面和浏览器 Agent 的指令为简体中文。插件市场用的英文介绍见 [OVERVIEW.md](OVERVIEW.md)。
- 插件只使用 Paseo 宿主提供的库，没有运行时 npm 依赖，安装时不执行任何构建命令；浏览器运行时需要在主机上单独准备一次，见下文。

## 界面

侧栏打开 **服务器浏览器**。网页占据几乎整个面板，四周只有很薄的一圈工具：

- **电脑（两行）**：第一行是浏览器标签，每个工作区的浏览器一个；圆点颜色代表项目，多个项目时标签前显示项目标记和项目名。
  标签只切换你在看哪个浏览器，不改动网页。左侧 **所有浏览器** 打开总览，**+** 打开任意工作区（包括还没启动浏览器的），
  右侧 **打开 Agent** 跳到关联 Agent。第二行是后退 / 前进 / 刷新、地址栏、网页标签数、网页键盘、**Agent / 手动** 切换和 **⋯**。
- **手机（一行）**：顶部是当前浏览器（点它回到总览列表）、**Agent / 手动** 切换和 **⋯**。
  切到手动后，底部出现后退、刷新、地址栏、网页标签和键盘，方便单手操作；交还 Agent 后收起。

**谁在控制一目了然。** 选中 **Agent**（紫色）时网页只读，Agent 可以操作；选中 **手动**（琥珀色）时 Agent 的写操作会被拒绝，
你可以点击、滚动、输入和导航。网页四周的细边框和操作记录里的来源用同样的两种颜色。Agent 正在执行某一步时切到手动，
会显示“等待 Agent 结束当前操作…”。标签上的小标记表示 Agent 正在操作浏览器（蓝色旋转）、等待审批（琥珀色闪动）、
需要登录（橙色）、出错（红色）或已手动接管（琥珀色指针）；等待审批和疑似需要登录时，画面上方会出现可关闭的提示，
直接 **打开 Agent** 或 **手动接管**。

项目颜色由项目名决定；蓝色表示进行中，琥珀色表示等你处理，红色表示出错，灰色表示未启动。旋转和闪动在后台暂停，
系统开启“减少动态效果”时不播放。

**所有浏览器** 在电脑上是缩略图网格，在手机上是按项目分组的列表：显示项目标记、Agent、项目与工作区、当前网页、
谁在控制，以及“Agent 操作中”“待审批”“需登录”等彩色状态，可搜索并筛选“Agent 进行中”“待接管”（带数量）。缩略图每个网页只取一次，
不会持续轮询；点击只切换查看对象，不导航网页，也不接管另一个任务。

**Agent 运行中不等于正在操作浏览器。** 总览只列出已经创建的服务器浏览器会话；没有接入本插件的普通 Agent、
Paseo 自带的浏览器工具不会被当成操作者。每个工作区有独立的浏览器和登录目录，每个工作区的浏览器关联一个专用浏览器 Agent。

## 使用

- **入口**：侧栏、工作区面板、Command Center（“打开服务器浏览器”“打开当前工作区的服务器浏览器”）和 `/server-browser`。
- **网页标签**：点地址栏旁的数字（手机在 Agent 模式下为 **⋯ → 标签页**）查看全部标签；手动时可切换、固定、关闭或新建。
  默认最多 20 个标签，达到上限时拒绝新建；固定的标签要先取消固定才能关闭。
- **操作**：手动模式下点击网页；电脑可直接键入普通字符和常用按键。点 **键盘** 打开输入栏，可输入中文或输入法组合文字，
  并发送 Enter、Tab、退格、全选、Esc 和上下滚动。鼠标滚轮或手机在画面上滑动可以滚动网页。
- **画面尺寸**：**⋯ → 匹配窗口** 先按可用区域设置网页尺寸，再检查网页内部的横向溢出，必要时扩宽；**完整宽度** 单独展开
  被挤出的右侧内容。仅观看、切换设备不会改动共享浏览器尺寸。“匹配窗口”最大 2560×1600，只在手动模式下可用。
- **⋯ 菜单**：画面（画质、尺寸预设、暂停与刷新画面、传输数据）、用本机浏览器打开、打开或连接浏览器 Agent、阅读页面、
  页面诊断、操作记录、资源与恢复、打开演示页、关闭当前标签页和关闭浏览器（需确认）。只能在手动模式使用的操作，
  在 Agent 模式下不出现在菜单里。
- **阅读页面**：用 Readability 提取正文并转成 Markdown，也可读取完整可见文字或按关键词查找；长内容会标明截断。
- **页面诊断**：只读检查 Chromium 与调试连接、Chromium 沙箱、Profile、字体与运行库、Agent 工具、代理设置，以及当前页面的登录提示、
  HTTP 401/403 和网络错误。页面可读取不等于已经登录。
- **用本机浏览器打开**：用手机或电脑的默认浏览器打开当前网址（Paseo 桌面端另有“在 Paseo 本机浏览器打开”）；本机打开不共享
  服务器浏览器的登录状态，localhost 指向你自己的设备。

## 画面与流量

画面是服务器端截取的 JPEG，通过 Paseo 插件 RPC 传给客户端，不是视频流，不承诺固定帧率。

- 手机只传看得见的像素：画面按画面区大小（像素比最多按 2 计）在服务器端缩小后再传，点击坐标不变。
- 同时只有一个画面请求，间隔不短于往返时间的两倍；画面到达慢时临时降低画质，网络恢复后回到所选画质。
- 页面和会话没变化时，每次轮询只有几十字节；应用在后台或面板被切到隐藏标签时暂停轮询。
- 切换浏览器时先淡显上次看到的画面，拿到新画面后替换。

## 浏览器 Agent

**⋯ → 连接浏览器 Agent** 用你选择的 Agent Profile（默认列表里的第一个）在该工作区新建一个 Agent，并只给它一个名为
`server_browser` 的 MCP 服务器；随后发送一条简短的准备消息（会用掉一次模型回合），然后把控制权交给 Agent。
已有的其他 Agent 不会被修改，也不会全局抢占 Paseo 自带的浏览器工具。

`server_browser` 是通过一个小 bridge 连接到这个浏览器的 Playwright MCP。bridge 由插件按自己的源码（`server/bridge-source.ts`）
写入数据目录，Agent 用 daemon 的 Node.js 运行它：

- 只提供一份固定清单里的 Playwright MCP 0.0.82 工具，清单外的工具（包括以后版本新增的）一律拒绝。
  只读：快照、查找、等待、截图、控制台、网络请求列表与详情；写操作：导航、后退、点击、输入、填写表单、按键、选择、悬停、拖动、
  拖放文件、上传文件、处理对话框、在网页内执行 JavaScript、调整尺寸、模拟媒体特性、标签页；另有插件自带的阅读页面和页面诊断；
- 手动模式下拒绝所有写操作，只读查看仍然允许；不允许 Agent 关闭共享浏览器；不提供 `browser_run_code_unsafe`
  （会在 MCP 进程里执行任意 Node.js 代码）；
- 导航和面板地址栏走同一套规则：只允许 HTTP/HTTPS，拒绝地址里的账号密码以及链路本地和云服务器元数据地址，交给 MCP 的是规范化后的地址；
- 上传（`browser_file_upload`、`browser_drop`）的每个文件先解析真实路径，必须是该工作区目录里的普通文件，符号链接和目录外的文件一律拒绝；
- Playwright MCP 只从运行时目录的 `node_modules/@playwright/mcp/cli.js` 启动，工作目录是该工作区目录，
  截图、快照等按文件名保存时只能写进工作区目录或该浏览器的 `artifacts/`；它只继承 PATH、HOME、语言、时区、临时目录和 XDG 目录等环境变量，
  不继承 Agent 环境里的密钥、`NODE_OPTIONS`、代理和 `PLAYWRIGHT_MCP_*` 设置；
- 每次调用仍按 Agent 自己的审批设置处理。网页不能通过 WebMCP 给 Agent 注册工具。

插件重载或 daemon 重启后，浏览器在后台恢复；浏览器 Agent 的 MCP 启动时若浏览器正在恢复，会最多等待 20 秒。

## 运行时准备

插件本身不下载、不安装任何软件。首次使用前，在 daemon 主机上准备一次运行时：

```sh
node scripts/setup-runtime.mjs          # 安装固定版本的运行时依赖，然后检查
node scripts/setup-runtime.mjs --check  # 只检查，不安装
```

- 在插件目录里运行。目录安装就是你的源码目录；从 Git 或插件市场安装时，路径见 `paseo plugin ls --json` 输出的 `path`。
- 脚本把插件附带的 `runtime-deps/package.json` 和锁文件 `runtime-deps/package-lock.json` 复制到运行时目录，再用
  `npm ci --ignore-scripts` 按锁文件安装 `@playwright/mcp@0.0.82`、`@mozilla/readability@0.6.0`、`jsdom@26.1.0`、`turndown@7.2.4`
  及其全部下层依赖，每台主机装出同一棵依赖树。来源是主机 npm 配置的 registry，禁用安装脚本；运行时目录原有的 `package.json` 会被替换。
  它不下载 Chromium，也不修改 Agent 配置或创建浏览器 Profile。
- 插件会从运行时目录加载代码，所以它必须是当前用户自己的真实目录（不能是符号链接）；脚本和插件都会把它设为 0700，
  不符合时拒绝使用并说明原因。
- **Chromium**：插件依次使用 `PASEO_SERVER_BROWSER_EXECUTABLE`、Playwright 缓存（`~/.cache/ms-playwright` 或 `PLAYWRIGHT_BROWSERS_PATH`）
  中最新的 `chromium-headless-shell`、运行时 Playwright 自带版本。没有时可以用运行时里的 Playwright 安装 headless shell
  （从 Playwright 的下载源获取）：`node <运行时目录>/node_modules/playwright/cli.js install chromium-headless-shell`。
- **系统库与字体**：Chromium 使用主机的系统库和字体。缺少的动态库（例如 `libgbm.so.1`）可以放进运行时目录的 `lib/`，
  插件会把它加入 Chromium 的 `LD_LIBRARY_PATH`；运行时目录里有 `fonts.conf` 时作为 `FONTCONFIG_FILE`。中文网页需要中文字体。
- 准备完成后用 **⋯ → 页面诊断** 确认 Chromium、Agent 工具、字体和代理都已就绪。运行时缺失时，启动浏览器会直接提示缺什么。

| 环境变量（daemon 进程） | 用途 | 默认 |
| --- | --- | --- |
| `PASEO_SERVER_BROWSER_RUNTIME` | 运行时目录（Playwright、MCP、正文提取库，可选 `lib/`、`fonts.conf`） | `~/.local/share/paseo-server-browser` |
| `PASEO_SERVER_BROWSER_DATA` | 各工作区的浏览器数据目录 | `<运行时目录>/visual` |
| `PASEO_SERVER_BROWSER_EXECUTABLE` | 显式指定 Chromium / Chrome 可执行文件 | 自动查找 |
| `PASEO_SERVER_BROWSER_PROXY` | 只给共享浏览器设置代理（`host:port` 或 `scheme://host:port`；含账号密码时拒绝启动，因为它会出现在 Chromium 命令行里） | 不设置时沿用 daemon 的 `HTTP(S)_PROXY` / `ALL_PROXY` |
| `PASEO_SERVER_BROWSER_SANDBOX` | `1` 总是开启 Chromium 沙箱（主机不支持时启动失败）；`0` 总是关闭 | 不设置时自动：先开沙箱，主机不支持时改用 `--no-sandbox` 并在页面诊断里提示 |

## 数据与隐私

每个工作区的数据在 `<数据目录>/<工作区 ID>/`。数据目录、工作区目录、`profile/`、`artifacts/` 和运行时目录在使用前都会检查：
必须是 daemon 用户自己的真实目录（不能是符号链接），并设为 0700，否则拒绝启动并说明原因。插件写的 JSON 文件为 0600：

| 路径 | 内容 |
| --- | --- |
| `profile/` | Chromium Profile：Cookie、登录状态、历史和缓存。按私人浏览器数据保管。 |
| `state.json` | 控制模式、网页尺寸、设置、恢复计数和已打开标签的地址，用于恢复浏览器。地址只保存 HTTP/HTTPS，去掉账号密码、`#` 后的片段和疑似一次性凭据的查询参数（`code`、`state`、`token`、`session`、`sig`、`ticket`、`otp` 等），其他查询参数保留。 |
| `session.json` | 本机连接信息、工作区目录（用于限制上传）和随机令牌。令牌只对这个工作区的浏览器有效，每次启动更换；文件只给本机 MCP bridge 使用，浏览器停止时删除。 |
| `agent.json` | 关联的浏览器 Agent ID（只读取 4 KB 以内的普通文件）。 |
| `artifacts/` | Agent 工具自动命名保存的截图、快照和日志；超过 48 小时或总量超过 256 MB 时自动清理较旧的文件（保留最新的一份和 5 分钟内的文件），也可在 **资源与恢复** 里立即按同样规则清理。 |

- 数据目录根部还有插件写入的 `mcp-bridge.mjs`。
- 网页下载的文件由 Playwright 为插件的浏览器连接建立的临时目录接收（系统临时目录下的 `playwright-artifacts-*`，只有 daemon 用户可读写），
  浏览器停止、重启或插件卸载时删除；daemon 被强制结束时可能留下，需要时手动清理。本版没有下载管理。
- **操作记录** 只在内存里保留本次插件运行中最后 12 次操作的来源、类型、状态和目标页面，不记录输入内容、Cookie 或网址查询参数。
- 画面、网页标题和地址只通过 Paseo 的连接发给你的客户端；插件不向其他服务发送数据。Agent 读取的网页文字、地址和截图会进入它的模型会话。
- 插件读取 daemon 的工作区列表和 Agent Profile（名称、provider、模型），只用于界面里的选择。
- **清理**：关闭浏览器或归档工作区都会保留 Profile。要删除登录状态和历史，先在面板 **关闭浏览器**，再删除对应的
  `<数据目录>/<工作区 ID>/`；删除整个数据目录会清掉所有工作区的浏览器数据。

## 网络与进程

- Chromium 以 daemon 用户身份无头运行，使用该用户的网络，可以打开主机能访问的任何 HTTP/HTTPS 地址，包括 `localhost`、局域网和其他私有网络地址；
  能使用这个 daemon 的人都可以通过它浏览。
- 其他协议、在地址里写账号密码的请求，以及链路本地和云服务器元数据地址（`169.254.0.0/16`、`fe80::/10`、`fd00:ec2::254`、`100.100.100.200`、
  `metadata.google.internal`）会被拒绝。这些地址在 Chromium 内部也无法解析，网页脚本、跳转、iframe 和表单同样访问不到；
  但通过 DNS 解析到这些地址的其他域名拦不住。
- Chromium 关闭了后台联网和组件更新。代理见上表。Chromium 只继承 PATH、HOME、语言、时区、临时目录、XDG 目录、代理和字体等必要的环境变量；
  运行时目录有 `lib/` 时才把它加入 `LD_LIBRARY_PATH`。
- 进程：每个运行中的工作区浏览器一个 Chromium；每个浏览器 Agent 会话一个 Node.js bridge 和一个 Playwright MCP 进程。
- Chromium 调试端口和插件控制接口只监听 `127.0.0.1`。控制接口需要 `session.json` 里该工作区的令牌；**调试端口没有认证**，
  同一主机上的其他用户和进程可以连上浏览器并绕过手动接管，请不要在与他人共用的主机上使用。
- 默认开启 Chromium 沙箱：网页进程在独立的用户命名空间和系统调用过滤中运行。主机不支持时自动改用 `--no-sandbox`，
  并在页面诊断里提示；`PASEO_SERVER_BROWSER_SANDBOX` 可以强制开或关。
- Agent 的每次操作都持有一个租约：浏览器 Agent 放弃等待的申请不会留下租约，2 分钟没有续期的租约自动失效，
  Agent 新开标签页时租约保留到页面加载完成或超时。读取标题、测量宽度和读取正文都有各自的时限，关闭浏览器不会排在卡住的操作后面。
- 这不是对本机全权限 Agent 的安全沙箱：授权的本地进程仍有自己的系统权限。

## 恢复与限制

- 浏览器意外退出后按 1、3、8 秒退避，5 分钟内最多恢复 3 次；恢复已保存的 HTTP(S) 页面、窗口尺寸、固定状态和 Profile，
  不重放输入、点击或表单提交。用户主动“关闭浏览器”后不自动恢复。客户端断开不会停止浏览器。
- 尚未写盘的新 Cookie、未提交的表单和网页内存状态不能保证在崩溃后恢复。
- 只支持 Linux daemon 主机，已在 x86-64 + Chromium headless shell 上验证；自动查找只认 x86-64（`linux64`）的 headless shell，
  其他架构请用 `PASEO_SERVER_BROWSER_EXECUTABLE` 指定。
- 没有下载管理、音视频、剪贴板同步和完整的键盘快捷键映射。
- 企业 SSO、验证码以及站点是否允许服务器访问，需要按站点验证；诊断只检查当前页面，不访问其他站点。
- 原生 iOS/Android 的代码使用 React Native 组件，但测试在手机尺寸的网页里完成。

## 开发与测试

```sh
npm ci --ignore-scripts
npm run typecheck
npm test          # 单元测试与真实 Chromium + MCP 集成测试，需要上面的运行时；使用临时 Profile，结束后清理
npm run test:ui   # Playwright 在桌面 1120×760 和手机 390×844 下检查界面，数据来自模拟预览
```

- `npm run preview:build` 生成 `preview/dist/`（`node scripts/preview.mjs --serve` 在 `127.0.0.1:4196` 提供，可用
  `SERVER_BROWSER_PREVIEW_PORT` 改端口），不需要 daemon；数据与画面来自 `preview/fixtures.js` 和 `preview/fixtures/*.jpg`
  （由 `preview/make-frames.mjs` 渲染的虚构网页）。
- 缺少系统 Chromium 库的主机照常用 `LD_LIBRARY_PATH` 指向运行库；`BROWSER_TEST_EXECUTABLE` 可以指定测试用的 Chromium。
- `tests/live-*.mjs` 是连接真实 daemon 的验收脚本，不属于 `npm test`，必须显式指定工作区和 Profile，缺少配置时在连接前停止：

| 脚本 | 必填环境变量 | 操作范围 |
| --- | --- | --- |
| `live-agent-tabs-check.mjs`（`npm run test:agent-tabs`） | `BROWSER_TEST_WORKSPACE`、`BROWSER_TEST_LINKED_WORKSPACE`、`BROWSER_TEST_LINKED_PAGE_TITLE` | 只读核对两个已有会话及布局 |
| `live-ux-check.mjs`（`npm run test:ux`） | 同上 | 操作第一个工作区的演示页面，核对第二个会话保持 |
| `live-agent-check.mjs`（`npm run test:agent`） | `BROWSER_TEST_WORKSPACE`、`BROWSER_AGENT_PROFILE` | 创建或复用专用浏览器 Agent，执行演示交互和手动接管检查 |

两个工作区必须不同，ID 从目标 daemon 中选择。界面入口默认 `http://127.0.0.1:6767`，可用 `BROWSER_TEST_BASE_URL` 覆盖，
WebSocket 地址可用 `BROWSER_TEST_DAEMON_URL` 覆盖；数据目录按 `PASEO_SERVER_BROWSER_DATA` / `PASEO_SERVER_BROWSER_RUNTIME` 解析。
测试报告和截图写到 `artifacts/`，已被 `.gitignore` 排除。

## 许可

MIT，见 [LICENSE](LICENSE)。
