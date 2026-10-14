import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ownTurnRunning, summarizeRequest, waitingKind, type AgentRecord, type PendingRequest } from "../shared/model";
import type { AgentResult } from "../shared/results";
import { object, string } from "../shared/timeline";
import { Badge, Banner, Button, EmptyState, MetaLine, Row, Skeleton, Spacer, fontSize, hairline, hue, radius, relativeTime, space, toneColor } from "./kit";
import { PaneLabel, monoFont } from "./ui";
import { CodeBlock } from "./timeline-view";
import { openExternalUrl } from "./open-url";
import { proseBlocks, proseTokens } from "../shared/prose";
import { permissionView } from "../shared/permissions";
import { PermissionPanel } from "./permission-panel";
import { QuickReplies } from "./quick-replies";
export interface ResultMessage { text: string; ref: string; at: string | null; completeOrigin?: boolean }
export type ResultData = AgentResult;

function Inline({ theme, text }: { theme: PluginTheme; text: string }) {
  return <>{proseTokens(text).map((token, key) => token.kind === "text" ? token.text
    : token.kind === "code" ? <Text key={key} style={{ fontFamily: monoFont, fontSize: fontSize.small, backgroundColor: theme.colors.surface2 }}>{` ${token.text} `}</Text>
    : token.kind === "bold" ? <Text key={key} style={{ fontWeight: "600" }}>{token.text}</Text>
    : <Text key={key} accessibilityRole="link" accessibilityHint="在浏览器打开" onPress={() => { void openExternalUrl(token.url).catch(() => {}); }} style={{ color: hue(theme, "blue", "text"), textDecorationLine: "underline" }}>{token.text}</Text>)}</>;
}

/** Selectable native text with light Markdown: headings, lists, quotes, code, bold and links (opened only on tap, http(s) only); nothing is executed. */
export function OutputText({ theme, text }: { theme: PluginTheme; text: string }) {
  const { colors } = theme;
  const body = { color: colors.foreground, fontSize: fontSize.content, lineHeight: 24 } as const;
  const chunks = text.split(/(```[\s\S]*?```)/g).filter(Boolean);
  return <View style={{ gap: space.md }}>{chunks.map((chunk, index) => {
    if (chunk.startsWith("```")) { const first = chunk.indexOf("\n"); return <CodeBlock key={index} theme={theme} label={chunk.slice(3, first).trim() || "代码"} value={chunk.slice(first + 1, -3)} />; }
    return proseBlocks(chunk).map((block, i) => {
      const key = `${index}:${i}`;
      if (block.kind === "heading") return <Text selectable key={key} accessibilityRole="header" style={{ color: colors.foreground, fontSize: block.level === 1 ? fontSize.heading : fontSize.title, fontWeight: "600", lineHeight: 26 }}><Inline theme={theme} text={block.text} /></Text>;
      if (block.kind === "quote") return <View key={key} style={{ borderLeftWidth: 3, borderLeftColor: colors.border, paddingLeft: space.md }}><Text selectable style={{ ...body, color: colors.foregroundMuted }}><Inline theme={theme} text={block.text} /></Text></View>;
      if (block.kind === "list") return <View key={key} style={{ gap: space.xs }}>{block.items.map((item, n) => <View key={n} style={{ flexDirection: "row", alignItems: "flex-start", gap: space.sm, paddingLeft: item.depth * space.lg }}>
        <Text style={{ ...body, minWidth: item.marker === "•" ? 10 : 18, color: item.marker === "•" ? hue(theme, "blue") : colors.foregroundMuted, fontWeight: "600" }}>{item.marker}</Text>
        <Text selectable style={{ ...body, flexGrow: 1, flexShrink: 1, minWidth: 0 }}><Inline theme={theme} text={item.text} /></Text>
      </View>)}</View>;
      return <Text selectable key={key} style={body}><Inline theme={theme} text={block.text} /></Text>;
    });
  })}</View>;
}

