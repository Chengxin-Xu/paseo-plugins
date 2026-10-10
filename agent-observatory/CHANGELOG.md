# Changelog

## 2.11.0 — 2026-10-09

Open-source preparation. Existing installs keep what they show and store.

- Token 页 also finds the logs of custom providers that keep them elsewhere. A provider that extends Claude Code or Codex and sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in its `env`, on its command line (`NAME=…`) or in its launcher script adds that directory's `projects` / `sessions` folder. The daemon's provider config is read through the plugin API at most every 5 minutes; a launcher is read as text (at most 64 KB, no binaries, never run) for literal assignments only, and no other env value is read. A directory found after the first import counts its whole history once instead of taking older calls for copied history, and it is remembered across restarts. Providers that use the standard directories behave as before.
- 智能分析 has a new default for new installs, 自动选择: the Grok CLI when it is installed, otherwise an enabled Claude Code or Codex provider (then a custom provider that extends one) with its default model, run like a provider chosen by hand; other providers are never picked automatically. A saved choice, the Grok CLI included, is kept. Errors that suggested 改用内置 Grok 4.7 now point to 分析设置, and a queued job names the runner it waits for instead of Grok.
- Copy no longer names one particular setup's providers; the Token page's ⓘ explains which directories it reads.
- Manifest: display name, icon and screenshots; requires Paseo `>=0.11.1`, with the SDK packages pinned to 0.11.1. The `build` step is gone: the plugin has no runtime dependencies and Paseo compiles it, so a Git install no longer installs the development tools.
- New `OVERVIEW.md` (the registry listing page) and `NOTICE` (the MIT notice for the link-opening code 定时运行 adapts from panrafal's schedule-runs). The preview, its fixtures and the tests use invented projects, providers and models only.

## 2.10.0 — 2026-10-09

- 执行中 now includes sessions whose own turn has ended while their subagents keep working (后台执行中). Claude Code runs Task subagents in the background: the lead hands the work over, ends its turn and the subagent keeps going for many minutes. Paseo shows this as "1 working" and counts the workspace as running, but the observatory only knew the session's own status, so such a session was listed as 已完成 / 未读 / 空闲 and 执行中 showed one session too few. It is now 执行中 with a 后台 mark: a blue 「后台 · <task>」 chip on its row, 「后台 1:35」 where the turn timer would be (when the subagent's start is known), and a note in the detail header (这一轮已结束，后台还有 N 个子任务在执行) with 查看子任务. It no longer counts as 未读 / 待回复 / 需要处理 while the work goes on. Approvals, errors and sessions still starting keep their own state.
- Server: a tracker follows the host's `agent.provider_subagents.update` session events (`observeEvents`). It reads the per-Agent subagent list only after the stream opens or reconnects, every 10 minutes, and once a minute for Agents with running subagents (to catch an end it missed). That list makes the host load an Agent that is not loaded (ACP providers then replay the whole session and it looks freshly updated), so only Agents the directory shows as loaded — anything but 已关闭 — are ever asked. New `observatory.background.get` (revisioned; unchanged polls are a few bytes); the page reads it every 10 s while in the foreground and at once on directory activity (a turn that just ended). The page does not subscribe to subagent events itself: that stream carries every subagent's output rows, too much to relay to a phone.
- 看板's 执行中 / 未读 / 待回复 are current between directory walks (once a minute): a turn that started or ended since the walk counts from its lifecycle hook, a new Agent counts as soon as its turn starts, and an Agent still working in the background is 执行中 (not 未读 / 待回复). A hook-only turn older than the walk, whose Agent the walk no longer lists, is no longer counted. The board also refreshes on directory activity instead of only every 30 s.
- 执行中 (chip and status filter) also counts sessions still starting (启动中), as its list section already did.
- Detail: 结果 re-reads every 5 s only while the session's own turn runs; a session working only in the background labels its last reply 本轮结果.

## 2.9.1 — 2026-10-09

- Fix: 定时运行 showed no runs on a host whose schedule Agents belong to removed projects. Paseo 0.11's agent list (`paseo.agents.list`, the daemon's `fetch_agents`) leaves out every Agent whose workspace's project no longer exists, and every scheduled run gets a workspace of its own, so all runs of a schedule whose project was removed were invisible (the 2.9.0 checks read the records directly and missed it). The index now also reads Paseo's Agent records (`$PASEO_HOME/agents/<folder>/<id>.json`, read-only; the folders are listed at most once a minute and a record is parsed again only when it changes) for the Agents the host does not list that a schedule created, or that a schedule, a run or the ledger points at (a heartbeat's target). Their runs are listed and rebuilt again. The host cannot open those sessions or workspaces any more (it shows "Workspace 不可用"), so 运行详情 says so instead of offering 打开会话 / 打开工作区; 读取会话记录 stays.
- Fix: the ledger's temporary file is unique per write (two indexes sharing a directory overwrote each other's file and one rename failed with ENOENT), and stopping the plugin saves pending changes once and then stops the write timer. Tests close every index before removing their directories and collect warnings instead of printing them.

