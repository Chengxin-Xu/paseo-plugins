import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { listProfiles } from "../shared/profiles";
import { useQuery } from "@tanstack/react-query";
import type { AgentRecord } from "../shared/model";
import { HANDOVER_LABEL, cancelResume, handoverKey, handoverPrompt, handoverTitle } from "../shared/resume";
import { quotaBaseOf, type ProviderBases } from "../shared/provider-bases";
import { defaultModelOf, providerModelId } from "../shared/provider-model";
import { aria, Badge, Banner, Button, MetaLine, Sheet, Skeleton, TextField, fontSize, hairline, hue, radius, space, withAlpha } from "./kit";
import { PaneLabel, Switch } from "./ui";

interface ProfileEntry { id: string; name: string; provider: string; model?: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> }
interface ProviderEntry { provider: string; status?: string; enabled?: boolean; label?: string; models?: { id: string; isDefault?: boolean }[] }
/** A profile as the sheet offers it: one on the same base as the stopped Agent likely draws on the same spent quota. */
interface Choice { profile: ProfileEntry; base: string; sameQuota: boolean; ready: boolean; note: string | null; provider: ProviderEntry | undefined }

/** Hand-overs made in this session, per stop: the card says where the work went. */
const handedOver = new Map<string, { agentId: string; profile: string }>();
export const handoverOf = (agentId: string, stopAt: string) => handedOver.get(`${agentId}:${stopAt}`) ?? null;

function choicesOf(profiles: readonly ProfileEntry[], providers: readonly ProviderEntry[] | undefined, agent: AgentRecord, bases: ProviderBases): Choice[] {
  const own = quotaBaseOf(agent.provider, bases);
  return profiles.map(profile => {
    const provider = providers?.find(entry => entry.provider === profile.provider), base = quotaBaseOf(profile.provider, bases);
    // Without the host's provider list the profile is offered as configured; a disabled or failing provider is not.
    const ready = !provider || provider.enabled !== false && provider.status !== "error" && provider.status !== "unavailable";
    const note = !ready ? provider?.enabled === false ? "Provider 已停用" : "Provider 暂时不可用" : provider?.status === "loading" ? "Provider 还在启动" : null;
    return { profile, base, sameQuota: base === own, ready, note, provider };
  }).sort((a, b) => Number(!a.ready) - Number(!b.ready) || Number(a.sameQuota) - Number(b.sameQuota));
}

/**
 * 交给另一个 Provider (opus-B23): after a usage limit, a new Agent in the same workspace, on a profile the user picks, picks up
 * the work. It gets a short first message (editable) that points at the original instead of pasting it: it reads it with
 * `paseo inspect` / `paseo logs`, looks at the workspace's changes and goes on. Profiles on the stopped Agent's own base are
 * shown greyed as 同一额度来源 (they may still be another account, so they stay selectable). The sheet states what is created
 * and what is sent; nothing happens until 新建并交接. One stop handed to one profile is one Agent (`idempotencyKey`).
 */
