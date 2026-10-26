# 服务器浏览器

服务器浏览器在 Paseo daemon 所在的机器上运行 Chromium，在你的手机和电脑上显示同一个实时页面。浏览器 Agent 通过自己的工具在上面操作；一个开关显示当前由谁控制，你接管之后，Agent 只能看到截图和页面文字。

每个工作区有自己的浏览器和 Profile；登录状态彼此独立，重启后仍然保留。界面支持英文、简体中文和用户自定义的语言。

## 新增功能

- 所有工作区浏览器及其状态的总览。
- 浏览器视图，带标签页、地址栏、输入栏、设备预设、阅读页面、页面诊断和操作记录；入口有侧栏、工作区面板、命令中心和 `/server-browser`。
- 直接在页面上打字，包括使用输入法；发往某个页面、而该页面随后已经变化的输入会被丢弃，从不补发。网页对话框由面板或 Agent 应答。
- Agent 模式下，导航会先询问，然后切到手动，只有所确认的页面仍在时才执行。
- 点一下就在新标签页打开工作区服务，或你的某个 Agent 开的端口；Agent 停止后仍被占用的端口显示为琥珀色。
- 归档工作区会停止它的浏览器，并保留它的 Profile；已经不在的工作区留下的浏览器可以停止或删除。

## 准备工作

插件要求 daemon 主机为 Linux、Paseo 为 0.11.1 或更高版本，且自身从不安装软件。主机需要准备一次：

- 在插件目录中运行 `node scripts/setup-runtime.mjs`（`paseo plugin ls --json` 会显示这个目录）。它用 `npm ci` 把锁定版本的 `runtime-deps/` 依赖树（Playwright MCP 0.0.82、Readability、jsdom、Turndown）安装到 `~/.local/share/paseo-server-browser` 或 `PASEO_SERVER_BROWSER_RUNTIME` 指定的目录，并禁用安装脚本。
- 准备 Chromium：Playwright 缓存中的 `chromium-headless-shell`，或 `PASEO_SERVER_BROWSER_EXECUTABLE` 指定的可执行文件。
- 运行时目录中可选的 `lib/` 和 `fonts.conf` 用来补充缺少的库和字体；中文网页需要中文字体。

## 语言

内置英文和简体中文。除非在「设置 → 插件 → 服务器浏览器 → 语言」中选定一种语言，否则使用设备语言；缺少翻译时用英文代替。在 `~/.paseo/plugin-data/server-browser/locales/` 中放一份翻译好的附带模板副本，就能添加一种语言。网页和已保存的 Agent 回复保留各自原来的语言。

## 浏览器 Agent

连接浏览器 Agent 时，会用你选择的 Agent Profile 创建一个 Agent，为它配置一个 MCP 服务器 `server_browser`，并发送一条简短的准备消息；已关闭的浏览器 Agent 会被复用。

`server_browser` 是经插件 bridge 转接的 Playwright MCP，这个 bridge：

- 提供一份固定的 Playwright MCP 0.0.82 工具清单，不含 `browser_run_code_unsafe`（在主机上运行 Node.js 代码）。
- 在你接管后拒绝写操作，也拒绝读取页面结构、网络请求和控制台记录，所以你输入的密码绝不会传到 Agent；它从不关闭浏览器。
- 从不显示请求头或请求正文（提交的密码、令牌），只显示响应；标签页的请求列表会保留你控制期间发出的请求，直到 Agent 在这个标签页导航。
- 让导航经过面板的地址规则，只上传工作区目录中的普通文件。
- 在工作区目录中运行 Playwright MCP；保存的文件留在那里或 `artifacts/` 中，只有 daemon 用户可读。

Agent 读到的内容，包括每个打开的标签页的完整地址，都会进入它的模型会话。页面快照会显示表单框中输入的内容，密码也包括在内，所以请先提交登录表单，再交还给 Agent。

## 主机上的数据

每个工作区的数据保存在 `~/.local/share/paseo-server-browser/visual/<workspace id>/` 或 `PASEO_SERVER_BROWSER_DATA` 指定的目录下，这些都是 daemon 用户自己的真实目录，权限设为 0700。

- `profile/`：Cookie、登录状态、历史和缓存。
- `state.json`：用于恢复的模式、尺寸、设置和标签页地址；地址不含账号密码、片段，也不含名字看起来是一次性的参数（启发式判断）。
- `session.json`：连接信息，以及只对这个浏览器有效、每次启动都更换的令牌；崩溃后留下的旧文件会被忽略并删除。
- `artifacts/`：Agent 工具保存的文件；Agent 会话连接期间，还有每个标签页的控制台输出（`console-*.log`），也可能有网页下载的文件。以上文件超过 48 小时或超出 256 MB 时都会删除。

其他下载存放在临时的 `playwright-artifacts-*` 目录中，浏览器停止时删除。操作记录在内存中保留 12 次操作，不含输入的文字和查询参数。

为了列出 Agent 开的端口，插件会在「服务与端口」或标签页面板打开时读取 /proc：daemon 用户的监听套接字、进程名和套接字链接；对占用端口的进程，只从它的环境变量中读取 PASEO_AGENT_ID 和 PASEO_AGENT_CWD。

插件会读取 daemon 的工作区列表和 Agent Profile，并在 `~/.paseo/plugin-data/server-browser/` 中保存语言状态、翻译模板和你添加的翻译。画面、标题和地址只发给你的 Paseo 客户端；错误信息会去掉网页地址。

## 网络与进程

- Chromium 以 daemon 用户身份无头运行，能访问主机可以访问的任何 HTTP 或 HTTPS 地址，包括 `localhost` 和私有网络。
- 拒绝：其他协议、地址中嵌入的密码，以及链路本地和云服务器元数据地址（169.254.0.0/16、fe80::/10、`fd00:ec2::254`、`100.100.100.200`、`metadata.google.internal`）；网页脚本、跳转和 iframe 也一样，但不包括通过 DNS 解析到这些地址的其他域名。
- Chromium 沿用 daemon 的代理环境变量，或使用不含账号密码的 `PASEO_SERVER_BROWSER_PROXY`，并且只继承基本的环境变量。
- 进程：每个运行中的浏览器一个 Chromium，另外每个 Agent 会话一个 Node.js bridge 和一个 Playwright MCP。
- 主机支持时开启 Chromium 沙箱，否则页面诊断会给出警告；`PASEO_SERVER_BROWSER_SANDBOX` 可强制开启（`1`）或关闭（`0`）。
- 崩溃后浏览器会重启（5 分钟内最多 3 次），并重新打开保存的页面，不会重复点击或提交。

## 限制

- Chromium 在 127.0.0.1 上的调试端口没有认证：本机任何账号只要连上它，就能拿到这个 Profile 的 Cookie 和登录状态，在已登录的网站上运行脚本，并绕过手动接管。任何命令行都不会显示这个地址，但 `/proc/net/tcp` 会向所有账号显示这个端口（`hidepid` 不隐藏套接字）；带认证的管道连接推迟到以后再做。请使用不与他人共用的主机。
- 只支持 Linux（已在 x86-64 上测试，支持 ARM64）；其他情况请设置 `PASEO_SERVER_BROWSER_EXECUTABLE`。
- 没有下载管理、音频、视频和完整的键盘映射；粘贴只支持纯文本，而且只能单向。
- 每当页面或其中的 iframe 加载新文档，输入都会停止。
- 单点登录、验证码和屏蔽服务器访问的网站需要逐站确认。崩溃可能丢失尚未保存的 Cookie 和尚未提交的表单。
