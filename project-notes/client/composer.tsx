import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { usePaseo, useRpc, type PluginButtonContentProps, type PluginScreenProps, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View, useWindowDimensions } from "react-native";
import { composerCapabilitiesRpc, composerSearchRpc, interpolateTemplate, noteContext, templateVariables, type ComposerNote } from "../shared/composer";
import { isOnItsWay, onItsWay, SEND_NOUN_LIMIT } from "../shared/deferred-rpc";
import { Badge, Banner, Button, EmptyState, SearchField, fontSize, hue, radius, space, toneColor } from "./kit";
import { FormField } from "./ui";
import { checkPromptSend, promptSource, serverCheck, type SendCheck } from "./composer-send";
import { DeferredList, useDeferredQueue } from "./deferred";
import { onItsWayLabel, notePromptKey, promptRecord, rememberUnanswered, requestId, settleRequest, unansweredId } from "./deferred-state";
import { findComposerDraft, type ComposerDraft, type ComposerUndo } from "./web";
import type { QuickEntry } from "../shared/quick";
import { quickNoteRpc } from "../shared/quick-settings";

function errorMessage(error: unknown) { return error instanceof Error ? error.message.slice(0, 500) : t("composer.operationFailed"); }

/** The host sizes its sheet from the first render: every state of the popover keeps this outer height. */
function usePopoverHeight(compact: boolean) {
  const { height: windowHeight } = useWindowDimensions();
  return Math.max(180, Math.min(compact ? 420 : 390, windowHeight * 0.8 - 96));
}

/** One delivery of a prompt at a time: the server's ledger keeps it, and every picker reads its list. */

