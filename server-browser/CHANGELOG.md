# Changelog

## 0.9.2 — 2026-10-10 (security hardening)

- The browser Agent's bridge offers a fixed list of Playwright MCP 0.0.82 tools and refuses every other tool, including ones a later MCP version adds; `tools/list` shows only the allowed ones. `browser_file_upload` and `browser_drop` accept only regular files whose real path is inside the workspace directory (no symbolic links) and pass the checked real paths on.
- Playwright MCP runs in the workspace directory and no longer receives the client's roots, so files that tools save by name stay in the workspace or the browser's `artifacts/`. The bridge starts it only from the runtime directory's `node_modules/@playwright/mcp/cli.js` and with basic environment variables only (no secrets, `NODE_OPTIONS`, proxy or `PLAYWRIGHT_MCP_*` settings).
- Agent navigation (`browser_navigate` and new tabs) goes through the panel's address rules on the server, and Playwright MCP gets the normalized address. Addresses with credentials and link-local or cloud metadata addresses (169.254.0.0/16, fe80::/10, `fd00:ec2::254`, `100.100.100.200`, `metadata.google.internal`) are refused. Chromium also gets host-resolver rules for them, so page scripts, redirects, frames and forms cannot reach them; host names that only resolve to them through DNS are not caught.
- Each workspace browser has its own control token, renewed at every start. A token works only for its own workspace, page reading and diagnostics included.
- Saved tab addresses lose their fragment and query parameters that look like one-time credentials (OAuth `code` and `state`, tokens, signatures, tickets, session ids, one-time passwords, magic links) before they are written to `state.json` and reopened. Other query parameters stay.
- Leases: a lease the bridge stopped waiting for is never handed out, a lease that is not renewed within 2 minutes expires, and an Agent's new tab keeps its lease until the page has loaded or timed out. The bridge and the control endpoint share one set of time limits (`server/budgets.ts`); the bridge always waits longer than the server works on a request.
- Page titles, the viewport probe, fit width, page reading and the login check in diagnostics have their own time limits, so a page stuck in a script no longer stalls polling. Stopping or restarting the browser no longer waits behind a stuck action.
- The data, workspace, profile, artifacts and runtime directories must be real directories owned by the daemon user and are set to 0700; otherwise the browser does not start and says why. `setup-runtime.mjs` checks the runtime directory the same way.
- Chromium's sandbox is on by default. When Chromium cannot start with it, the browser starts once more with `--no-sandbox`, remembers that for the plugin process and warns in page diagnostics. `PASEO_SERVER_BROWSER_SANDBOX=1` requires the sandbox and `0` turns it off.
- Chromium inherits an allowlisted environment (paths, locale, time zone, temporary and XDG folders, proxy and font settings, the setuid sandbox path), and the runtime's `lib/` joins `LD_LIBRARY_PATH` only when it exists. A `PASEO_SERVER_BROWSER_PROXY` with credentials is refused, because Chromium's command line is visible to other local users.
- Smaller fixes: releasing a lease switches the active tab only for a write lease in Agent mode; `agent.json`, `state.json` and `session.json` are read only as small regular files, never through a symbolic link, and the Agent id must be well formed; the overview and `browser.options` no longer send workspace directories to clients; the preview server answers a malformed request instead of crashing; the README and overview describe where downloads go and the remaining limits (unauthenticated debugging port, x86-64 headless shell lookup).

## 0.9.1 — 2026-10-10

- The host runtime is a locked dependency tree. `runtime-deps/package.json` and `runtime-deps/package-lock.json` ship with the plugin; `scripts/setup-runtime.mjs` copies them into the runtime directory and runs `npm ci --ignore-scripts --no-audit --no-fund`, so every host installs the same transitive dependencies. Before, only the four direct versions were pinned and `npm install` resolved the rest afresh. Setup stays manual and install scripts stay disabled; the runtime directory's `package.json` is replaced by the shipped one.

## 0.9.0 — 2026-10-10 (ready to publish)

