import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentRecord } from "../shared/model";
import type { HeartbeatSummary } from "../shared/schedules";
import { clockLabel } from "../shared/attention";
import { PENDING_RESUME, RESUME_PROMPT, RESUME_WINDOW_TEXT, cancelResume, getResumes, legacyResume, mergeResumes, quotaWindowReset, resumeFor, resumeLook, resumeTime, scheduleResume,
  type ResumeEntry, type ResumesState } from "../shared/resume";
import { getProviderBases, quotaBaseOf, type ProviderBases } from "../shared/provider-bases";
import { Button, MetaLine, Sheet, Spacer, aria, fontSize, hairline, radius, space } from "./kit";
import { PhasePill, hueColor, tint, tintAlpha, type Hue } from "./status";
import { Breathe, Enter, Ping } from "./motion";
import { useClock } from "./ui";
import { useForeground } from "./use-foreground";
import { useQuota } from "./use-quota";
import { HandoverSheet, handoverOf } from "./handover-sheet";

const HOUR = 3_600_000;
/** Without a reset time the user picks how long to wait (or the usage window's reset, when one is known); nothing is guessed for them. */
const WAITS = [1, 3, 5] as const;
type Wait = (typeof WAITS)[number] | "window";
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
/** 「约 6 小时后」 / 「约 40 分钟后」. */
function fromNow(at: number, now: number): string {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  return minutes < 60 ? `约 ${minutes} 分钟后` : `约 ${Math.round(minutes / 60)} 小时后`;
}
const resumesKey = (hostId: string | undefined, agentId: string) => ["agent-observatory", hostId ?? "host", "resume", agentId] as const;
/**
 * This Agent's resume as the server's ledger has it (scheduled → 已续跑 / 正忙稍后再试 / 未能确认 / 未能续跑), read while the card shows a
 * limit. While one waits it is read every 20 s (every 5 s around its wake time), else on open only; unchanged reads are a few bytes.
 */
export function useResume(hostId: string | undefined, agentId: string, enabled: boolean) {
  const rpc = useRpc(getResumes), cache = useQueryClient(), foreground = useForeground();
  const queryKey = resumesKey(hostId, agentId), active = enabled && foreground;
  return useQuery({
    queryKey,
    queryFn: async () => {
      const previous = cache.getQueryData<ResumesState>(queryKey);
      return mergeResumes(previous, await rpc({ agentId, ...(previous?.revision ? { revision: previous.revision } : {}) }));
    },
    enabled: active, retry: 1, staleTime: 15_000, refetchOnWindowFocus: false,
    refetchInterval: query => {
      const entry = query.state.data?.entries.find(item => item.agentId === agentId);
      if (!active || !entry || !PENDING_RESUME.has(entry.status)) return false;
      return Math.abs(Date.parse(entry.wakeAt) - Date.now()) < 3 * 60_000 ? 5000 : 20_000;
    },
  });
}
/** Which base each custom provider runs on (server/provider-bases.ts); cached for minutes. */
export function useProviderBases(enabled: boolean) {
  const rpc = useRpc(getProviderBases);
  return useQuery({ queryKey: ["agent-observatory", "provider-bases"], enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1, queryFn: async () => (await rpc({})).bases as ProviderBases });
}
/** The ledger's answer for this Agent, written straight into the cache after a schedule or a cancel. */
function storeEntry(cache: ReturnType<typeof useQueryClient>, hostId: string | undefined, entry: ResumeEntry | null | undefined): void {
  if (!entry) return;
  const key = resumesKey(hostId, entry.agentId), previous = cache.getQueryData<ResumesState>(key);
  // Without a revision the next read is a full one, so this local copy never hides the server's.
  cache.setQueryData<ResumesState>(key, { mode: "full", unchanged: false, revision: `local-${Date.now()}`, generatedAt: new Date().toISOString(), error: previous?.error ?? null,
    entries: [entry, ...(previous?.entries ?? []).filter(item => item.agentId !== entry.agentId)] });
  void cache.invalidateQueries({ queryKey: key });
}

