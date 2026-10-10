import type { PaseoApi } from "./paseo-types";
import { finalReplyAfter, replyAsksUser } from "../shared/reply";
import { normalizeTimelinePage, projectTimelineRows } from "../shared/timeline";
import type { StatsDirectory } from "./stats-directory";
import type { TelemetryStore } from "./telemetry";

export interface ReplyCheckOptions { now?: () => number; perRun?: number; intervalMs?: number; retryMs?: number }

/**
 * Reads the final reply of stopped Agents whose last turn the hooks never saw end (a queued follow-up, a plugin reload)
 * or that predate 待回复, a few per minute, each turn once. The live path is the turn-end hook; this only fills gaps.
 */
export function createReplyCheck(telemetry: Pick<TelemetryStore, "needsReplyCheck" | "recordReply">, directory: Pick<StatsDirectory, "agents" | "loaded" | "refresh">, options: ReplyCheckOptions = {}) {
  const now = options.now ?? Date.now, perRun = options.perRun ?? 6, interval = options.intervalMs ?? 60_000, retry = options.retryMs ?? 10 * 60_000;
  // A timeline that cannot be read is retried later instead of holding up the rest of the queue.
  const failedUntil = new Map<string, number>();
  let running = false, closed = false, last = -Infinity;

  async function run(paseo: PaseoApi): Promise<void> {
    await directory.refresh(paseo);
    if (closed || !directory.loaded) return;
    const due: Array<{ id: string; userAt: string; updatedAt: string | null }> = [];
    for (const agent of directory.agents) {
      if (due.length >= perRun) break;
      const userAt = agent.lastUserMessageAt;
      if (!userAt || agent.archivedAt || agent.status !== "idle" || agent.activeTurn || agent.pendingPermissions > 0) continue;
      if ((failedUntil.get(agent.id) ?? -Infinity) > now()) continue;
      if (await telemetry.needsReplyCheck(agent.id, userAt, agent.updatedAt)) due.push({ id: agent.id, userAt, updatedAt: agent.updatedAt ?? null });
    }
    for (const agent of due) {
      if (closed) return;
      try {
        const page = normalizeTimelinePage(await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 40, projection: "projected" }));
        const user = Date.parse(agent.userAt), updated = Date.parse(agent.updatedAt ?? "");
        const reply = finalReplyAfter(projectTimelineRows(page.rows), user);
        // Rows of a session loaded from disk carry the load time; the Agent's own last update bounds when its turn really ended.
        const at = reply ? new Date(Math.min(Date.parse(reply.at), Number.isFinite(updated) && updated >= user ? updated : Infinity)).toISOString() : null;
        await telemetry.recordReply(agent.id, agent.userAt, reply && at ? { at, asks: replyAsksUser(reply.text) } : null);
        failedUntil.delete(agent.id);
      } catch {
        failedUntil.set(agent.id, now() + retry);
      }
    }
  }

  return {
    /** Called from polled reads; runs at most once per interval and never overlaps itself. */
    refresh(paseo: PaseoApi): Promise<void> {
      if (closed || running || now() - last < interval) return Promise.resolve();
      last = now(); running = true;
      return run(paseo).catch(() => {}).finally(() => { running = false; });
    },
    close() { closed = true; },
  };
}
