import type { PluginServerContext } from "@getpaseo/plugin/server";
import { registerProviderSubagents } from "./server/provider-subagents";
import { TelemetryStore } from "./server/telemetry";
import { getTelemetry } from "./shared/telemetry";
import { getAnalytics } from "./shared/analytics";
import { createAnalyticsEnrichment } from "./server/analytics-enrichment";
import { registerInsights } from "./server/insights";
import { isInsightAgent } from "./server/insight-runner-lifecycle";
import type { PaseoApi } from "./server/paseo-types";
import { registerHistory } from "./server/history";
import { registerResults } from "./server/results";
import { registerPreferences } from "./server/preferences";
import { registerReadState } from "./server/read-state";
import { StatsStore } from "./server/stats-store";
import { StatsDirectory } from "./server/stats-directory";
import { registerTokens } from "./server/tokens";
import { registerDigest } from "./server/digest";
import { getStats } from "./shared/stats";
import { finalReplyText, replyAsksUser } from "./shared/reply";
import type { TimelineItem } from "./shared/timeline";
import { createReplyCheck } from "./server/reply-check";
import { registerSchedules } from "./server/schedules";
import { registerBackground } from "./server/background";

export default function contribute(server: PluginServerContext) {
  const telemetry = new TelemetryStore();
  const directory = new StatsDirectory();
  // Provider subagents that keep working after their parent's turn ended (后台执行中).
  const background = registerBackground(server, { directory });
  const stats = new StatsStore({ telemetry, agents: directory, background: background.tracker });
  const tokens = registerTokens(server, { directory });
  const removeDigest = registerDigest(server, { tokens: tokens.source, telemetry });
  // 定时运行 shares the once-a-minute Agent walk with 看板 and Token.
  const removeSchedules = registerSchedules(server, { directory });
  const statsRemovers: Array<() => void> = [];
  let statsClosed = false;
  const analytics = createAnalyticsEnrichment(telemetry);
  const removeProviderSubagents = registerProviderSubagents(server);
  const removeInsights = registerInsights(server);
  const removeHistory = registerHistory(server);
  const removeReadState = registerReadState(server);
  const removePreferences=registerPreferences(server);
  const removeResults=registerResults(server,async id=>(await telemetry.snapshot(id)).agents[0]??null,(id,reply)=>{void telemetry.recordReply(id,reply.userAt,{at:reply.at,asks:reply.asks});});
  const replyCheck = createReplyCheck(telemetry, directory);
  const observeWork = (paseo: PaseoApi, agent: { id: string }, record: () => unknown) => {
    void background.tracker.attach(paseo); tokens.discover(paseo);
    // Analysis helpers have their own usage; avoid counting their turns as productive work.
    // A failed label lookup must not drop the event: unknown counts as ordinary work.
    void isInsightAgent(paseo, agent).catch(() => false).then(insight => { if (!insight && !statsClosed) return record(); }).catch(() => {});
  };
  const removers = [
    server.on("agent.created", ({ agent }, { paseo }) => observeWork(paseo, agent, () => telemetry.record({ type: "created", agent }))),
    server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => observeWork(paseo, agent, () => telemetry.record({ type: "turn_started", agent, turnId }))),
    server.on("agent.turn_ended", ({ agent, turnId, outcome, timeline }, { paseo }) => observeWork(paseo, agent, async () => {
      // Only whether the final reply asks the user leaves this handler; its text is never stored.
      const reply = outcome.kind === "completed" ? finalReplyText(timeline as unknown as TimelineItem[]) : null;
      const event = await telemetry.recordEvent({ type: "turn_ended", agent, turnId, outcome: outcome.kind, asks: reply === null ? null : replyAsksUser(reply) });
      if (event) analytics.captureEnd(event, agent, paseo);
    })),
    server.on("agent.permission_requested", ({ agent, request }, { paseo }) => observeWork(paseo, agent, () => telemetry.record({ type: "permission_requested", agent, requestId: request.id }))),
    server.on("agent.permission_resolved", ({ agent, requestId, resolution }, { paseo }) => observeWork(paseo, agent, () => telemetry.record({ type: "permission_resolved", agent, requestId, allowed: resolution.behavior === "allow" }))),
    server.on("agent.archived", ({ agent }, { paseo }) => observeWork(paseo, agent, () => telemetry.record({ type: "archived", agent }))),
  ];
  // The backfill boundary is established before synchronous stats observation begins.
  void stats.ready.then(() => {
    if (statsClosed) return;
    statsRemovers.push(
      server.on("agent.turn_started", ({ agent }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "turn_started", agentId: agent.id }))),
      server.on("agent.turn_ended", ({ agent, outcome, timeline }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "turn_ended", agentId: agent.id, outcome: outcome.kind, timeline }))),
      server.on("agent.permission_requested", ({ agent, request }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_requested", agentId: agent.id, requestId: request.id }))),
      server.on("agent.permission_resolved", ({ agent, requestId }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_resolved", agentId: agent.id, requestId }))),
    );
  });
  server.handle(getStats, (input, { paseo }) => { void background.tracker.attach(paseo); tokens.discover(paseo); return stats.read(input, paseo); });
  server.handle(getTelemetry, (input, { paseo }) => { void background.tracker.attach(paseo); tokens.discover(paseo); void replyCheck.refresh(paseo); return telemetry.read(input); });
  server.handle(getAnalytics, (input, { paseo }) => { analytics.refreshRecent(paseo); return telemetry.analyticsRead(input); });
  return async () => {
    statsClosed = true;
    replyCheck.close();
    for (const remove of statsRemovers) remove();
    for (const remove of removers) remove();
    removeProviderSubagents();
    analytics.close();
    removeHistory();
    await Promise.all([removeInsights(), removeReadState(), removePreferences(), Promise.resolve(removeResults()), telemetry.close(), stats.close(), tokens.close(), removeDigest(), removeSchedules(), background.close()]);
  };
}