/**
 * Why the latest turn stopped, on top of 结果 (opus-B2 / F13): a usage limit with its reset in device time, 恢复后续跑 (opus-B9)
 * with its real state from the server's ledger (已安排 → 正忙稍后再试 / 已续跑 / 未能确认续跑 / 未能续跑 / 你已接着做 / 心跳被改过,
 * cancellable right here, opus-F42) and 交给另一个 Provider (opus-B23); an empty turn, or a turn that stopped after a tool call. Nothing happens
 * on its own: resuming is a tap and a confirmation that states the exact wake time, handing over a tap and a sheet that states
 * what is created and sent.
 * `onScheduled` runs after the heartbeats changed (scheduled or cancelled); `hostId` keys the caches per host; `onHandedOver`
 * opens the new Agent.
 */
export function StopCard({ theme, agent, heartbeats, onOpenConversation, onScheduled, hostId, onHandedOver }: { theme: PluginTheme; agent: AgentRecord; heartbeats?: readonly HeartbeatSummary[];
  onOpenConversation?: () => void; onScheduled?: () => void; hostId?: string; onHandedOver?: (agentId: string) => void }) {
  const stop = agent.stop;
  const now = useClock(30_000), toast = useToast(), cache = useQueryClient(), cancel = useRpc(cancelResume);
  const [confirming, setConfirming] = useState(false), [handing, setHanding] = useState(false);
  // 取消续跑 asks once more inline; the question goes away on its own.
  const [arming, setArming] = useState(false), [canceling, setCanceling] = useState(false);
  useEffect(() => { if (!arming || canceling) return; const timer = setTimeout(() => setArming(false), 6000); return () => clearTimeout(timer); }, [arming, canceling]);
  // Shown at once after confirming when the server did not return its ledger entry (an older server).
  const [justScheduled, setJustScheduled] = useState<number | null>(null);
  const quota = !!stop && stop.kind === "quota" && !agent.archivedAt;
  const resumes = useResume(hostId, agent.id, quota);
  const bases = useProviderBases(quota && (handing || confirming));
  if (!stop || agent.archivedAt || agent.status === "running" || agent.status === "initializing") return null;
  if (stop.kind !== "quota") {
    const silent = stop.kind === "silent", hue: Hue = "amber";
    return <Card theme={theme} hue={hue} icon={silent ? "CircleDashed" : "CircleDotDashed"} title={silent ? "空轮" : "可能未收尾"}
      pill={<PhasePill theme={theme} hue={hue} label={clockLabel(stop.at, now)} />}
      text={silent ? "这一轮结束了，但没有任何文字、工具调用或推理输出。可以回到会话里让它重试。" : agent.stop?.closedMidTurn ? "宿主关闭会话时这一轮还没结束，可能还没做完。可以回到会话里让它接着做；看过后点「知道了」。" : "这一轮停在工具调用之后，没有收尾回复，可能还没做完。可以回到会话里让它接着做。"}
      actions={onOpenConversation ? <Button theme={theme} size="sm" tone={hue} icon="ArrowUpRight" label="打开会话" onPress={onOpenConversation} /> : null} />;
  }
  const reset = stop.resetAt ? Date.parse(stop.resetAt) : NaN, known = Number.isFinite(reset), guessed = known && stop.resetGuessed === true;
  const wake = known ? resumeTime(reset, now) : null, clock = (at: number) => clockLabel(at, now);
  // The ledger is the truth; a 2.13 heartbeat or the moment right after confirming fill in when it has nothing.
  const entry = resumeFor(resumes.data?.entries, agent.id, stop.at);
  const legacy = entry ? null : legacyResume(heartbeats, now, new Set(resumes.data?.entries.map(item => item.scheduleId)));
  const optimistic = !entry && !legacy && justScheduled !== null && justScheduled > now - 60_000 ? justScheduled : null;
  const look = entry ? resumeLook(entry, clock) : legacy || optimistic ? { hue: "pink" as const, icon: "AlarmClock", pill: `${clock(legacy?.at ?? optimistic!)} 续跑`,
    text: `已安排 ${clock(legacy?.at ?? optimistic!)} 自动续跑一次。`, cancellable: !!legacy, again: false, pending: true } : null;
  const waiting = !!look?.pending, handed = handoverOf(agent.id, stop.at);
  const hue: Hue = "orange";
  const resetText = known
    ? reset > now ? guessed ? `用量额度或限流让这一轮停下了。提示里没写时区，按本机时区推测 ${clock(reset)} 恢复（${fromNow(reset, now)}）。`
      : `用量额度或限流让这一轮停下了。按本机时区 ${clock(reset)} 恢复（${fromNow(reset, now)}）。` : `额度应已在 ${clock(reset)} 恢复，可以继续了。`
    : "用量额度或限流让这一轮停下了，回复里没有写明恢复时间。";
  const scheduleId = entry?.scheduleId ?? legacy?.scheduleId ?? null;
  const doCancel = async () => {
    setCanceling(true);
    try {
      const result = await cancel({ agentId: agent.id, ...(scheduleId ? { scheduleId } : {}) });
      storeEntry(cache, hostId, result.entry);
      if (result.status === "canceled") { toast.show("已取消续跑", { variant: "success" }); setJustScheduled(null); onScheduled?.(); }
      else toast.show(result.message, { variant: "warning" });
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "取消续跑失败"); }
    finally { setCanceling(false); setArming(false); }
  };
  const red = hueColor(theme, "red");
  const actions = <>
    {look && !look.again ? null : <Button theme={theme} size="sm" variant="primary" tone={hue} icon="AlarmClock"
      label={look?.again && entry?.status === "failed" ? "重新安排…" : wake ? `恢复后续跑 · ${clock(wake)} 唤醒` : "恢复后续跑…"} onPress={() => setConfirming(true)} />}
    {look?.cancellable && !arming ? <Button theme={theme} size="sm" tone="red" icon="AlarmClockOff" label="取消续跑" onPress={() => setArming(true)} /> : null}
    {handed ? onHandedOver ? <Button theme={theme} size="sm" tone="violet" icon="ArrowUpRight" label={`打开「${handed.profile}」接手的 Agent`} onPress={() => onHandedOver(handed.agentId)} />
      : <PhasePill theme={theme} hue="violet" icon="ArrowRightLeft" label={`已交给「${handed.profile}」接着做`} />
      : <Button theme={theme} size="sm" tone="violet" icon="ArrowRightLeft" label="交给另一个 Provider…" onPress={() => setHanding(true)} />}
    {onOpenConversation ? <Button theme={theme} size="sm" variant="ghost" icon="ArrowUpRight" label="打开会话" onPress={onOpenConversation} /> : null}
  </>;
  return <>
    <Card theme={theme} hue={hue} icon="BatteryWarning" title="额度用尽" pulse={!waiting}
      pill={<PhasePill theme={theme} hue={hue} solid label={known ? guessed ? `约 ${clock(reset)} 恢复` : `${clock(reset)} 恢复` : "恢复时间未知"} />}
      text={resetText}
      note={waiting ? `到点时它正忙或宿主不在线，会在 ${RESUME_WINDOW_TEXT}内自动再试，真正送出才算完成。` : look ? null
        : `续跑需要你确认：会建一个只运行一次的心跳，到点给这个 Agent 发一条续跑提示；没送出会在 ${RESUME_WINDOW_TEXT}内自动再试。安排后可以在这张卡片上取消。`}
      actions={actions}>
      {look ? <Enter active key={`${look.hue}:${look.pill}`}>
        <View testID="resume-state" {...aria({ live: "polite" })} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, backgroundColor: tint(hueColor(theme, look.hue), tintAlpha(theme)) }}>
          <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}>
            {look.hue === "blue" ? <Ping size={16} color={hueColor(theme, "blue")} /> : null}
            {/* A resume still waiting breathes; one that is waking the Agent pings. */}
            <Breathe active={look.pending && look.hue !== "blue"}><Icon name={look.icon} size={15} color={hueColor(theme, look.hue)} /></Breathe>
          </View>
          <PhasePill theme={theme} hue={look.hue} solid={look.hue !== "muted"} label={look.pill} />
          <Text style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 19 }}>{look.text}</Text>
        </View>
      </Enter> : null}
      {arming ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: hairline, borderColor: tint(red, 0.5), backgroundColor: tint(red, tintAlpha(theme) * 0.6) }}>
        <Text style={{ flexGrow: 1, flexShrink: 1, minWidth: 160, color: theme.colors.foreground, fontSize: fontSize.small }}>取消后到点不会再唤醒它，确定吗？</Text>
        <Button theme={theme} size="sm" variant="danger" icon="AlarmClockOff" label="确认取消续跑" busy={canceling} disabled={canceling} onPress={() => void doCancel()} />
        <Button theme={theme} size="sm" variant="ghost" label="不取消" onPress={() => setArming(false)} />
      </View> : null}
      {resumes.data?.error ? <MetaLine theme={theme} numberOfLines={2} parts={[resumes.data.error]} /> : null}
    </Card>
    <ResumeSheet theme={theme} open={confirming} onClose={() => setConfirming(false)} agent={agent} reset={known ? reset : null} guessed={guessed} hostId={hostId} bases={bases.data}
      onScheduled={(at, scheduled) => { if (scheduled) storeEntry(cache, hostId, scheduled); else setJustScheduled(at); onScheduled?.(); }} />
    <HandoverSheet theme={theme} open={handing} onClose={() => setHanding(false)} agent={agent} stopAt={stop.at} bases={bases.data}
      resume={waiting ? { scheduleId, wakeLabel: clock(Date.parse(entry?.wakeAt ?? "") || legacy?.at || optimistic || now) } : null}
      onHandedOver={onHandedOver} onResumeCanceled={() => { void cache.invalidateQueries({ queryKey: resumesKey(hostId, agent.id) }); onScheduled?.(); }} />
  </>;
}