## 2.9.0 — 2026-10-09

- 定时运行 (new sidebar page, also 打开定时运行 in the Command Center): every run of every Paseo schedule on this host, newest first and grouped by day — 执行中 (blue, spinning, with a live timer), 成功, 失败 (red, with the error in Chinese: 工作目录已不存在 / Agent 在等你审批 / daemon 重启 / Provider 启动超时 / 会话无法恢复 …, the original text one tap away) and 结果未知. The header sums the last 7 days (runs, failures, success rate); 失败 / 执行中 / 成功 chips filter; schedule cards (last 10 runs as a health strip, cadence, next run, failures) filter to one schedule, and the header then names that schedule and sums its own week. Phones scroll the cards sideways, wider screens show one row and fold the rest behind 另外 N 个任务.
- A run's detail shows the reply the schedule recorded (headings, lists, quotes, code, bold and tappable links), the merge or pull request it mentions (GitLab-style merge requests as `!42`, GitHub PRs as `#128`, merged ones in violet), 打开会话 / 打开工作区, the schedule's prompt and the run facts. Runs without a recorded reply offer 读取会话记录, which loads the session only when tapped.
- Heartbeats (schedules that prompt an existing Agent) are hidden by default; the 心跳 chip or 更多 → 显示心跳 shows them, with the Agent they prompted (a failed heartbeat records no Agent, so its target is used).
- Cadences read 每天 09:30 / 工作日 09:00 / 每周五 18:00 / 每 30 分钟; a cron that runs in another time zone than the device's says so (每天 02:00（UTC）— Paseo runs zone-less crons in UTC).
- 30 days or 200 runs (plus 100 heartbeat runs) load first; the footer counts what is left out and 加载更早 reads up to 500 + 250. 查看全部运行 on a run older than the window loads the longer list by itself.
- Deleting a schedule deletes its run history in Paseo. The observatory now keeps a small ledger of each run's times, status, Agent and workspace ids, the first 300 characters of its error and its link, plus each schedule's name and cadence (never the reply or the prompt), so deleted schedules' runs stay listed (任务已删除). Runs from schedules deleted before 2.9 are rebuilt from the Agents Paseo labelled (`paseo.schedule-id` / `paseo.schedule-run`). The ledger keeps the newest 3000 runs within 400 days; a corrupt or oversized ledger is set aside as `schedule-ledger.corrupt-<time>.json` and rebuilt, and one that cannot be read is never overwritten.
- 会话 and 已归档会话 mark sessions a schedule created with a violet 定时 badge (they stay where they are). Their 结果 tab starts with a 定时任务 card (schedule, cadence, this run, duration, 查看全部运行 opens 定时运行 on that schedule). For archived ones the recorded reply is shown first without loading the session; 读取完整结果 loads it on demand (when nothing was recorded, e.g. the schedule was deleted before 2.9, the session is read as before). When a schedule Agent's session cannot be read (an ACP session that cannot be resumed, a missing log), its 结果 tab shows the recorded reply under a short notice instead of an error, and stops re-reading the session every 30 s until you tap 重试读取会话.
- A run that has just started can open its Agent right away, before the host directory (walked once a minute) names it.
- Results render Markdown lists (nested, numbered), quotes and links, and links open in the browser (http(s) only).
- 结果 shows known host errors in Chinese (e.g. 会话无法恢复：这个 ACP Agent 不支持重新载入 instead of "acp does not support ACP session resume"); other errors are shown as they are.
- Fix: on Paseo 0.11, pages opened from inside the plugin (查看全部运行, the 已归档会话 / 返回观测台 menu items) were titled with their ids (schedule-runs, archives, observatory). They now register with titles (`addScreen`, falling back to `addSurface` on older hosts).
- Server: `observatory.schedules.list` (revisioned; the window edge moves in 10-minute steps, so unchanged polls are a few bytes) and `observatory.schedules.run` (one run's recorded reply, prompt and row, read on demand). Schedules are read from `$PASEO_HOME/schedules/*.json` and workspace names from `projects/workspaces.json`, read-only and cached by modification time; Agents come from the shared one-minute directory walk. The page polls only while it is on screen and the app is in the foreground: every 10 s while a run is going, otherwise every 45 s.

## 2.8.0 — 2026-09-23

- 待回复 now means the Agent is asking you something: the final reply of its last turn hands the next step to you (要不要继续, which option, confirm, send the output …) and you have not answered yet. Before, 待回复 was the fallback for any stopped Agent whose turn end the plugin had missed, so finished sessions showed up there while real questions were shown as 已完成. An unopened question also counts as 需要处理; once you reply it clears.
- New 空闲 state (grey): stopped, and no result is known for its last turn.
- The server decides from the final reply when a turn ends and keeps only the yes/no, never the reply text. A turn whose end the hooks missed (a queued follow-up, a plugin reload) is read from the timeline tail within a minute if the session is loaded in the host, otherwise when you open it; it counts as completed when a final reply follows your last message. Sessions that are not loaded are never read in the background (the host would load and replay them).
- Fix: a turn end whose start was never delivered no longer leaves the session stuck on an older turn.
- 看板's 待回复 count uses the same rule as the session list (it used to count every stopped session you had read).

## 2.7.1 — 2026-09-23

- Fix: in the phone / foldable app the 会话 search box no longer overlaps the filter chips. The shared kit's search field used `flex: 1`, which on native layout collapses the row it sits in, so the chips were drawn over it (web was unaffected).
- Search text is no longer saved to the server or synced between devices. A search typed on one device (or left by an older version) emptied the list on the others; it now lasts for the current app session only. Named saved views still keep their search.

## 2.7.0 — 2026-09-23

- 智能分析 opens on a new 总览: for the last 7 / 30 days, a gradient hero with the headline, report / open-problem / resolved / blocked tiles, a daily health chart, problem types by severity, open problems and the Agents that need a look — all counted with your 仍存在 / 已解决 / 误判 marks.
- 建议: the analysing model reads the recent reports and writes cross-Agent themes (new / recurring / improving) and actionable suggestions with impact, effort, scope and the reports they rest on (tap to open). 复制指令 copies a rule for AGENTS.md / CLAUDE.md; 交给 Agent starts a new Agent in the chosen project's workspace with the chosen profile and an editable task; each suggestion can be adopted, done or dismissed. With automatic analysis on, suggestions refresh after 3 new reports (at most every 20 hours).
- Who analyses is your choice (分析设置): the built-in Grok 4.7 · xhigh stays the default; any Paseo profile, or a provider + model + thinking level, runs as a temporary sub-agent of the analysed Agent in its workspace, in the provider's safest mode (Codex read-only sandbox, Cursor Ask …) with every tool permission prompt denied, and is archived as soon as the report is written ("打开分析会话" shows it). 更多 → 换个模型分析 overrides it for one run.
- Automatic analysis is off by default; 2.7 switches earlier saved settings off once. Turn it back on in 分析设置.
- 发给这个 Agent: send one finding back to the analysed Agent as an editable follow-up message.
- Fix: Grok analyses no longer fail with "max turns reached" (10 of the last 74 reports did): the CLI gets up to 3 tool-less turns to repair output that misses the schema, and when a model writes its answer twice the last one that fits the schema is used. Chinese characters split between two output chunks no longer turn into "���".
- Server: `observatory.insights.overview` (revisioned roll-up, ~15 KB, unchanged polls ~100 B), `observatory.insights.suggest / suggestions / suggest-cancel / action-feedback` (suggestion jobs share the analysis queue and runner), `observatory.insights.runners / models` (profiles from the daemon config, providers from the cached provider snapshot — no provider probes); settings file version 2.

## 2.6.0 — 2026-09-23

- Token 页 (new tab): personal token statistics for 7 / 30 / 90 days from the local Claude Code and Codex session logs (custom providers that extend them included) — today's total with a live speed badge, a 实时流速 chart (10 s buckets over 30 or 60 minutes, output spread over each call's response time, sessions writing right now with their tok/s), KPI tiles (total, output, cache reads / writes, fresh input, cache hit rate, output speed, calls), daily stacked trend (总量 / 非缓存 / 输出 / 速率), composition donut, model / harness / project breakdowns, the sessions that used the most tokens, hour-of-day distribution and records. Calls are deduplicated across resumed and forked sessions; only counters, model names, working directories and session ids are kept.
- 复盘 (new agent-detail tab): the agent's whole execution folded server-side into key numbers, an 执行时间轴 Gantt (one row per kind of work — thinking, reading, searching, editing, commands, web, sub-agents, plans, approval waits — turns side by side with long idle gaps folded, tap a turn to zoom and a block for its details), 重点 (failed and then fixed tests, failure streaks, slowest commands, long thinking, approval waits, big edits, commits and pushes, sub-agents, compactions, the turn that used most tokens), 时间都去哪了, 按轮回顾 cards with a per-turn barcode, 命令与检查, 动过的文件 and per-call tokens. Every block, highlight and check jumps to its raw row in 时间线.
- Server: `observatory.tokens.get` / `observatory.tokens.live` read the provider logs incrementally in the background (hot files every 2 s, discovery every 30 s) into `tokens.json` (hourly buckets for 92 days, daily for 400); `observatory.digest.get` folds the host's projected timeline (tool start times are estimated from the preceding entry) into a revisioned payload under 59 KB.
- Running session rows show their live output speed (tok/s); 看板's hero links to today's tokens.
- Detail tabs scroll sideways on phones instead of clipping.

