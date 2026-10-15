import { t } from "../shared/text";
import type { PaseoApi } from "./paseo-types";

const insightIds = new Set<string>();
const observations = new WeakMap<PaseoApi, Map<string, { at: number; value: Promise<boolean> }>>();
export function markInsightAgent(id: string) { insightIds.add(id); }
export function isKnownInsightAgent(id: string) { return insightIds.has(id); }
/** 0.9 lifecycle payloads omit labels, so resolve them once per Agent without blocking hooks. */
export function isInsightAgent(paseo: PaseoApi, agent: { id: string; labels?: Record<string, string> }): Promise<boolean> {
  if (insightIds.has(agent.id) || agent.labels?.["observatory.role"] === "insight") { markInsightAgent(agent.id); return Promise.resolve(true); }
  if (agent.labels) return Promise.resolve(false);
  let cache = observations.get(paseo); if (!cache) { cache = new Map(); observations.set(paseo, cache); }
  const previous = cache.get(agent.id), now = Date.now();
  if (previous && now - previous.at < 60_000) return previous.value;
  const value = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const handle = paseo.agents.ref(agent.id);
      const current = handle.current();
      const snapshot = current ?? (await Promise.race([handle.refresh(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("serverInsightRunnerLifecycle.m001"))), 5000); timer.unref();
      })]))?.agent;
      if (!snapshot) throw new Error(t("serverInsightRunnerLifecycle.m002"));
      const insight = snapshot.labels?.["observatory.role"] === "insight";
      if (insight) markInsightAgent(agent.id);
      return insight || insightIds.has(agent.id);
    } finally { if (timer) clearTimeout(timer); }
  })();
  cache.set(agent.id, { at: now, value });
  if (cache.size > 4000) cache.delete(cache.keys().next().value!);
  void value.catch(() => cache?.delete(agent.id));
  return value;
}
