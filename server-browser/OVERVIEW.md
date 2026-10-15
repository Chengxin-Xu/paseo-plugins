# Server Browser

Server Browser runs Chromium on the Paseo daemon's machine and shows the same live page on your phone and computer. A browser Agent works on it through its own tools; a switch shows who is in control, and after you take over the Agent only sees screenshots and page text.

Each workspace has its own browser and profile; logins stay separate and survive restarts. The interface supports English, Simplified Chinese and user-defined languages.

## What it adds

- An overview of all workspace browsers and their states.
- A browser view with tabs, address bar, typing tray, device presets, reader, diagnostics and activity list, in the sidebar, workspace panels, the Command Center and `/server-browser`.
- Typing straight onto the page, input methods included; input meant for a page that has since changed is dropped, never replayed. The panel or the Agent answers web dialogs.
- In Agent mode, navigating asks first, switches to manual and acts only if the confirmed page is still there.
- Workspace service scripts open in a new tab.
- Archiving a workspace stops its browser and keeps its profile; leftovers of missing workspaces can be stopped or deleted, and a restored workspace's browser starts again.

## Setup

The plugin needs a Linux daemon host and Paseo 0.11.1 or later, and never installs software itself. Prepare the host once:

- Run `node scripts/setup-runtime.mjs` in the plugin folder (`paseo plugin ls --json` shows it). It installs the locked `runtime-deps/` tree (Playwright MCP 0.0.82, Readability, jsdom, Turndown) into `~/.local/share/paseo-server-browser` or `PASEO_SERVER_BROWSER_RUNTIME` with `npm ci`, install scripts disabled.
- Provide Chromium: Playwright's cached `chromium-headless-shell`, or a binary in `PASEO_SERVER_BROWSER_EXECUTABLE`.
- The runtime's optional `lib/` and `fonts.conf` supply missing libraries and fonts; Chinese pages need Chinese fonts.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Server Browser → Language picks one; English stands in for a missing translation. A translated copy of the bundled template in `~/.paseo/plugin-data/server-browser/locales/` adds a language. Web pages and saved agent replies keep their own language.

## Browser Agent

Connecting creates one Agent with your chosen profile and one MCP server, `server_browser`, and sends a short setup message; a closed browser Agent is reused.

`server_browser` is Playwright MCP behind the plugin's bridge, which:

- offers a fixed list of Playwright MCP 0.0.82 tools, without `browser_run_code_unsafe` (Node.js code on the host).
- after you take over, refuses writes and page structure, network and console reads, so typed passwords never reach the Agent; it never closes the browser.
- never shows request headers or bodies (submitted passwords, tokens), only responses; a tab's request list keeps what you sent while in control until the Agent navigates it.
- sends navigation through the panel's address rules and uploads only regular files inside the workspace folder.
- runs Playwright MCP in the workspace folder; saved files stay there or in `artifacts/`, readable only by the daemon user.

What the Agent reads, including every open tab's full address, enters its model conversation. Page snapshots show what is typed into form fields, passwords included, so submit login forms before handing back.

## Data on the host

Each workspace keeps its data in `~/.local/share/paseo-server-browser/visual/<workspace id>/` or under `PASEO_SERVER_BROWSER_DATA`, in real directories of the daemon user set to 0700.

- `profile/`: cookies, logins, history and cache.
- `state.json`: mode, size, settings and tab addresses for restoring, without credentials, fragments or parameters whose names look one-time (a heuristic).
- `session.json`: connection details and a per-start token for this browser only; one left by a crash is ignored and removed.
- `artifacts/`: files Agent tools save and, while an Agent session is attached, every tab's console output (`console-*.log`) and possibly page downloads under the site's file name, all deleted after 48 hours or beyond 256 MB.

Other downloads go to a temporary `playwright-artifacts-*` folder, deleted when the browser stops. The activity list keeps 12 actions in memory, without typed text or queries.

The plugin reads the daemon's workspace list and agent profiles, and keeps its language state, translation templates and the translations you add in `~/.paseo/plugin-data/server-browser/`. Frames, titles and addresses go only to your Paseo clients; error messages lose page addresses.

## Network and processes

- Chromium runs headless as the daemon user and reaches any HTTP or HTTPS address the host can, including `localhost` and private networks.
- Refused: other schemes, embedded passwords, and link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`), for page scripts, redirects and frames too, but not other names DNS resolves to them.
- Chromium follows the daemon's proxy variables, or `PASEO_SERVER_BROWSER_PROXY` without credentials, and inherits only basic environment variables.
- Processes: one Chromium per running browser, plus a Node.js bridge and Playwright MCP per Agent session.
- Chromium's sandbox is on where the host supports it, else diagnostics warn; `PASEO_SERVER_BROWSER_SANDBOX` forces it on (`1`) or off (`0`).
- After a crash the browser restarts (at most 3 times in 5 minutes) and reopens saved pages without repeating clicks or submissions.

## Limits

- Chromium's debugging port on 127.0.0.1 has no authentication: any local account that connects gets the profile's cookies and logins, runs scripts on logged-in sites and bypasses manual takeover. No command line shows the address, but `/proc/net/tcp` shows the port to every account (`hidepid` does not hide sockets); an authenticated pipe is deferred. Use a host you do not share.
- Linux only, tested on x86-64; elsewhere set `PASEO_SERVER_BROWSER_EXECUTABLE`.
- No download manager, audio, video or full keyboard mapping; paste is plain text, one way only.
- Typing stops whenever a frame loads a new document. Input methods were tested with simulated composition events.
- Single sign-on, captchas and server-blocking sites need checking per site. A crash can lose unsaved cookies and unsent forms.