/** The first question stays pinned above the result while it scrolls; tap to read it in full. */
export function PinnedInput({ theme, message, confirmed, loading, inset }: { theme: PluginTheme; message: ResultMessage | null; confirmed: boolean; loading?: boolean; inset: number }) {
  const [expanded, setExpanded] = useState(false);
  const { colors } = theme;
  return <View style={{ paddingHorizontal: inset, paddingVertical: space.sm, gap: space.xs, backgroundColor: colors.surface0, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
    <Pressable accessibilityRole="button" accessibilityLabel={expanded ? "收起最初输入" : "展开最初输入"} accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)} hitSlop={{ top: 6, bottom: 4 }}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2, minHeight: 24 }}>
      <Icon name="Pin" size={12} color={toneColor(theme, "amber", "mark")} />
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}>最初输入</Text>
      {!confirmed && !loading ? <Badge theme={theme} label="起点待确认" tone="warning" /> : null}
      <Spacer />
      <Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
    </Pressable>
    <ScrollView style={{ maxHeight: expanded ? 180 : 44 }} nestedScrollEnabled scrollEnabled={expanded}>
      <Text selectable numberOfLines={expanded ? undefined : 2} style={{ color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{message?.text || (loading ? "正在读取…" : "宿主没有保留可确认的最初输入")}</Text>
    </ScrollView>
  </View>;
}

const outcomeBadge = { passed: { label: "通过", tone: "success", icon: "CircleCheck" }, failed: { label: "失败", tone: "danger", icon: "CircleX" }, unknown: { label: "未确认", tone: "neutral", icon: "CircleHelp" } } as const;
export function ResultView({ theme, agent, data, loading, error, header, lead, inset, compact = inset < space.xl, pending = 0, permissions = [], onResolvePermissions, onPermissionsChanged, onReplied, onOpenEvidence, onRefresh }: {
  theme: PluginTheme; agent: AgentRecord; data?: ResultData; loading: boolean; error?: string | null; header?: ReactNode; inset: number; compact?: boolean; pending?: number; permissions?: readonly Record<string, unknown>[];
  /** Shown before the reply, e.g. the 定时任务 card of an Agent a schedule created. */ lead?: ReactNode;
  onResolvePermissions?: () => void;
  /** A request was answered here (or found answered elsewhere): read the Agent's pending requests again. */ onPermissionsChanged?: () => void;
  /** A quick reply went out. */ onReplied?: () => void;
  onOpenEvidence: (ref: string) => void; onRefresh: () => void;
}) {
  const { colors } = theme;
  const toast = useToast();
  const reply = data?.latestReply;
  const state = ownTurnRunning(agent) || data?.isRunning ? "执行中" : data?.isFinal ? "本轮结果" : null;
  // 快捷回复 (opus-B26): only under the reply the category was read from, never for subagents (their parent answers them); they
  // answer this turn only (P1-1), and with the whole reply right above them they need no quote.
  const nudge = agent.replyNudge && !agent.parentAgentId && !agent.archivedAt && pending === 0 && !ownTurnRunning(agent) && !data?.isRunning ? agent.replyNudge : null;
  const copy = () => { if (!reply) return; void copyText(reply.text).then(() => toast.show("已复制最新回复", { variant: "success" })).catch(() => toast.error("复制失败，可长按选择文本")); };
  // The header slot is always rendered: web counts null children when indexing sticky headers, native drops them.
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: space.xxl }} stickyHeaderIndices={[1]}>
    <View style={{ paddingHorizontal: inset }}>{header}</View>
    <PinnedInput theme={theme} message={data?.firstInput ?? null} confirmed={data?.coverage.firstInputConfirmed === true} loading={loading} inset={inset} />
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg, gap: space.xl }}>
      {lead}
      {pending > 0 ? <PendingRequests theme={theme} agent={agent} pending={pending} permissions={permissions} compact={compact} onResolve={onResolvePermissions} onChanged={onPermissionsChanged} /> : null}
      {error ? <Banner theme={theme} tone="danger" message={error} action={{ label: "重试", onPress: onRefresh }} /> : null}
      <View style={{ gap: space.sm }}>
        <PaneLabel theme={theme} icon="MessageSquareText" tone="info" trailing={<MetaLine theme={theme} parts={[reply?.at ? relativeTime(reply.at) : null, state]} />}>最新回复</PaneLabel>
        {reply ? <>
          <OutputText theme={theme} text={reply.text} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginLeft: -space.md + 2 }}>
            <Button theme={theme} label="复制" icon="Copy" variant="ghost" size="sm" accessibilityLabel="复制最新回复" onPress={copy} />
            <Button theme={theme} label="在时间线中查看" icon="ListTree" variant="ghost" size="sm" accessibilityLabel="查看回复上下文" onPress={() => onOpenEvidence(reply.ref)} />
          </View>
          {nudge ? <View style={{ padding: space.md, borderRadius: radius.lg, borderWidth: hairline, borderColor: hue(theme, "violet", "line"), backgroundColor: hue(theme, "violet", "soft") }}>
            <QuickReplies key={`${agent.id}:${agent.lastUserMessageAt ?? ""}:${agent.observedTurnStartedAt ?? ""}:${nudge}`} theme={theme} agentId={agent.id} agentTitle={agent.title || "未命名 Agent"} nudge={nudge} expectPrompt={agent.lastUserMessageAt} expectRound={agent.observedTurnStartedAt ?? null} compact={compact} onSent={onReplied} />
          </View> : null}
        </> : loading ? <Skeleton theme={theme} rows={3} /> : <EmptyState theme={theme} icon="MessageSquare" title="还没有回复" message="有新回复时会自动更新，执行过程在时间线查看" />}
      </View>
      {data?.testEvidence.length ? <View>
        <PaneLabel theme={theme} icon="ShieldCheck" tone="success">验证证据</PaneLabel>
        <View style={{ marginHorizontal: -space.md }}>{data.testEvidence.map((item, index) => {
          const badge = outcomeBadge[item.outcome];
          return <Row key={`${item.ref}:${index}`} theme={theme} title={item.command} titleLines={2} onPress={() => onOpenEvidence(item.ref)} accessibilityLabel={`查看验证 ${item.command}`}
            leading={<Icon name={badge.icon} size={16} color={toneColor(theme, badge.tone)} />} trailing={<Badge theme={theme} label={badge.label} tone={badge.tone} />}
            subtitle={<MetaLine theme={theme} numberOfLines={2} parts={[item.text.split("\n").find(line => line.trim())?.slice(0, 240)]} />} />;
        })}</View>
      </View> : null}
      {data?.artifacts.length ? <View>
        <PaneLabel theme={theme} icon="FileCode" tone="violet">涉及文件与产物</PaneLabel>
        <View style={{ marginHorizontal: -space.md }}>{data.artifacts.map((item, index) => <Row key={`${item.ref}:${index}`} theme={theme} title={item.path} titleLines={2} onPress={() => onOpenEvidence(item.ref)} accessibilityLabel={`查看产物 ${item.path}`}
          leading={<Icon name={item.kind === "url" ? "Link" : "FileCode"} size={16} color={toneColor(theme, item.kind === "url" ? "cyan" : "violet", "mark")} />} trailing={<Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />} />)}</View>
      </View> : null}
      {data?.latestUserInput && data.latestUserInput.ref !== data.firstInput?.ref ? <View style={{ gap: space.xs }}>
        <PaneLabel theme={theme} icon="CornerDownRight" tone="amber">最近一次补充输入</PaneLabel>
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: fontSize.small, lineHeight: 20 }}>{data.latestUserInput.text}</Text>
      </View> : null}
      {data?.coverage.truncated ? <MetaLine theme={theme} numberOfLines={2} parts={["只显示宿主保留的内容，过长部分已截断"]} /> : null}
    </View>
  </ScrollView>;
}
const requestKinds: Record<PendingRequest["kind"], { label: string; tone: "amber" | "violet" | "sky" | "gray"; icon: string }> = {
  tool: { label: "权限", tone: "amber", icon: "Hand" }, plan: { label: "计划", tone: "amber", icon: "ClipboardList" }, question: { label: "提问", tone: "violet", icon: "MessageCircleQuestion" },
  mode: { label: "切换模式", tone: "sky", icon: "ToggleRight" }, other: { label: "请求", tone: "gray", icon: "CircleHelp" },
};
/**
 * What the Agent waits on (opus-F12): a question with its choices or a plan to approve, both answered in the conversation
 * (it has the full request), or a tool to allow, answered right here with the provider's own choices (opus-B12).
 */
