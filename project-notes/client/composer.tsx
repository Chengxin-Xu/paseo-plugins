import { usePaseo, useRpc, type PluginButtonContentProps, type PluginScreenProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from "react-native";
import { composerCapabilitiesRpc, composerSearchRpc, interpolateTemplate, noteContext, templateVariables, type ComposerNote } from "../shared/composer";
import { isOnItsWay, onItsWay } from "../shared/deferred-rpc";
import { Badge, Banner, Button, EmptyState, SearchField, fontSize, hue, radius, space, toneColor } from "./kit";
import { FormField } from "./ui";
import { checkPromptSend, promptSource, serverCheck, type SendCheck } from "./composer-send";
import { DeferredList, useDeferredQueue } from "./deferred";
import { onItsWayLabel, promptKey, promptRecord, rememberUnanswered, requestId, settleRequest, unansweredId } from "./deferred-state";
import { findComposerDraft, type ComposerDraft, type ComposerUndo } from "./web";

function errorMessage(error: unknown) { return error instanceof Error ? error.message.slice(0, 500) : "操作未完成，请重试。"; }

/** One delivery of a prompt at a time: the server's ledger keeps it, and every picker reads its list. */
const SEND_UNANSWERED = "如果上方列出了这条提示词，说明服务端已经收下，不要重发；没有列出可以再试，会按原来的编号重试，不会发两份。";
const UNCERTAIN = "这条提示词上次的发送结果不确定，可能已经送达。请先打开会话核对，再决定要不要重发。";

export function PromptPicker({ theme, host, layout, agentId, initialQuery = "", onClose, presentation = "screen" }: PluginSurfaceProps & { agentId?: string; initialQuery?: string; onClose?: () => void; presentation?: "screen" | "popover" }) {
  const paseo = usePaseo(), search = useRpc(composerSearchRpc), capabilities = useRpc(composerCapabilitiesRpc), toast = useToast();
  const { height: windowHeight } = useWindowDimensions();
  // The host sizes its sheet from the first render. Keep the outer height stable when selection or confirmation changes.
  const popoverHeight = Math.max(180, Math.min(layout.compact ? 420 : 390, windowHeight * 0.8 - 96));
  const [query, setQuery] = useState(initialQuery), [searchQuery, setSearchQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<ComposerNote | null>(null), [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmation, setConfirmation] = useState<SendCheck | null>(null);
  const sending = useRef(false), [delivered, setDelivered] = useState(false);
  const [draft, setDraft] = useState<ComposerDraft | null>(() => presentation === "popover" ? findComposerDraft() : null);
  const [insertChoice, setInsertChoice] = useState<string | null>(null), [undo, setUndo] = useState<ComposerUndo | null>(null);
  // The ledger's record of what this picker sent or queued, followed until it is settled.
  const deferred = useDeferredQueue(host.id, agentId), [queuedId, setQueuedId] = useState<string | null>(null);
  const queued = queuedId ? deferred.all.find(view => view.messageId === queuedId) ?? null : null;
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(query), 180); return () => clearTimeout(timer); }, [query]);
  const library = useQuery({ queryKey: ["notes-composer", host.id, searchQuery], queryFn: () => search({ query: searchQuery, promptsOnly: true }), staleTime: 10_000, refetchOnWindowFocus: false, retry: false });
  const template = selected ? selected.body || selected.title : "";
  const variables = useMemo(() => templateVariables(template), [template]);
  const rendered = useMemo(() => interpolateTemplate(template, values), [template, values]);
  const ready = !!selected && !rendered.missing.length && !rendered.tooLong;
  const text = selected ? noteContext(selected, rendered.text) : "";
  useEffect(() => {
    // Only the text it carries is settled by it: a preview edited since then is another prompt (recheck R8).
    if (!queued || !selected || queued.key !== promptKey(text)) return;
    if (queued.state === "sent") setDelivered(true);
    // Nothing went out: the preview can be sent or queued again, as a new message.
    else if (queued.state === "canceled" || queued.state === "discarded" || queued.state === "expired") setQueuedId(null);
  }, [queued?.state, text]);

  // One delivery of a prompt at a time. What the ledger lists for this text (from any picker or device) decides it:
  // on its way (queued, held for the user, being sent) locks sending; re-selecting or reopening finds the same state.
  const key = ready && agentId ? promptKey(text) : null;
  const waitingView = key ? onItsWay(deferred.all, agentId!, key) : null;
  const uncertain = !waitingView && !!key && promptRecord(deferred.all, agentId!, key)?.state === "maybe-sent";
  const waiting = !!waitingView && !delivered;
  // A send or queueing of this prompt whose reply was lost, ended in the server's list (review r4-F2): its record
  // settles this preview as the reply would have (sent: delivered; dropped: free to send again), the notice of a lost
  // reply goes, and only then is the request over. While it is on its way it locks the picker and its row says what to
  // do, and every try still asks about it.
  useEffect(() => {
    if (!agentId || !key) return;
    const kept = unansweredId(agentId, key);
    const record = kept ? deferred.all.find(view => view.messageId === kept) : null;
    if (!record || isOnItsWay(record)) return;
    setQueuedId(record.messageId); setConfirmation(null); setError(null);
    if (record.state === "sent") setDelivered(true);
    settleRequest(agentId, key);
  }, [deferred.all, agentId, key]);
  /** `check`: a confirmation the user said yes to, sent again with its text, id and consent. */
  const send = async (check?: SendCheck) => {
    if (!agentId || !ready || !selected || sending.current || delivered || waiting) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      let current = check;
      if (!current) {
        // A send of this prompt whose reply was lost goes again under its id (r3-F5).
        const fresh = await checkPromptSend(paseo, agentId, text, await capabilities({}), requestId(agentId, promptKey(text)));
        if (fresh.plan.kind === "unavailable") { setConfirmation(null); setError(fresh.plan.note ?? "这个 Agent 已不可用。"); return; }
        if (fresh.plan.kind === "confirm") { setConfirmation(fresh); return; }
        current = { ...fresh, consent: null };
      }
      // The server plans again from the agent as it is, and sends only while the consent still covers that. A request
      // of this prompt whose reply was lost (a queueing tried after this confirmation was shown, say) is the one to ask
      // about: its id goes instead of the confirmation's, so nothing goes out under a second id (review r4-F2).
      const kept = unansweredId(agentId, promptKey(current.text));
      const sent = kept ? { ...current, messageId: kept } : current;
      const result = await deferred.send({ text: sent.text, messageId: sent.messageId, key: promptKey(sent.text), source: promptSource(selected.title), what: "提示词", consent: sent.consent }).catch((error: unknown) => {
        rememberUnanswered(agentId, promptKey(sent.text), sent.messageId);
        throw error;
      });
      settleRequest(agentId, promptKey(sent.text));
      if (result.status === "confirm") { setConfirmation(serverCheck(sent, result)); return; }
      setConfirmation(null);
      if ("message" in result) { setError(result.message); return; }
      setQueuedId(result.view.messageId);
      if (result.status === "sent") { setDelivered(true); toast.show("提示词已发送", { variant: "success" }); onClose?.(); }
      else if (result.view.messageId !== sent.messageId) toast.show(`这条提示词${onItsWayLabel(result.view)}`, { variant: "success" });
      else if (result.status === "sending") toast.show("正在发送，见上方", { variant: "success" });
      // Held (failed, or no answer from the agent): its row says what happened, with 仍然发送 and 取消.
    } catch (error) {
      setConfirmation(null); setError(`没有收到发送结果：${errorMessage(error)}。${SEND_UNANSWERED}`);
    }
    finally { sending.current = false; setBusy(false); }
  };
  // Waiting interrupts nothing, so it needs no second tap. A new id (or the id of a send or queueing of this prompt whose
  // reply was lost, r3-F5), and the prompt's key: the copy already on its way (from any picker or device) answers
  // instead of a second one.
  const defer = async () => {
    if (!agentId || !ready || !selected || sending.current || delivered || waiting) return;
    sending.current = true; setBusy(true); setError(null);
    const messageId = requestId(agentId, promptKey(text));
    try {
      const view = await deferred.enqueue({ text, messageId, key: promptKey(text), source: promptSource(selected.title) }).catch((error: unknown) => {
        rememberUnanswered(agentId, promptKey(text), messageId);
        throw error;
      });
      settleRequest(agentId, promptKey(text));
      setConfirmation(null); setQueuedId(view.messageId);
      toast.show(view.messageId !== messageId ? `这条提示词${onItsWayLabel(view)}` : view.state === "sent" ? "提示词已发送" : "已排队，这一轮结束后自动发送", { variant: "success" });
    } catch (error) {
      // The confirmation still shown is now for this queueing's message: 中断并发送 asks about it, never under the id the
      // confirmation was made with (review r4-F2).
      setConfirmation(previous => previous ? { ...previous, messageId } : previous);
      setError(`未能排队：${errorMessage(error)}`);
    }
    finally { sending.current = false; setBusy(false); }
  };
  const copy = async () => {
    try { await copyText(rendered.text); toast.show("已复制，可粘贴到输入框继续编辑", { variant: "success" }); }
    catch (error) { setError(errorMessage(error)); }
  };
  const fillDraft = async (mode?: "replace" | "append") => {
    const previous = draft?.read();
    if (previous == null) { setDraft(null); setInsertChoice(null); await copy(); return; }
    if (!mode && previous) { setInsertChoice(previous); return; }
    const receipt = draft!.fill(rendered.text, insertChoice ?? previous, mode ?? "replace");
    setInsertChoice(null);
    if (!receipt) { setError("输入框内容已变化，请重新选择填入方式。"); return; }
    setUndo(receipt); setError(null); toast.show("已填入输入框，可继续编辑或撤销", { variant: "success" });
  };
  const undoFill = () => {
    if (!undo?.undo()) setError("输入框已有后续修改，已保留当前内容，未撤销。");
    else { setError(null); toast.show("已撤销填入", { variant: "success" }); }
    setUndo(null);
  };
  const choose = (item: ComposerNote | null) => {
    setSelected(item); setValues({}); setConfirmation(null); setError(null); setDelivered(false); setInsertChoice(null); setQueuedId(null);
    setDraft(presentation === "popover" ? findComposerDraft() : null);
  };
  return <View testID="prompt-picker" style={{ width: "100%", maxWidth: 640, minWidth: 0, minHeight: 0, ...(presentation === "popover" ? { height: popoverHeight, flexShrink: 0 } : { flexGrow: 1, flexShrink: 1, maxHeight: "100%" }), gap: space.sm, padding: layout.compact ? space.sm : space.md, backgroundColor: theme.colors.surface0 }}>
    <View style={{ flexDirection: "row", flexShrink: 0, alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
      <Badge theme={theme} label={selected ? "预览提示词" : "提示词库"} tone="violet" icon="MessageSquareText" />
      {selected ? <Button theme={theme} label="重新选择" icon="ArrowLeft" size="sm" disabled={busy} onPress={() => choose(null)} /> : null}
    </View>
    <ScrollView key={`${selected?.id ?? "list"}:${confirmation ? "confirm" : "preview"}:${error ?? ""}`} testID="prompt-picker-scroll" keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, ...(presentation === "screen" ? { maxHeight: layout.compact ? 560 : 620 } : {}) }} contentContainerStyle={{ gap: space.md, paddingBottom: space.xs }}>
      {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
      {delivered ? <Banner theme={theme} tone="success" message="提示词已发送。" /> : null}
      {waiting && waitingView?.state === "held" ? <Banner theme={theme} tone="orange" icon="CircleHelp" message="这条提示词需要你确认，见下方：可以「仍然发送」或取消。" /> : null}
      {uncertain && !error ? <Banner theme={theme} tone="warning" message={UNCERTAIN} /> : null}
      <DeferredList theme={theme} queue={deferred} />
      {!selected ? <>
        <SearchField theme={theme} value={query} onChangeText={value => setQuery(value.slice(0, 300))} placeholder="搜索提示词或项目" accessibilityLabel="搜索提示词" grow={false} />
        {library.isPending ? <ActivityIndicator color={hue(theme, "blue")} /> : null}
        {library.isError ? <Banner theme={theme} tone="danger" message={errorMessage(library.error)} action={{ label: "重试", onPress: () => void library.refetch() }} /> : null}
        {!!library.data?.unavailable && <Banner theme={theme} tone="warning" message={`${library.data.unavailable} 个看板暂不可用，其余提示词照常显示。`} />}
        {library.data?.items.map(item => <Pressable key={`${item.projectId}:${item.id}`} accessibilityRole="button" accessibilityLabel={`选择提示词：${item.title}`} onPress={() => choose(item)} style={({ pressed }) => ({ padding: space.md, gap: space.xs, borderWidth: 1, borderColor: toneColor(theme, "violet", "line"), borderRadius: radius.md, backgroundColor: pressed ? toneColor(theme, "violet", "soft") : theme.colors.surface1 })}>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{item.title}</Text>
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{item.body}</Text>
          <Text style={{ color: hue(theme, "violet", "text"), fontSize: fontSize.meta }}>{item.projectName}{templateVariables(item.body).length ? ` · ${templateVariables(item.body).length} 个变量` : ""}</Text>
        </Pressable>)}
        {library.data?.items.length === 0 ? <EmptyState theme={theme} tone="violet" icon="MessageSquareText" title="没有找到提示词" message="在项目手记中新建「提示词」，即可在这里选择。" /> : null}
        {library.data?.truncated ? <Text style={{ color: theme.colors.foregroundMuted }}>只显示前 40 条，请搜索缩小范围。</Text> : null}
      </> : <>
        {confirmation && !waiting ? <Banner theme={theme} tone="warning" message={confirmation.plan.confirm ?? "请确认发送"} /> : null}
        {confirmation?.offer && !waiting ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>「{confirmation.offer.label}」：{confirmation.offer.note}。</Text> : null}
        {insertChoice !== null ? <Banner theme={theme} tone="warning" message="输入框已有草稿，请选择替换或追加到末尾。可撤销本次填入。" /> : null}
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "600" }}>{selected.title}</Text>
        {!confirmation && variables.map(name => <FormField key={name} theme={theme} label={`变量：${name}`} value={values[name] ?? ""} editable={!busy} maxLength={32000} onChangeText={value => { setValues(current => ({ ...current, [name]: value })); setConfirmation(null); setDelivered(false); setQueuedId(null); }} placeholder={`填写${name}`} />)}
        <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: toneColor(theme, "violet", "soft"), gap: space.sm }}>
          <Text style={{ color: hue(theme, "violet", "text"), fontSize: fontSize.meta }}>预览 · 来源手记 #{selected.id.slice(0, 8)}</Text>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{rendered.text}</Text>
        </View>
        {rendered.tooLong ? <Banner theme={theme} tone="danger" message="填参后的提示词超过 32000 字符，请缩短变量内容。" /> : null}
      </>}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>选择后先预览。附件菜单可附加「项目手记」；使用 /notes 或 /prompt 前，请先移除输入框附件。</Text>
    </ScrollView>
    {selected ? <View testID="prompt-picker-actions" style={{ flexDirection: "row", flexShrink: 0, flexWrap: "wrap", gap: space.sm, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      {insertChoice !== null ? <>
          <Button theme={theme} label="取消填入" onPress={() => setInsertChoice(null)} />
          <Button theme={theme} label="替换草稿" tone="warning" onPress={() => void fillDraft("replace")} />
          <Button theme={theme} label="追加到末尾" tone="info" onPress={() => void fillDraft("append")} />
      </> : confirmation && !waiting ? <>
          <Button theme={theme} label={confirmation.plan.label} tone="warning" busy={busy} disabled={!ready} onPress={() => void send(confirmation)} />
          {confirmation.offer ? <Button theme={theme} label={confirmation.offer.label} icon="Clock3" tone="info" disabled={busy || !ready} onPress={() => void defer()} /> : null}
          <Button theme={theme} label="取消发送" disabled={busy} onPress={() => setConfirmation(null)} />
      </> : <>
        <Button theme={theme} label={layout.compact ? "复制" : "复制到剪贴板"} accessibilityLabel="复制到剪贴板" icon="Copy" variant="primary" disabled={!ready || busy} onPress={() => void copy()} />
        {draft ? <Button theme={theme} label="填入输入框" icon="TextCursorInput" tone="violet" disabled={!ready || busy} onPress={() => void fillDraft()} /> : null}
        {undo ? <Button theme={theme} label="撤销填入" icon="Undo2" disabled={busy} onPress={undoFill} /> : null}
        {agentId && waiting ? <Button theme={theme} label={waitingLabel(waitingView!.state)} accessibilityLabel={waitingLabel(waitingView!.state)} icon={waitingView!.state === "sending" ? "Send" : "Hourglass"} tone="warning" disabled onPress={() => undefined} /> : agentId ? <Button theme={theme} label={layout.compact ? "发送给 Agent" : "发送给当前 Agent"} accessibilityLabel="发送给当前 Agent" icon="Send" tone="info" disabled={!ready || delivered} busy={busy} onPress={() => void send()} /> : null}
      </>}
    </View> : null}
  </View>;
}

/** The disabled stand-in for 发送 while this prompt is on its way. */
function waitingLabel(state: string) { return state === "held" ? "待确认" : state === "sending" ? "发送中" : "已排队"; }

export function PromptPopover(props: PluginButtonContentProps) {
  return <PromptPicker {...props} presentation="popover" agentId={props.context === "agent" ? props.agentId : undefined} onClose={props.close} />;
}
export function PromptScreen(props: PluginScreenProps) {
  return <PromptPicker key={`${props.params?.agentId ?? ""}:${props.params?.query ?? ""}`} {...props} agentId={props.params?.agentId} initialQuery={props.params?.query ?? ""} />;
}