## 2.5.0 — 2026-09-23

- Six views in a colourful tab bar: 会话 · 看板 · 明细 · 横评 · 事件 · 分析. The selected view is a gradient pill; on phones the others are coloured icons (their names stay in the accessibility labels).
- 看板 (personal statistics for 7 / 30 / 90 days in your time zone): a gradient hero with today's turns and work time, streak, level and live counts (执行中 / 待审批 / 未读 / 待回复 open the matching sessions); eight KPI tiles with change against the previous period and sparklines; a year calendar heatmap; 18 growth badges and levels; a daily trend with a 7-day average and a weekday-baseline forecast; records (longest turn, busiest day, peak parallel Agents, busiest session, peak hour); a weekday × hour punchcard; the model mix as a donut.
- 明细: models, vendors, harnesses and projects ranked by turns, sessions, time, tool calls or code, with a top-three podium, a composition bar and per-row success rate, average turn, tools per turn, lines added/removed and context use; tools by kind and the most used tools; a time-and-output summary. 观测 keeps the earlier observation charts (activity heatmap, daily results, usage snapshots).
- 横评: two models, harnesses or vendors head to head — a score, a six-axis radar (产出 / 速度 / 稳定 / 自主 / 省心 / 活跃), earned titles (更稳 / 更快 / 更高产 …) and paired bars for 产出 / 效率 / 质量 / 投入; swap sides or pick either side.
- 事件: a 并行泳道 swimlane of the last 1 / 6 / 24 hours — one lane per Agent, turns as bars (green done, red failed, blue still running with a pulse), approval waits as amber strips, and the peak number of Agents working at once.
- 已完成 and 待回复 no longer look alike: every state has its own colour, glyph and label (待回复 violet speech bubble, 已完成 green check, 未读 pink, 待审批 amber, 异常 red, 执行中 blue), every waiting row carries a tag, a 待回复 quick scope was added, and 图例 explains the marks. `statusNames.idle` is now 待回复.
- Kit v3 palette: brighter neon-like shades on dark themes, new sky / lime / fuchsia hues, gradient and glow helpers; text colours keep ≥ 4.5:1.
- Server: `observatory.stats.get` returns a compact, revisioned statistics snapshot (unchanged polls cost a few bytes). Sessions come from Paseo's directory including archives; turns, time and parallelism from the plugin's own observation; messages, tool calls and edited lines from each turn's new timeline items. Persisted in `stats.json` with bounded history.