export function HandoverSheet({ theme, open, onClose, agent, stopAt, bases, resume, onHandedOver, onResumeCanceled }: { theme: PluginTheme; open: boolean; onClose: () => void;
  agent: AgentRecord; stopAt: string; bases?: ProviderBases;
  /** The original's resume still waiting, if any: handing over offers to cancel it. */ resume?: { scheduleId: string | null; wakeLabel: string } | null;
  onHandedOver?: (agentId: string) => void; onResumeCanceled?: () => void }) {
  const paseo = usePaseo(), toast = useToast(), cancel = useRpc(cancelResume), profileList = useRpc(listProfiles), { colors } = theme;
  const profiles = useQuery({ queryKey: ["agent-observatory", "handover", "profiles"], enabled: open, staleTime: 60_000, refetchOnWindowFocus: false, retry: 1,
    queryFn: async () => (await profileList({})).profiles as ProfileEntry[] });
  const providers = useQuery({ queryKey: ["agent-observatory", "handover", "providers"], enabled: open, staleTime: 60_000, refetchOnWindowFocus: false, retry: 1,
    queryFn: async () => ((await paseo.providers.snapshot()).entries ?? []) as ProviderEntry[] });
  const choices = useMemo(() => choicesOf(profiles.data ?? [], providers.data, agent, bases ?? {}), [profiles.data, providers.data, agent.provider, bases]);
  const [profileId, setProfileId] = useState<string | null>(null), [text, setText] = useState(""), [stopResume, setStopResume] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setText(handoverPrompt({ id: agent.id, title: agent.title })); setError(null); setStopResume(true); } }, [open, agent.id]);
  useEffect(() => {
    if (!open || choices.some(choice => choice.profile.id === profileId)) return;
    setProfileId((choices.find(choice => choice.ready && !choice.sameQuota) ?? null)?.profile.id ?? null);
  }, [open, choices]);
  const choice = choices.find(item => item.profile.id === profileId) ?? null;
  const workspace = agent.workspaceId, place = agent.workspaceName || agent.branch || agent.projectName;
  const start = async () => {
    if (!choice || !workspace || !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const { profile } = choice;
      // The SDK takes "provider/model": a profile without a model runs the provider's default one (shared/provider-model.ts).
      const model = profile.model || defaultModelOf(choice.provider?.models);
      const handle = await paseo.workspaces.ref(workspace).agents.create({
        config: { provider: providerModelId(profile.provider, model), ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), ...(profile.featureValues ? { featureValues: profile.featureValues } : {}) },
        prompt: text.trim(), title: handoverTitle(agent.title, agent.provider), labels: { [HANDOVER_LABEL]: agent.id }, idempotencyKey: handoverKey(agent.id, stopAt, profile.id) });
      handedOver.set(`${agent.id}:${stopAt}`, { agentId: handle.id, profile: profile.name });
      let note = "";
      if (resume && stopResume) {
        const result = await cancel({ agentId: agent.id, ...(resume.scheduleId ? { scheduleId: resume.scheduleId } : {}) }).catch(() => null);
        note = result?.status === "canceled" ? "，原会话的续跑已取消" : "；原会话的续跑没能取消，请在停下卡片上再取消一次";
        if (result?.status === "canceled") onResumeCanceled?.();
      }
      toast.show(`已交给「${profile.name}」接着做${note}`, { variant: note.startsWith("；") ? "warning" : "success" });
      onHandedOver?.(handle.id); onClose();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason ?? "");
      setError(message.includes("agent_request_key_conflict") ? "这次停下已经用不同的内容交给过这个 Profile。为免重复新建，先在会话列表里看看交接出去的 Agent。"
        : message.includes("agent_request_outcome_unknown") ? "宿主没有确认新建的结果，可能已经建好了。先在会话列表里看看，再决定要不要重试。"
        : message || "新建失败，请重试");
    } finally { setBusy(false); }
  };
  const violet = hue(theme, "violet");
  return <Sheet title="交给另一个 Provider" open={open} onClose={onClose}>
    <MetaLine theme={theme} numberOfLines={3} parts={[`在同一工作区新建一个 Agent，接着做「${agent.title || "这个 Agent"}」没做完的事；原会话不会再收到消息`]} />
    {!workspace ? <Banner theme={theme} tone="warning" message="这个 Agent 没有工作区，没法在同一工作区新建；可以在 Paseo 里手动开一个会话接着做。" /> : null}
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme} icon="UserRoundCog" tone="violet">用哪个 Profile</PaneLabel>
      {profiles.isPending ? <Skeleton theme={theme} rows={2} /> : null}
      {profiles.error ? <Banner theme={theme} tone="danger" message={`Profile 读取失败：${profiles.error.message}`} /> : null}
      {profiles.data && !profiles.data.length ? <Banner theme={theme} tone="warning" message="主机上还没有 Profile；在 Paseo 设置里添加后再交接。" /> : null}
      <View accessibilityRole="radiogroup" style={{ gap: space.xs }}>
        {choices.map(item => {
          const selected = item.profile.id === profileId;
          return <Pressable key={item.profile.id} accessibilityRole="radio" accessibilityLabel={`Profile ${item.profile.name}${item.sameQuota ? "，同一额度来源" : ""}${item.note ? `，${item.note}` : ""}`}
            {...aria({ checked: selected, disabled: !item.ready || undefined })} disabled={!item.ready} onPress={() => setProfileId(item.profile.id)}
            style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: selected ? 1.5 : hairline,
              borderColor: selected ? violet : colors.border, backgroundColor: selected ? withAlpha(violet, 0.1) : state.pressed ? colors.surface1 : "transparent", opacity: !item.ready ? 0.45 : item.sameQuota && !selected ? 0.6 : 1 })}>
            <Icon name={selected ? "CircleCheck" : "Circle"} size={16} color={selected ? violet : colors.foregroundMuted} />
            <View style={{ flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 2 }}>
              <Text numberOfLines={1} style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: selected ? "700" : "500" }}>{item.profile.name}</Text>
              <MetaLine theme={theme} parts={[item.profile.provider, item.profile.model, item.profile.modeId ? `模式 ${item.profile.modeId}` : null]} />
            </View>
            {item.sameQuota ? <Badge theme={theme} label="同一额度来源" tone="amber" icon="BatteryWarning" /> : null}
            {item.note ? <Badge theme={theme} label={item.note} tone={item.ready ? "info" : "danger"} /> : null}
          </Pressable>;
        })}
      </View>
      {choice?.sameQuota ? <Banner theme={theme} tone="warning" message={`它和原会话都基于 ${choice.base}：如果用的是同一个账号，额度很可能也已经用完。`} /> : null}
    </View>
    <TextField theme={theme} label="第一条消息（可以改）" value={text} onChangeText={setText} multiline minHeight={200} />
    {resume ? <View style={{ gap: space.xs }}>
      <Banner theme={theme} tone="warning" icon="AlarmClock" message={`原会话还安排着 ${resume.wakeLabel} 的恢复后续跑；交接后两边会同时改同一个工作区。`} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Text style={{ flexGrow: 1, flexShrink: 1, color: colors.foreground, fontSize: fontSize.small }}>交接后取消原会话的续跑</Text>
        <Switch theme={theme} label="交接后取消原会话的续跑" value={stopResume} onChange={setStopResume} />
      </View>
    </View> : null}
    {choice && workspace ? <View style={{ gap: 4, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.surface1 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>确认后会</Text>
      <Text style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{`在工作区「${place}」用 Profile「${choice.profile.name}」（${providerModelId(choice.profile.provider, choice.profile.model || defaultModelOf(choice.provider?.models))}）新建「${handoverTitle(agent.title, agent.provider)}」，并把上面这条消息作为它的第一条消息发出。`}</Text>
    </View> : null}
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} label="取消" onPress={onClose} />
      <Button theme={theme} variant="primary" icon="ArrowRightLeft" label="新建并交接" busy={busy} disabled={busy || !choice?.ready || !workspace || !text.trim()} onPress={() => void start()} />
    </View>
  </Sheet>;
}