function Card({ theme, hue, icon, title, pill, text, note, actions, pulse = false, children }: { theme: PluginTheme; hue: Hue; icon: string; title: string; pill?: ReactNode; text: string; note?: string | null;
  actions?: ReactNode; pulse?: boolean; children?: ReactNode }) {
  const color = hueColor(theme, hue);
  return <View testID="stop-card" style={{ gap: space.sm, padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: tint(color, 0.5), backgroundColor: tint(color, tintAlpha(theme) * 0.7) }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Breathe active={pulse}><Icon name={icon} size={16} color={color} /></Breathe>
      <Text style={{ color: hueColor(theme, hue, "text"), fontSize: fontSize.body, fontWeight: "800" }}>{title}</Text>
      <Spacer />
      {pill}
    </View>
    <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{text}</Text>
    {children}
    {note ? <MetaLine theme={theme} numberOfLines={3} parts={[note]} /> : null}
    {actions ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm }}>{actions}</View> : null}
  </View>;
}

/**
 * The confirmation: the exact wake time in device time (marked when the reset itself was a guess), the message the Agent will
 * get, and how a missed or busy wake is retried. Without a reset time: 1 / 3 / 5 hours, or the usage window's reset when the
 * host's 额度 knows it for this Agent's base (opus-B18).
 */