## 2.4.0 — 2026-09-23

- Vivid colours on the shared kit v2 palette instead of Paseo's muted status colours: running blue, waiting amber, failed red, done green, in dark and light themes (text variants keep ≥ 4.5:1).
- Every view has its own colour: 会话 blue, 数据洞察 violet, 事件流 orange, 智能分析 pink; detail tabs 结果 green, 时间线 blue, 子任务 violet, 诊断 orange, 分析 pink.
- Projects get a stable colour (`hueFor`, the same in every plugin): a dot in each session row, a coloured initial in the detail header, project sheets and project rankings; selected project chips take the project's colour.
- Section labels in results and diagnostics carry coloured icons; filter chips for states use the state colours; git parts (worktree, branch) are violet.
- Analytics: green activity heatmap (violet for output, red for failures), coloured headline numbers, vivid daily bars, project bars in project colours; the events pulse is orange.

## 2.3.0 — 2026-09-23

- Distinct status marks instead of same-looking dots: running is a turning blue ring with a per-second timer, approvals a filled amber mark that radiates, errors red, unread results a filled green check; idle, read, closed and canceled sessions are grey outlines with lighter titles. Running gets its own blue because Paseo's accent is the same green as success.
- Rows that need you or are running carry a coloured edge and a tinted pill (待审批 2, 异常, 未读, 失败 N 次, 久无更新). Group headers, quick-scope chips, sub-agent toggles, subtasks and the detail header's status pill use the same marks.
- Motion only where something happens: a row flashes in its new colour when its state changes, new events slide into the feed, running details show a sweeping progress bar, the 实时 dot radiates while live, analytics bars grow in when shown.
- Web animations are CSS keyframes (no JavaScript per frame); native uses the native driver. Loops pause in the background and stop entirely under the system's reduced-motion setting.

