import { t } from "../shared/text";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { deferredBadge, isOnItsWay, type DeferredSendResult, type DeferredView } from "../shared/deferred-rpc";
import { notesDeferred } from "../shared/composer";
import { deferredPollInterval, visibleDeferred } from "./deferred-state";
import { aria, Badge, Button, fontSize, hairline, radius, relativeTime, space, toneColor, withAlpha } from "./kit";
import { Breathe, Flash, useChangeCount } from "./motion";
import type { Consent } from "./send-plan";
import { useForeground } from "./use-foreground";

/**
 * This agent's prompts in the plugin's ledger, sent now or queued for 「等这一轮结束再发」: read when a picker opens, then
 * every 5 s only while one is on its way and the app is in front. Each action puts the server's answer straight into
 * the list; one without an answer reads the list again, which shows whether the server took it.
 */
export function useDeferredQueue(hostId: string, agentId: string | undefined) {
  const list = useRpc(notesDeferred.list), sendRpc = useRpc(notesDeferred.send), enqueueRpc = useRpc(notesDeferred.enqueue), cancelRpc = useRpc(notesDeferred.cancel), resumeRpc = useRpc(notesDeferred.resume);
  const queryClient = useQueryClient(), foreground = useForeground();
  const key = useMemo(() => ["project-notes", "deferred", hostId, agentId ?? ""] as const, [hostId, agentId]);
  const query = useQuery({ queryKey: key, queryFn: () => list({ agentId }), enabled: !!agentId, retry: false, staleTime: 2_000, refetchOnWindowFocus: false, refetchInterval: current => deferredPollInterval(current.state.data, foreground) });
  const put = useCallback((view: DeferredView | null) => {
    if (view) queryClient.setQueryData<DeferredView[]>(key, (previous = []) => [view, ...previous.filter(entry => entry.messageId !== view.messageId)]);
    void queryClient.invalidateQueries({ queryKey: key });
  }, [key, queryClient]);
  // Outcomes leave on their own after a while: render again when the next one is due.
  const [, setTick] = useState(0);
  const shown = visibleDeferred(query.data ?? []);
  useEffect(() => {
    if (shown.until === null) return;
    const timer = setTimeout(() => setTick(value => value + 1), Math.max(0, shown.until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [shown.until]);
  const [acting, setActing] = useState<string | null>(null), actingRef = useRef(false);
  const act = useCallback(async (messageId: string, call: () => Promise<DeferredView | null>) => {
    if (actingRef.current) return;
    actingRef.current = true; setActing(messageId);
    try { put(await call()); } finally { actingRef.current = false; setActing(null); }
  }, [put]);
  const send = useCallback(async (input: { text: string; messageId: string; key: string; source: string; what?: string; consent: Consent | null }): Promise<DeferredSendResult> => {
    if (!agentId) throw new Error(t("deferred.noAgent"));
    try {
      const result = await sendRpc({ agentId, ...input });
      put("view" in result ? result.view : null);
      return result;
    } catch (error) { put(null); throw error; }
  }, [agentId, put, sendRpc]);
  const enqueue = useCallback(async (input: { text: string; messageId: string; key: string; source: string }) => {
    if (!agentId) throw new Error(t("deferred.noAgent"));
    try {
      const view = await enqueueRpc({ agentId, ...input });
      put(view);
      return view;
    } catch (error) { put(null); throw error; }
  }, [agentId, enqueueRpc, put]);
  return {
    views: shown.views, all: query.data ?? [], acting, send, enqueue,
    cancel: (messageId: string) => act(messageId, () => cancelRpc({ messageId })),
    resume: (messageId: string) => act(messageId, () => resumeRpc({ messageId })),
  };
}
export type DeferredQueue = ReturnType<typeof useDeferredQueue>;

const ICONS: Record<DeferredView["state"], string> = { queued: "Hourglass", held: "CircleHelp", sending: "Send", sent: "CircleCheck", "maybe-sent": "CircleAlert", canceled: "Ban", discarded: "CircleX", expired: "TimerOff" };

/**
 * Amber and breathing while a prompt waits or is being sent, orange with 仍然发送 / 取消 when it needs you, a green flash
 * once it went out. Rows never nest buttons.
 */
export function DeferredList({ theme, queue }: { theme: PluginTheme; queue: DeferredQueue }) {
  const toast = useToast();
  if (!queue.views.length) return null;
  const run = (work: Promise<void>) => void work.catch((error: unknown) => toast.show(error instanceof Error ? error.message : String(error), { variant: "error" }));
  return <View testID="deferred-list" style={{ gap: space.xs + 2 }}>
    {queue.views.map(view => <DeferredRow key={view.messageId} theme={theme} view={view} busy={queue.acting === view.messageId}
      onCancel={() => run(queue.cancel(view.messageId))} onResume={() => run(queue.resume(view.messageId))} />)}
  </View>;
}

function DeferredRow({ theme, view, busy, onCancel, onResume }: { theme: PluginTheme; view: DeferredView; busy: boolean; onCancel: () => void; onResume: () => void }) {
  const { colors } = theme, badge = deferredBadge(view), waiting = isOnItsWay(view), changed = useChangeCount(view.state);
  const mark = <Badge theme={theme} label={badge.label} tone={badge.tone} icon={ICONS[view.state]} />;
  // A held prompt may be a send now that got no answer, not a queued one: plain 取消 there.
  const cancelLabel = view.state === "held" ? t("deferred.cancel") : t("deferred.cancelQueue");
  const cancel = <Button theme={theme} size="sm" label={cancelLabel} accessibilityLabel={t("deferred.rowLabel", { label: cancelLabel, text: view.source || view.preview })} icon="X" variant="ghost" disabled={busy} onPress={onCancel} />;
  return <View accessibilityLabel={t("deferred.rowLabel", { label: badge.label, text: view.source || view.preview })} {...aria({ live: "polite" })}
    style={{ overflow: "hidden", gap: space.xs + 2, padding: space.sm + 2, borderRadius: radius.md, borderWidth: hairline, borderColor: toneColor(theme, badge.tone, "line"), backgroundColor: toneColor(theme, badge.tone, "soft") }}>
    <Flash count={changed} color={withAlpha(toneColor(theme, badge.tone, "mark"), 0.35)} radius={radius.md} />
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
      {view.state === "queued" || view.state === "sending" ? <Breathe>{mark}</Breathe> : mark}
      <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>{view.source || view.preview || t("deferred.prompt")}</Text>
      <Text style={{ flexShrink: 0, color: colors.foregroundMuted, fontSize: fontSize.meta }}>{relativeTime(waiting ? view.createdAt : view.at)}</Text>
      {view.state === "queued" ? <View style={{ marginLeft: "auto" }}>{cancel}</View> : null}
    </View>
    {view.note && view.note !== badge.label ? <Text style={{ color: colors.foreground, fontSize: fontSize.meta, lineHeight: 17 }}>{view.note}</Text> : null}
    {view.state === "held" ? <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm }}>
      <Button theme={theme} size="sm" label={t("deferred.sendAnyway")} icon="Send" tone="warning" busy={busy} onPress={onResume} />
      {cancel}
    </View> : null}
  </View>;
}
