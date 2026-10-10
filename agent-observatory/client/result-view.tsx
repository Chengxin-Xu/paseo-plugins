import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { ownTurnRunning, type AgentRecord } from "../shared/model";
import type { AgentResult } from "../shared/results";
import { object, string } from "../shared/timeline";
import { Badge, Banner, Button, EmptyState, MetaLine, Row, Skeleton, Spacer, fontSize, hairline, hue, relativeTime, space, toneColor } from "./kit";
import { PaneLabel, monoFont } from "./ui";
import { CodeBlock } from "./timeline-view";
import { openExternalUrl } from "./open-url";
import { proseBlocks, proseTokens } from "../shared/prose";
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
export function ResultView({ theme, agent, data, loading, error, header, lead, inset, pending = 0, permissions = [], onResolvePermissions, onOpenEvidence, onRefresh }: {
  theme: PluginTheme; agent: AgentRecord; data?: ResultData; loading: boolean; error?: string | null; header?: ReactNode; inset: number; pending?: number; permissions?: readonly Record<string, unknown>[];
  /** Shown before the reply, e.g. the 定时任务 card of an Agent a schedule created. */ lead?: ReactNode;
  onResolvePermissions?: () => void; onOpenEvidence: (ref: string) => void; onRefresh: () => void;
}) {
  const { colors } = theme;
  const toast = useToast();
  const reply = data?.latestReply;
  const state = ownTurnRunning(agent) || data?.isRunning ? "执行中" : data?.isFinal ? "本轮结果" : null;
  const copy = () => { if (!reply) return; void copyText(reply.text).then(() => toast.show("已复制最新回复", { variant: "success" })).catch(() => toast.error("复制失败，可长按选择文本")); };
  // The header slot is always rendered: web counts null children when indexing sticky headers, native drops them.
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingBottom: space.xxl }} stickyHeaderIndices={[1]}>
    <View style={{ paddingHorizontal: inset }}>{header}</View>
    <PinnedInput theme={theme} message={data?.firstInput ?? null} confirmed={data?.coverage.firstInputConfirmed === true} loading={loading} inset={inset} />
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg, gap: space.xl }}>
      {lead}
      {pending > 0 ? <View style={{ gap: space.sm }}>
        <Banner theme={theme} tone="warning" message={`等待你批准 ${pending} 项请求`} action={onResolvePermissions ? { label: "去处理", onPress: onResolvePermissions } : undefined} />
        {permissions.map((request, index) => <View key={string(request.id) || index} style={{ gap: 2, paddingHorizontal: space.xs }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: "500" }}>{string(request.title) || string(request.name) || "待处理请求"}</Text>
          <MetaLine theme={theme} numberOfLines={2} parts={[string(request.kind), string(request.description)]} />
        </View>)}
      </View> : null}
      {error ? <Banner theme={theme} tone="danger" message={error} action={{ label: "重试", onPress: onRefresh }} /> : null}
      <View style={{ gap: space.sm }}>
        <PaneLabel theme={theme} icon="MessageSquareText" tone="info" trailing={<MetaLine theme={theme} parts={[reply?.at ? relativeTime(reply.at) : null, state]} />}>最新回复</PaneLabel>
        {reply ? <>
          <OutputText theme={theme} text={reply.text} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginLeft: -space.md + 2 }}>
            <Button theme={theme} label="复制" icon="Copy" variant="ghost" size="sm" accessibilityLabel="复制最新回复" onPress={copy} />
            <Button theme={theme} label="在时间线中查看" icon="ListTree" variant="ghost" size="sm" accessibilityLabel="查看回复上下文" onPress={() => onOpenEvidence(reply.ref)} />
          </View>
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
export const permissionRequests = (snapshot: unknown) => { const value = object(snapshot); return Array.isArray(value.pendingPermissions) ? value.pendingPermissions.map(object) : []; };