- Require Paseo 0.11.1 and pin the 0.11.1 plugin, client and protocol SDKs. The manifest gains an English display name, a description, an icon and four screenshots for the plugin registry, and an `OVERVIEW.md` describes setup, data, network access and limits.
- No build command: the server code takes its workspace type from the host SDK instead of importing `@getpaseo/client`, so Paseo compiles a Git or registry install without installing development dependencies.
- The browser Agent's bridge no longer offers Playwright MCP's `browser_run_code_unsafe`, which runs arbitrary Node.js code in the MCP process, and refuses calls to it. Page JavaScript (`browser_evaluate`) and the other browsing tools are unchanged.
- A host without the prepared runtime or Chromium now gets setup guidance (`scripts/setup-runtime.mjs`, `PASEO_SERVER_BROWSER_RUNTIME`, `PASEO_SERVER_BROWSER_EXECUTABLE`) instead of a module or file error. `setup-runtime.mjs` also reports which Chromium the plugin will use and the optional `lib/` and `fonts.conf`.
- Page diagnostics describe the host truthfully: Chromium follows the daemon's `HTTP(S)_PROXY` / `ALL_PROXY`; host libraries and fonts no longer count as a warning; a new check reports whether Playwright MCP is installed; the CDP check shows whether Chromium's sandbox is on.
- New opt-in environment variables: `PASEO_SERVER_BROWSER_PROXY` sets a proxy for the shared Chromium only, and `PASEO_SERVER_BROWSER_SANDBOX=1` turns on Chromium's sandbox. Both are off by default, so existing browsers behave as before.
- Without a selected profile, a new browser Agent uses the first usable agent profile, as the panel already does, instead of looking for particular profile names.
- Tests and the live acceptance scripts follow `PASEO_SERVER_BROWSER_RUNTIME` and `PASEO_SERVER_BROWSER_DATA`.
- The preview fixture and its frames use fictional projects and pages. The README covers runtime setup, stored data and how to delete it, network access and security notes; internal design and verification notes stay out of the published package. The MIT notice names the plugin's contributors.

## 0.8.2 — 2026-09-23

- Fix: in the phone / foldable app the project and workspace search no longer overlaps the list below it. The shared kit's search field collapsed its row on native layout; web was unaffected.

## 0.8.1 — 2026-09-23

- Shared kit v3 palette: brighter, neon-like shades on dark themes, new sky / lime / fuchsia hues and gradient / glow helpers; text colours keep ≥ 4.5:1. No functional or layout changes.

## 0.8.0 — 2026-09-23 (colour)

- Colours carry the same meaning as in the other Paseo plugins: who is in control is violet (Agent) or amber (手动) on the switch, as a thin edge around the page and in the activity list; Agent work spins blue, approvals pulse amber, login walls are orange, errors red and stopped browsers gray.
- A project's colour comes from its name, as in every other plugin, replacing the theme-rotated project palette; the phone header, overview cards and rows and the workspace picker show the coloured project mark.
- Browser tabs show a live state mark (Agent at work, waiting for approval, needs login, error, taken over by you).
- Overview filters get moving marks and coloured counts, thumbnails a state pill, cards that need you a tinted border, phone sections a coloured project header; each card's accessible name includes its state.
- Menu and sheet icons are coloured by kind (view cyan, page size teal, reading indigo, diagnostics green, activity pink, Agent violet, open elsewhere blue) and 关闭浏览器 is red; diagnostics, activity, resources and page tabs use coloured result icons; stage and empty states sit on tinted tiles, and banners over the page get an opaque ground.
- Spinners and pulses reuse the observatory's motion helpers (paused in the background, off with reduced motion). Frame pacing, revision polling and visibility gating are unchanged.

## 0.7.0 — 2026-09-23 (UI redesign)