export function PromptPicker({ theme, host, layout, agentId, initialQuery = "", initialNote = null, onClose, presentation = "screen" }: PluginSurfaceProps & { agentId?: string; initialQuery?: string; initialNote?: ComposerNote | null; onClose?: () => void; presentation?: "screen" | "popover" }) {
  const paseo = usePaseo(), search = useRpc(composerSearchRpc), capabilities = useRpc(composerCapabilitiesRpc), toast = useToast();
  const popoverHeight = usePopoverHeight(layout.compact);
  const [query, setQuery] = useState(initialQuery), [searchQuery, setSearchQuery] = useState(initialQuery);
  const [selected, setSelected] = useState<ComposerNote | null>(initialNote), [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [confirmation, setConfirmation] = useState<SendCheck | null>(null);
  const sending = useRef(false), [delivered, setDelivered] = useState(false);
  const [draft, setDraft] = useState<ComposerDraft | null>(() => presentation === "popover" ? findComposerDraft() : null);
  const [insertChoice, setInsertChoice] = useState<string | null>(null), [undo, setUndo] = useState<ComposerUndo | null>(null);
  // The ledger's record of what this picker sent or queued, followed until it is settled.
  const deferred = useDeferredQueue(host.id, agentId), [queuedId, setQueuedId] = useState<string | null>(null);
  const queued = queuedId ? deferred.all.find(view => view.messageId === queuedId) ?? null : null;
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(query), 180); return () => clearTimeout(timer); }, [query]);
  const library = useQuery({ queryKey: ["notes-composer", host.id, currentLanguage(), searchQuery], queryFn: () => search({ query: searchQuery, promptsOnly: true }), staleTime: 10_000, refetchOnWindowFocus: false, retry: false });
  const template = selected ? selected.body || selected.title : "";
  const variables = useMemo(() => templateVariables(template), [template]);
  const rendered = useMemo(() => interpolateTemplate(template, values), [template, values]);
  const ready = !!selected && !rendered.missing.length && !rendered.tooLong;
  const text = selected ? noteContext(selected, rendered.text) : "";
  const identity = selected ? notePromptKey(selected, rendered.text) : null;
  useEffect(() => {
    // Only the text it carries is settled by it: a preview edited since then is another prompt (recheck R8).
    if (!queued || !selected || queued.key !== identity) return;
    if (queued.state === "sent") setDelivered(true);
    // Nothing went out: the preview can be sent or queued again, as a new message.
    else if (queued.state === "canceled" || queued.state === "discarded" || queued.state === "expired") setQueuedId(null);
  }, [queued?.state, identity]);

  // One delivery of a prompt at a time. What the ledger lists for this text (from any picker or device) decides it:
  // on its way (queued, held for the user, being sent) locks sending; re-selecting or reopening finds the same state.
  const key = ready && agentId ? identity : null;
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
        const fresh = { ...await checkPromptSend(paseo, agentId, text, await capabilities({}), requestId(agentId, key!)), key: key! };
        if (fresh.plan.kind === "unavailable") { setConfirmation(null); setError(fresh.plan.note ?? t("composer.agentUnavailable")); return; }
        if (fresh.plan.kind === "confirm") { setConfirmation(fresh); return; }
        current = { ...fresh, consent: null };
      }
      // The server plans again from the agent as it is, and sends only while the consent still covers that. A request
      // of this prompt whose reply was lost (a queueing tried after this confirmation was shown, say) is the one to ask
      // about: its id goes instead of the confirmation's, so nothing goes out under a second id (review r4-F2).
      const sendKey = current.key ?? key!;
      const kept = unansweredId(agentId, sendKey);
      const sent = kept ? { ...current, messageId: kept } : current;
      const what = t("composer.prompt");
      // The kit RPC caps this optional noun at 10 code units. Longer translations use its localized "message" default.
      const result = await deferred.send({ text: sent.text, messageId: sent.messageId, key: sendKey, source: promptSource(selected.title), ...(what.length <= SEND_NOUN_LIMIT ? { what } : {}), consent: sent.consent }).catch((error: unknown) => {
        rememberUnanswered(agentId, sendKey, sent.messageId);
        throw error;
      });
      settleRequest(agentId, sendKey);
      if (result.status === "confirm") { setConfirmation(serverCheck(sent, result)); return; }
      setConfirmation(null);
      if ("message" in result) { setError(result.message); return; }
      setQueuedId(result.view.messageId);
      if (result.status === "sent") { setDelivered(true); toast.show(t("composer.sent"), { variant: "success" }); onClose?.(); }
      else if (result.view.messageId !== sent.messageId) toast.show(t("composer.promptState", { state: onItsWayLabel(result.view) }), { variant: "success" });
      else if (result.status === "sending") toast.show(t("composer.sendingAbove"), { variant: "success" });
      // Held (failed, or no answer from the agent): its row says what happened, with 仍然发送 and 取消.
    } catch (error) {
      setConfirmation(null); setError(t("composer.sendFailed", { error: errorMessage(error), help: t("composer.sendUnanswered") }));
    }
    finally { sending.current = false; setBusy(false); }
  };
  // Waiting interrupts nothing, so it needs no second tap. A new id (or the id of a send or queueing of this prompt whose
  // reply was lost, r3-F5), and the prompt's key: the copy already on its way (from any picker or device) answers
  // instead of a second one.
  const defer = async () => {
    if (!agentId || !ready || !selected || sending.current || delivered || waiting) return;
    sending.current = true; setBusy(true); setError(null);
    const messageId = requestId(agentId, key!);
    try {
      const view = await deferred.enqueue({ text, messageId, key: key!, source: promptSource(selected.title) }).catch((error: unknown) => {
        rememberUnanswered(agentId, key!, messageId);
        throw error;
      });
      settleRequest(agentId, key!);
      setConfirmation(null); setQueuedId(view.messageId);
      toast.show(view.messageId !== messageId ? t("composer.promptState", { state: onItsWayLabel(view) }) : view.state === "sent" ? t("composer.sent") : t("composer.queued"), { variant: "success" });
    } catch (error) {
      // The confirmation still shown is now for this queueing's message: 中断并发送 asks about it, never under the id the
      // confirmation was made with (review r4-F2).
      setConfirmation(previous => previous ? { ...previous, messageId } : previous);
      setError(t("composer.queueFailed", { error: errorMessage(error) }));
    }
    finally { sending.current = false; setBusy(false); }
  };
  const copy = async () => {
    try { await copyText(rendered.text); toast.show(t("composer.copied"), { variant: "success" }); }
    catch (error) { setError(errorMessage(error)); }
  };
  const fillDraft = async (mode?: "replace" | "append") => {
    const previous = draft?.read();
    if (previous == null) { setDraft(null); setInsertChoice(null); await copy(); return; }
    if (!mode && previous) { setInsertChoice(previous); return; }
    const receipt = draft!.fill(rendered.text, insertChoice ?? previous, mode ?? "replace");
    setInsertChoice(null);
    if (!receipt) { setError(t("composer.draftChanged")); return; }
    setUndo(receipt); setError(null); toast.show(t("composer.filled"), { variant: "success" });
  };
  const undoFill = () => {
    if (!undo?.undo()) setError(t("composer.undoConflict"));
    else { setError(null); toast.show(t("composer.undone"), { variant: "success" }); }
    setUndo(null);
  };
  const choose = (item: ComposerNote | null) => {
    setSelected(item); setValues({}); setConfirmation(null); setError(null); setDelivered(false); setInsertChoice(null); setQueuedId(null);
    setDraft(presentation === "popover" ? findComposerDraft() : null);
  };
  return <View testID="prompt-picker" style={{ width: "100%", maxWidth: 640, minWidth: 0, minHeight: 0, ...(presentation === "popover" ? { height: popoverHeight, flexShrink: 0 } : { flexGrow: 1, flexShrink: 1, maxHeight: "100%" }), gap: space.sm, padding: layout.compact ? space.sm : space.md, backgroundColor: theme.colors.surface0 }}>
    <View style={{ flexDirection: "row", flexShrink: 0, alignItems: "center", justifyContent: "space-between", gap: space.sm }}>
      <Badge theme={theme} label={selected ? t("composer.previewTitle") : t("composer.libraryTitle")} tone="violet" icon="MessageSquareText" />
      {selected ? <Button theme={theme} label={t("composer.chooseAgain")} icon="ArrowLeft" size="sm" disabled={busy} onPress={() => choose(null)} /> : null}
    </View>
    <ScrollView key={`${selected?.id ?? "list"}:${confirmation ? "confirm" : "preview"}:${error ?? ""}`} testID="prompt-picker-scroll" keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexGrow: 1, flexShrink: 1, minHeight: 0, ...(presentation === "screen" ? { maxHeight: layout.compact ? 560 : 620 } : {}) }} contentContainerStyle={{ gap: space.md, paddingBottom: space.xs }}>
      {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
      {delivered ? <Banner theme={theme} tone="success" message={t("composer.sentNotice")} /> : null}
      {waiting && waitingView?.state === "held" ? <Banner theme={theme} tone="orange" icon="CircleHelp" message={t("composer.heldNotice")} /> : null}
      {uncertain && !error ? <Banner theme={theme} tone="warning" message={t("composer.uncertain")} /> : null}
      <DeferredList theme={theme} queue={deferred} />
      {!selected ? <>
        <SearchField theme={theme} value={query} onChangeText={value => setQuery(value.slice(0, 300))} placeholder={t("composer.searchPlaceholder")} accessibilityLabel={t("composer.searchLabel")} grow={false} />
        {library.isPending ? <ActivityIndicator color={hue(theme, "blue")} /> : null}
        {library.isError ? <Banner theme={theme} tone="danger" message={errorMessage(library.error)} action={{ label: t("composer.retry"), onPress: () => void library.refetch() }} /> : null}
        {!!library.data?.unavailable && <Banner theme={theme} tone="warning" message={t("composer.unavailableBoards", { count: library.data.unavailable })} />}
        {library.data?.items.map(item => <Pressable key={`${item.projectId}:${item.id}`} accessibilityRole="button" accessibilityLabel={t("composer.choosePrompt", { title: item.title })} onPress={() => choose(item)} style={({ pressed }) => ({ padding: space.md, gap: space.xs, borderWidth: 1, borderColor: toneColor(theme, "violet", "line"), borderRadius: radius.md, backgroundColor: pressed ? toneColor(theme, "violet", "soft") : theme.colors.surface1 })}>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{item.title}</Text>
          <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 19 }}>{item.body}</Text>
          <Text style={{ color: hue(theme, "violet", "text"), fontSize: fontSize.meta }}>{templateVariables(item.body).length ? t("composer.projectVariables", { project: item.projectName, count: templateVariables(item.body).length }) : item.projectName}</Text>
        </Pressable>)}
        {library.data?.items.length === 0 ? <EmptyState theme={theme} tone="violet" icon="MessageSquareText" title={t("composer.emptyTitle")} message={t("composer.emptyMessage")} /> : null}
        {library.data?.truncated ? <Text style={{ color: theme.colors.foregroundMuted }}>{t("composer.truncated")}</Text> : null}
      </> : <>
        {confirmation && !waiting ? <Banner theme={theme} tone="warning" message={confirmation.plan.confirm ?? t("composer.confirmSend")} /> : null}
        {confirmation?.offer && !waiting ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("composer.offerDescription", { label: confirmation.offer.label, note: confirmation.offer.note })}</Text> : null}
        {insertChoice !== null ? <Banner theme={theme} tone="warning" message={t("composer.draftChoice")} /> : null}
        <Text style={{ color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "600" }}>{selected.title}</Text>
        {!confirmation && variables.map(name => <FormField key={name} theme={theme} label={t("composer.variable", { name })} value={values[name] ?? ""} editable={!busy} maxLength={32000} onChangeText={value => { setValues(current => ({ ...current, [name]: value })); setConfirmation(null); setDelivered(false); setQueuedId(null); }} placeholder={t("composer.variablePlaceholder", { name })} />)}
        <View style={{ padding: space.md, borderRadius: radius.md, backgroundColor: toneColor(theme, "violet", "soft"), gap: space.sm }}>
          <Text style={{ color: hue(theme, "violet", "text"), fontSize: fontSize.meta }}>{t("composer.previewSource", { id: selected.id.slice(0, 8) })}</Text>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: fontSize.body, lineHeight: 22 }}>{rendered.text}</Text>
        </View>
        {rendered.tooLong ? <Banner theme={theme} tone="danger" message={t("composer.tooLong")} /> : null}
      </>}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("composer.instructions")}</Text>
    </ScrollView>
    {selected ? <View testID="prompt-picker-actions" style={{ flexDirection: "row", flexShrink: 0, flexWrap: "wrap", gap: space.sm, paddingTop: space.xs, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
      {insertChoice !== null ? <>
          <Button theme={theme} label={t("composer.cancelInsert")} onPress={() => setInsertChoice(null)} />
          <Button theme={theme} label={t("composer.replaceDraft")} tone="warning" onPress={() => void fillDraft("replace")} />
          <Button theme={theme} label={t("composer.appendDraft")} tone="info" onPress={() => void fillDraft("append")} />
      </> : confirmation && !waiting ? <>
          <Button theme={theme} label={confirmation.plan.label} tone="warning" busy={busy} disabled={!ready} onPress={() => void send(confirmation)} />
          {confirmation.offer ? <Button theme={theme} label={confirmation.offer.label} icon="Clock3" tone="info" disabled={busy || !ready} onPress={() => void defer()} /> : null}
          <Button theme={theme} label={t("composer.cancelSend")} disabled={busy} onPress={() => setConfirmation(null)} />
      </> : <>
        <Button theme={theme} label={layout.compact ? t("composer.copyShort") : t("composer.copy")} accessibilityLabel={t("composer.copy")} icon="Copy" variant="primary" disabled={!ready || busy} onPress={() => void copy()} />
        {draft ? <Button theme={theme} label={t("composer.fillDraft")} icon="TextCursorInput" tone="violet" disabled={!ready || busy} onPress={() => void fillDraft()} /> : null}
        {undo ? <Button theme={theme} label={t("composer.undoFill")} icon="Undo2" disabled={busy} onPress={undoFill} /> : null}
        {agentId && waiting ? <Button theme={theme} label={waitingLabel(waitingView!.state)} accessibilityLabel={waitingLabel(waitingView!.state)} icon={waitingView!.state === "sending" ? "Send" : "Hourglass"} tone="warning" disabled onPress={() => undefined} /> : agentId ? <Button theme={theme} label={layout.compact ? t("composer.sendAgentShort") : t("composer.sendAgent")} accessibilityLabel={t("composer.sendAgent")} icon="Send" tone="info" disabled={!ready || delivered} busy={busy} onPress={() => void send()} /> : null}
      </>}
    </View> : null}
  </View>;
}

/** The disabled stand-in for 发送 while this prompt is on its way. */
function waitingLabel(state: string) { return state === "held" ? t("composer.held") : state === "sending" ? t("composer.sending") : t("composer.waiting"); }

export function PromptPopover(props: PluginButtonContentProps & { quick?: Pick<QuickEntry, "projectId" | "itemId"> }) {
  const agentId = props.context === "agent" ? props.agentId : undefined;
  if (props.quick) return <QuickFill {...props} quick={props.quick} agentId={agentId} onClose={props.close} presentation="popover" />;
  return <PromptPicker {...props} presentation="popover" agentId={agentId} onClose={props.close} />;
}

/**
 * A quick prompt with {{variables}}: the picker opened on it, so the user fills them in and sends as usual. In its pill's
 * popover, or on the prompts screen when the 「一键 N」 menu opened it (`params.projectId` and `params.itemId`).
 */
function QuickFill(props: PluginSurfaceProps & { quick: Pick<QuickEntry, "projectId" | "itemId">; agentId?: string; onClose?: () => void; presentation: "screen" | "popover" }) {
  const { theme, host, quick, presentation } = props, load = useRpc(quickNoteRpc), height = usePopoverHeight(props.layout.compact);
  const note = useQuery({ queryKey: ["project-notes", "quick-note", host.id, currentLanguage(), quick.projectId, quick.itemId], queryFn: () => load({ projectId: quick.projectId, itemId: quick.itemId }), staleTime: 0, refetchOnWindowFocus: false, retry: false });
  if (note.data) return <PromptPicker key={note.data.id} {...props} initialNote={note.data} />;
  return <View style={[{ width: "100%", alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.lg, backgroundColor: theme.colors.surface0 },
    presentation === "popover" ? { maxWidth: 640, height, flexShrink: 0 } : { flexGrow: 1, flexShrink: 1 }]}>
    {note.isPending ? <ActivityIndicator color={hue(theme, "violet")} />
      : <Banner theme={theme} tone={note.isError ? "danger" : "warning"} message={note.isError ? errorMessage(note.error) : t("composer.quickGone")} />}
  </View>;
}
export function PromptScreen(props: PluginScreenProps) {
  const { agentId, query, projectId, itemId } = props.params ?? {};
  if (projectId && itemId) return <QuickFill key={`${agentId ?? ""}:${projectId}:${itemId}`} {...props} quick={{ projectId, itemId }} agentId={agentId} presentation="screen" />;
  return <PromptPicker key={`${agentId ?? ""}:${query ?? ""}`} {...props} agentId={agentId} initialQuery={query ?? ""} />;
}