function ResumeSheet({ theme, open, onClose, agent, reset, guessed, hostId, bases, onScheduled }: { theme: PluginTheme; open: boolean; onClose: () => void; agent: AgentRecord; reset: number | null; guessed: boolean;
  hostId?: string; bases?: ProviderBases; onScheduled?: (at: number, entry: ResumeEntry | null) => void }) {
  const schedule = useRpc(scheduleResume), toast = useToast(), { colors } = theme;
  const [wait, setWait] = useState<Wait | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const now = useClock(30_000), zone = useMemo(deviceZone, []);
  useEffect(() => { if (open) { setWait(null); setError(null); } }, [open]);
  // The host's 额度, only while choosing without a reset time.
  const usage = useQuota(hostId ?? "host", open && reset === null);
  const windowReset = useMemo(() => reset === null ? quotaWindowReset(usage.data?.accounts, quotaBaseOf(agent.provider, bases), now) : null, [reset, usage.data, agent.provider, bases, now]);
  const target = (clock: number) => reset !== null ? resumeTime(reset, clock) : wait === "window" ? windowReset ? resumeTime(windowReset.resetAt, clock) : null : wait !== null ? resumeTime(clock + wait * HOUR, clock) : null;
  const at = target(now);
  const confirm = async () => {
    if (at === null) return;
    // The shown time comes from a clock up to 30 s old; one too close to now (the server wants 30 s ahead) moves to the next minute.
    const fresh = Date.now(), when = at >= fresh + 45_000 ? at : target(fresh) ?? at;
    setBusy(true); setError(null);
    try {
      const result = await schedule({ agentId: agent.id, at: new Date(when).toISOString(), ...(zone ? { timeZone: zone } : {}), title: agent.title.slice(0, 160), ...(agent.stop ? { stopAt: agent.stop.at } : {}) });
      if (result.status !== "scheduled") { setError(result.message); return; }
      const runAt = Date.parse(result.runAt ?? "") || when;
      // Another heartbeat wakes in the confirmed minute: the server moved it on, and its reply says to when (F2). Without a heartbeat
      // its create's answer was lost: the reply says the observatory checks for it (codex-obs-resume-recheck11-F3).
      const moved = Math.floor(runAt / 60_000) !== Math.floor(when / 60_000), unconfirmed = !result.scheduleId;
      toast.show(result.existing || moved || unconfirmed ? result.message : `已安排 ${clockLabel(runAt)} 续跑`, { variant: result.existing || unconfirmed ? "info" : "success" }); onScheduled?.(runAt, result.entry ?? null); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "安排续跑失败"); }
    finally { setBusy(false); }
  };
  const orange = hueColor(theme, "orange");
  const options: Array<{ value: Wait; label: string }> = [...(windowReset ? [{ value: "window" as const, label: `按额度窗口：${clockLabel(windowReset.resetAt, now)} 重置` }] : []), ...WAITS.map(value => ({ value, label: `${value} 小时后` }))];
  const basis = reset !== null ? guessed ? `提示里没写时区，按本机时区推测额度 ${clockLabel(reset, now)} 恢复，晚 2 分钟再唤醒` : `额度 ${clockLabel(reset, now)} 恢复，晚 2 分钟再唤醒`
    : wait === "window" && windowReset ? `按额度窗口推算：${windowReset.account} 的「${windowReset.window}」${clockLabel(windowReset.resetAt, now)} 重置，晚 2 分钟再唤醒` : null;
  return <Sheet title="恢复后续跑" open={open} onClose={onClose}>
    {reset === null ? <View style={{ gap: space.sm }}>
      <Text style={{ color: colors.foreground, fontSize: fontSize.body }}>回复里没有恢复时间。多久之后唤醒它？</Text>
      <View accessibilityRole="radiogroup" style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {options.map(option => { const selected = wait === option.value;
          return <Pressable key={String(option.value)} accessibilityRole="radio" accessibilityLabel={option.label} {...aria({ checked: selected })} onPress={() => setWait(option.value)}
            style={state => ({ paddingHorizontal: space.md, height: 32, justifyContent: "center", borderRadius: radius.full, borderWidth: selected ? 1.5 : hairline,
              borderColor: selected ? orange : colors.border, backgroundColor: selected ? tint(orange, tintAlpha(theme)) : state.pressed ? colors.surface1 : "transparent" })}>
            <Text numberOfLines={1} style={{ color: selected ? hueColor(theme, "orange", "text") : colors.foreground, fontSize: fontSize.small, fontWeight: selected ? "700" : "500" }}>{option.label}</Text>
          </Pressable>; })}
      </View>
      {windowReset ? <MetaLine theme={theme} numberOfLines={2} parts={[`「按额度窗口」按 ${windowReset.account} 的用量读数推算，账号对不上时会早或晚`]} /> : null}
    </View> : null}
    {at !== null ? <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>唤醒时间（本机时区{zone ? ` ${zone}` : ""}）</Text>
      <Text style={{ color: hueColor(theme, "orange", "text"), fontSize: 22, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{clockLabel(at, now)}</Text>
      <MetaLine theme={theme} numberOfLines={3} parts={[basis, fromNow(at, now)]} />
    </View> : null}
    <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>到点时「{agent.title || "这个 Agent"}」会收到</Text>
      <Text selectable style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface1 }}>{RESUME_PROMPT}</Text>
    </View>
    <MetaLine theme={theme} numberOfLines={5} parts={[`只运行一次。到点时它正忙或宿主不在线，会在 ${RESUME_WINDOW_TEXT}内自动再试，真正送出才算完成；在那之前你自己给它发了消息，就不再续跑。安排后可以在停下卡片上取消。`]} />
    {error ? <Text style={{ color: hueColor(theme, "fail", "text"), fontSize: fontSize.small }}>{error}</Text> : null}
    <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} label="取消" onPress={onClose} />
      <Button theme={theme} variant="primary" tone="orange" icon="AlarmClock" label={at !== null ? `确认 ${clockLabel(at, now)} 续跑` : "先选唤醒时间"} busy={busy} disabled={busy || at === null} onPress={() => void confirm()} />
    </View>
  </Sheet>;
}