- Rebuild the viewer on the shared Paseo UI kit: two chrome rows on desktop (browser tabs, then navigation) and one row on phones instead of two tab strips, an address row and a status footer.
- Browser tabs become calm tabs with a project-colored dot; a new-workspace picker opens browsers for workspaces that have none yet.
- An explicit Agent / 手动 switch shows who is in control; re-selecting the current mode sends nothing, and a takeover that waits for the Agent's current step says so.
- Phones get a thumb-reach bottom bar (back, reload, address, page tabs, keyboard) only while in manual control; the typing tray docks under the page with Enter, Tab, Backspace, Select all, Esc and scroll keys.
- Page tabs move into a sheet behind a tab-count button; zoom and viewport readouts move into the ··· menu.
- Secondary tools (view and quality, reading, diagnostics, activity, resources, agent connection, stop) become host sheets reached from ···; stopping the browser asks for confirmation, confirmations become toasts.
- The all-browsers overview is a thumbnail grid on desktop (one small frame per page, never polled) and a grouped list on phones, with filters, search and state badges.
- Switching back to a browser shows its last frame dimmed until the live frame arrives; decision states (approval, login) appear as dismissible one-line banners.
- Add a synthetic preview (`npm run preview:build`) and Playwright UI tests (`npm run test:ui`); remove the obsolete 0.2/0.3 live UI scripts.

## 0.6.0 — 2026-09-22

- Require Paseo 0.9.0; pin the 0.9.0 plugin, client and protocol SDKs.
- Never block or fail an Agent session open: lifecycle hooks start browser restoration in the background, and the MCP bridge waits (bounded) for a browser that is still being restored.
- Size frames to the viewer: phones receive the visible viewport downscaled to their screen (device pixel ratio capped at 2), retried after scroll animations instead of falling back to full size.
- Pace frames by the link: one request in flight, never faster than twice the round trip, and lower JPEG quality automatically while changed frames arrive slowly.
- Omit unchanged data: frame polls carry a session revision and overview polls a content revision, so idle polls cost tens of bytes; overview summaries drop tab lists, settings, runtime and finished history.
- Poll only while visible (background, iOS inactive and hidden host tabs pause), relax overview polling to 5 s and remove the per-second re-render timer.
- Cache the workspace listing for 30 s with workspace lifecycle invalidation instead of listing every workspace on each frame and input.
- Open the current page on the viewer's device (system browser everywhere, Paseo's local browser on desktop) and pass `serverId` when opening the linked Agent.

## 0.5.0 — 2026-09-20

- Group the upper browser-session tabs by project, with stable shared colors and explicit Agent labels.
- Keep webpage tabs on the lower row, following the selected Agent's workspace browser.
- Preserve each workspace's existing webpage selection when switching viewer sessions.
- Represent sessions without a linked Agent as manual browsing; no synthetic Agent identities.

## 0.4.1 — 2026-09-20

- Check the website's own horizontal overflow after matching the viewer window.
- Include wide nested application panes and tables when computing the required viewport width.
- Add an explicit full-width action and use a 1440 × 900 desktop preset.
- Keep the result as a live viewport with unchanged page navigation and vertical scrolling.

## 0.4.0 — 2026-09-19

- Rework the interface around a bounded browser viewport instead of stacked dashboard cards.
- Move workspace browsing and secondary tools into drawers, retaining compact workspace and Agent context.
- Fit the full remote frame without cropping or enlarging pixels; make viewport matching an explicit action.
- Support desktop viewports up to 2560 × 1600 and preserve the chosen size across restarts.
- Improve keyboard access and keep remote resolution unchanged when another viewer connects.

## 0.3.0 — 2026-09-19

- Add a project/workspace browser overview with the explicitly associated Agent, current page and actual browser activity.
- Separate Agent lifecycle status from browser tool activity; add filters and search.
- Keep page ownership visible while scrolling and link directly to the associated Agent.
- Track the last 12 operations in memory, preserving their target identity without storing input content or URL credentials/query parameters.
- Inspecting or switching overview cards does not navigate pages or create new workspaces.

## 0.2.0 — 2026-09-19

- Add bounded crash recovery, background workspace restoration and persistent session settings.
- Use native Chromium TargetIDs; reject stale targets and protect pinned tabs and tab limits.
- Add read-only page/login/network diagnostics and clean article/visible-text reading via UI and MCP.
- Add adaptive frame quality, measured timing, touch scrolling and mouse wheel input.
- Add scoped artifact retention and runtime resource statistics.
- Preserve human takeover rules and separate browser tool namespaces.
- Validate with 8 integration tests, 19 real Paseo UI checks and actual Agent tool calls.

## 0.1.0 — 2026-09-19

- Initial Linux browser runtime with workspace profiles, Paseo image/input panel and shared MCP Agent.