function PendingRequests({ theme, agent, pending, permissions, compact, onResolve, onChanged }: { theme: PluginTheme; agent: AgentRecord; pending: number; permissions: readonly Record<string, unknown>[]; compact: boolean;
  onResolve?: () => void; onChanged?: () => void }) {
  const { colors } = theme, waiting = waitingKind(agent);
  const requests = permissions.map(request => ({ request, id: string(request.id), inline: !agent.archivedAt && !!permissionView(request, agent.cwd)?.inline, ...summarizeRequest(request) }));
  const message = waiting === "question" ? pending > 1 ? `Agent 在问你 ${pending} 个问题` : "Agent 在问你一个问题" : waiting === "plan" ? "Agent 写好了计划，等你批准" : `等待你批准 ${pending} 项请求`;
  return <View style={{ gap: space.sm }}>
    <Banner theme={theme} tone={waiting === "question" ? "violet" : "warning"} icon={waiting === "question" ? "MessageCircleQuestion" : waiting === "plan" ? "ClipboardList" : undefined} message={message}
      action={onResolve ? { label: waiting === "question" ? "去回答" : waiting === "plan" ? "查看计划" : "去处理", onPress: onResolve } : undefined} />
    {requests.map((request, index) => { const look = requestKinds[request.kind];
      if (request.inline) return <PermissionPanel key={request.id || index} theme={theme} agentId={agent.id} agentCwd={agent.cwd} request={request.request} compact={compact} onSettled={onChanged} />;
      return <View key={request.id || index} style={{ gap: 4, paddingHorizontal: space.xs }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Badge theme={theme} label={look.label} tone={look.tone} icon={look.icon} />
          <Text numberOfLines={3} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "600", lineHeight: 19 }}>{request.title || "待处理请求"}</Text>
        </View>
        {request.options.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{request.options.map(option => <Badge key={option} theme={theme} label={option} tone="violet" />)}</View> : null}
        {request.detail ? <Text selectable numberOfLines={3} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17, fontFamily: request.kind === "tool" ? monoFont : undefined }}>{request.detail}</Text> : null}
      </View>; })}
  </View>;
}
export const permissionRequests = (snapshot: unknown) => { const value = object(snapshot); return Array.isArray(value.pendingPermissions) ? value.pendingPermissions.map(object) : []; };
