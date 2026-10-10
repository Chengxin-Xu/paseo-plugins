# Server Browser

Server Browser runs Chromium on the Paseo daemon's machine and shows the same live page, as JPEG frames, on your phone and computer. A browser Agent can work on it through its own tools. A switch shows who is in control; after you take over, the Agent can only read the page.

Each workspace has its own browser and profile; logins stay separate and survive restarts. The interface and the browser Agent's instructions are in Simplified Chinese.

## What it adds

- An overview of all workspace browsers with states such as Agent at work, waiting for approval, login needed and error.
- A browser view with tabs, an address bar, a typing tray, page sizes, a Markdown or text reader, page diagnostics and an activity list, opened from the sidebar, a workspace panel, the Command Center or `/server-browser`.

## Setup

The plugin needs a Linux daemon host and Paseo 0.11.1 or later. It never downloads or installs software by itself. Prepare the host once:

- Run `node scripts/setup-runtime.mjs` in the plugin folder (`paseo plugin ls --json` shows it). It installs the locked tree in `runtime-deps/` (Playwright MCP 0.0.82, Mozilla Readability, jsdom, Turndown) into `~/.local/share/paseo-server-browser` or `PASEO_SERVER_BROWSER_RUNTIME` with `npm ci` from the host's npm registry, install scripts disabled.
- Provide Chromium: Playwright's `chromium-headless-shell` in the Playwright browser cache, or a binary set in `PASEO_SERVER_BROWSER_EXECUTABLE`.
- The runtime's optional `lib/` and `fonts.conf` supply missing libraries and fonts; Chinese pages need Chinese fonts.

Page diagnostics show whether Chromium, its sandbox, the Agent tools, fonts and proxy settings work.

## Browser Agent

Connecting a browser Agent creates one Agent with the profile you choose and one MCP server, `server_browser`, then sends a short setup message (one model turn). Other Agents are not changed.

`server_browser` is Playwright MCP behind a bridge script that the plugin writes into its data folder. The bridge:

- offers a fixed list of Playwright MCP 0.0.82 tools and refuses all others, so `browser_run_code_unsafe` (Node.js code on the host) and tools of later versions are unavailable.
- refuses writes after you take over and refuses to close the browser.
- sends navigation through the panel's address rules and gives Playwright MCP only the normalized address.
- uploads (`browser_file_upload`, `browser_drop`) only regular files whose real path is inside the workspace folder.
- runs Playwright MCP from the runtime folder only, in the workspace folder and with basic environment variables, so files that tools save stay in the workspace or `artifacts/`.

Remaining tools include page JavaScript, forms, console and network requests, and screenshots. Tool calls follow the Agent's permission settings. What the Agent reads becomes part of its model conversation.

## Data on the host

Each workspace keeps its data in `~/.local/share/paseo-server-browser/visual/<workspace id>/` or under `PASEO_SERVER_BROWSER_DATA`. Every folder the plugin uses, the runtime folder included, must be a real directory (not a symbolic link) owned by the daemon user; the plugin sets it to mode 0700, or refuses to start and says why.

- `profile/`: cookies, logins, history and cache.
- `state.json`: control mode, page size, settings and open tab addresses for restoring. Addresses keep no credentials, fragments or query parameters that look like one-time credentials (`code`, `state`, `token`, `session`, `sig` and similar).
- `session.json`: connection details, the workspace folder and a token that works only for this workspace's browser and changes at every start.
- `artifacts/`: files saved by Agent tools, deleted after 48 hours or beyond 256 MB.

Downloads go to a `playwright-artifacts-*` folder in the system temporary directory, deleted when the browser stops or the plugin unloads (a killed daemon can leave it behind). The activity list keeps 12 actions in memory, without typed text or query strings. To remove logins and history, close the browser and delete the workspace's folder.

The plugin reads the daemon's workspace list and agent profiles. Frames, titles and addresses go only to your Paseo clients.

## Network and processes

- Chromium runs headless as the daemon user with that user's network access: any HTTP or HTTPS address the host can reach, including `localhost` and private networks.
- Refused: other schemes, embedded passwords, and link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`). Chromium cannot resolve these either, so page scripts, redirects and frames cannot reach them. Other names that DNS resolves to them are not caught.
- Chromium follows the daemon's `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, or `PASEO_SERVER_BROWSER_PROXY` without credentials. It inherits only basic environment variables plus proxy and font settings.
- Processes: one Chromium per running browser, plus a Node.js bridge and Playwright MCP per browser Agent session.
- Chromium's sandbox is on by default. Where the host cannot run it, Chromium starts without it and diagnostics warn. `PASEO_SERVER_BROWSER_SANDBOX=1` requires it, `0` turns it off.
- After a crash the browser restarts (at most 3 times in 5 minutes) and reopens saved pages without repeating clicks or form submissions.

## Limits

- Chromium's debugging port listens on 127.0.0.1 without authentication, so other users and processes on the host can attach to the browser and bypass manual takeover. Use a host you do not share.
- Linux only, tested on x86-64. The automatic Chromium lookup only knows the x86-64 headless shell; elsewhere set `PASEO_SERVER_BROWSER_EXECUTABLE`.
- No download manager, audio, video, clipboard sync or full keyboard mapping.
- Single sign-on, captchas and sites that block servers need checking per site. A crash can lose unsaved cookies and unsent forms.