## 2.2.0 — 2026-09-23

- UI redesign on the shared plugin kit (`client/kit.tsx`): no hero, harvest banner or stat cards; the first session row now starts about 125 px below the top of the surface on phones and desktop, down from 650–700 px.
- One toolbar row: 会话 / 数据洞察 / 事件流 / 智能分析, search, and a “···” menu for archives, list/tree, sort order, expand all, snapshot export and refresh.
- Quick scopes 需要处理 / 执行中 / 未读 (plus 稍后处理 while anything is snoozed), project and time-range chips, a 筛选 sheet with saved views, and removable chips for applied filters.
- Sessions are grouped 需要处理 → 执行中 → 最近 by whole thread. Each row shows one badge (approval, repeated failure, error, unread/snoozed, quiet); unread descendants show on the sub-agent toggle.
- Detail: split view from 760 px, a pushed page with a bottom action bar on phones. 打开会话 (处理审批 / 恢复会话) is the one primary action, 已读并看下一个 sits next to it, the rest is in “···”. Only the runtime line re-renders on the clock.
- Explanations moved to ⓘ sheets, menu hints and the README; confirmations are toasts, errors are one-line banners with retry.
- Analytics restyled: single-hue heatmap with a 少→多 legend and 未采集 cells, thin daily bars in status colours with a legend, neutral project bars, two-column stats on phones.
- Additive preference field `focus` (`"all" | "attention"`), optional so views stored by older versions load unchanged and older servers ignore it.
- Preview uses the exact host themes, real Lucide icons, and host-like sheets and toasts; `lucide-react` added as a dev dependency.

## 2.1.0 — 2026-09-22

- Require Paseo `>=0.9.0`; SDK packages pinned to 0.9.0.
- Agent directory follows an owned 0.9 observation (`agents.list({ subscribe: {} })`, one-entry snapshot) instead of re-listing every agent every 5 s; full reads only on open, foreground, reconnect, a 10-minute safety interval, or 15 s fallback polling while no observation is available. Hidden views release it.
- Revisioned telemetry (unchanged or delta replies), analytics (unchanged replies carry the open coverage interval; only rendered usage samples are sent), read receipts, insight lists (content revision) and agent results.
- Analytics loads only while its tab is visible; `inactive` app state pauses polling like `background`; dashboard filters recompute only at range/snooze boundaries and rows are memoized.
- Timeline subscriptions follow 0.9 semantics: re-read after `subscription_restored`, re-subscribe with backoff after `error`, never stitch a non-contiguous tail.
- Raw IPC bridge: skip parsing unrelated host frames, fail in-flight requests immediately when the host closes the plugin session, hold new ones until it re-attaches.
- Persistence: idle heartbeats no longer rewrite and fsync `telemetry.json` every 30 s; unchanged usage samples and identical payloads are not written; the insight index is rewritten only when its content changes.

## 2.0.1 — 2026-09-17

- Keep Open Paseo conversation in the fixed detail header for every session state and tab, including unread result pages.
- Show navigation failures in the same visible header and remove duplicate navigation actions from scrolling content.

## 2.0.0 — 2026-09-17

- Results-first session and native subagent views: pinned initial input, latest reply, result evidence.
- Version-aware read-and-next queue, one-hour snooze, archive-read flow.
- Saved views and reading positions; independent scrollable filters.
- Shared bounded timeline cache, virtualized history/subtasks, attention-first directory paging.
- Archive/read provenance and background pagination correctness.
- Separate insight settings/index/reports, large-history migration, independent cooldown and skip retention.
- Lazy report loading, source freshness, incremental follow-ups and finding feedback.
- Online coverage intervals and project-attributed analytics.

## 1.2.0 — 2026-09-17

- Completed-unread harvest queue, native read acknowledgement and versioned receipts.

## 1.1.0 — 2026-09-17

- Separate archives, worktree/branch identity and responsive visual redesign.

## 1.0.0 — 2026-09-16

- Initial agent dashboard, lifecycle telemetry, nested subagents and AI trajectory review.
