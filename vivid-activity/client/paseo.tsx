import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { extractPaseoChildAgentId } from "../shared/child-agent";
import { instantParts, instantText, isInstantString } from "../shared/clock";
import { exaOutputText, exaToolKind, exaToolSummary, parseExaSearchResults, type ExaSearchResult, } from "../shared/exa";
import { formatUnknownValue, notInHeader, outputView, paseoToolLeafName, paseoToolResult, paseoToolSummary, stripAnsi, type ActivityPalette, } from "../shared/presentation";
import { statusLabel } from "../shared/vivid-model";
import type { ActivityStyles } from "./activity";
import { ChildAgentTimeline } from "./child-agent";
import { OutputCopyButtons } from "./copy-button";
import { useHighlightTokens, type HighlightToken } from "./highlight";
import { aria } from "./kit";
import { StatusPill, statusColor } from "./status-pill";
import { useForeground } from "./use-foreground";
export { StatusPill } from "./status-pill";

type Theme = PluginTimelineItemProps["theme"];
type JsonRecord = Record<string, unknown>;

type PaseoProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fieldString(
  record: JsonRecord | null,
  key: string
): string | undefined {
  return stringValue(record?.[key]);
}

function fieldNumber(
  record: JsonRecord | null,
  key: string
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function fieldBoolean(
  record: JsonRecord | null,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function fieldArray(record: JsonRecord | null, key: string): unknown[] {
  return Array.isArray(record?.[key]) ? (record[key] as unknown[]) : [];
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  return formatUnknownValue(value);
}

function stableItemKey(value: unknown, prefix: string): string {
  const record = asRecord(value);
  const identity =
    record?.id ?? record?.agentId ?? record?.workspaceId ?? record?.browserId;
  if (typeof identity === "string" || typeof identity === "number") {
    return `${prefix}-${identity}`;
  }
  try {
    return `${prefix}-${JSON.stringify(value)}`;
  } catch {
    return prefix;
  }
}

export function Section({
  title,
  children,
  styles,
}: {
  title: string;
  children: ReactNode;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.detailLabel}>{title}</Text>
      {children}
    </View>
  );
}

// 本地补丁（0.6.0，opus-F49）：原生端（Yoga）的 Text 默认不收缩，放在 row 里长了就溢出、被裁掉。
/** A row child that takes the rest of the row (main axis = width, so `flex: 1` is safe here). */
const ROW_FILL: ViewStyle = { flex: 1, minWidth: 0 };
/** Secondary words after a list row's title: they may wrap, and never take more than 60% of the row from the title. */
const ROW_TAIL: TextStyle = { flexShrink: 1, maxWidth: "60%" };

// 本地补丁（0.6.0，opus-F53）：时间里的「9 小时后」按分钟刷新。显示中的时间共用一个 60 秒定时器：App 在后台时不订阅，
// 没有订阅者就停；停着时读到的「现在」旧了一分钟以上就当场换新，展开一行时不会先闪一下过时的相对时间。
const minuteListeners = new Set<() => void>();
let minuteTimer: ReturnType<typeof setInterval> | null = null;
let minuteNow = Date.now();
function subscribeMinute(listener: () => void): () => void {
  minuteListeners.add(listener);
  if (minuteTimer === null) {
    minuteTimer = setInterval(() => {
      minuteNow = Date.now();
      for (const each of minuteListeners) each();
    }, 60_000);
  }
  return () => {
    minuteListeners.delete(listener);
    if (minuteListeners.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
    }
  };
}
const idleMinute = () => () => {};
function readMinute(): number {
  if (minuteTimer === null && Date.now() - minuteNow >= 60_000) minuteNow = Date.now();
  return minuteNow;
}
/** The time now, refreshed every minute while the app is in the foreground. */
function useMinuteNow(): number {
  const foreground = useForeground();
  return useSyncExternalStore(foreground ? subscribeMinute : idleMinute, readMinute, readMinute);
}

/**
 * 本地补丁（0.6.0，opus-F53）：严格的 ISO-8601 时刻（daemon 写的 `2026-10-13T00:00:00.000Z` 这类 UTC 串）按设备时区显示成
 * 「明天 05:00（9 小时后）」，规则见 shared/clock.ts；将来的相对时间用运行中的蓝色，过去的用次要色。
 * 原文不丢：点一下换成原文，再点换回；读屏念的名称里两者都有。不是严格时刻的值原样显示。
 * 按下区是一个 row，里面的 Text 收缩折行；放进 row 里时由 `containerStyle` 给出它在 row 里的伸缩。
 */
function InstantText({
  value,
  prefix = "",
  style,
  containerStyle,
  palette,
  styles,
}: {
  value: string;
  /** Words before the time, e.g. 「0 9 * * * · 下次运行 」. */
  prefix?: string;
  style: StyleProp<TextStyle>;
  containerStyle?: StyleProp<ViewStyle>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const now = useMinuteNow();
  const [raw, setRaw] = useState(false);
  const parts = instantParts(value, now);
  if (!parts) {
    return (
      <Text selectable style={style}>
        {`${prefix}${value}`}
      </Text>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${prefix}${instantText(value, now)}，原文 ${value}`}
      accessibilityState={{ selected: raw }}
      {...aria({ pressed: raw })}
      onPress={() => setRaw((current) => !current)}
      style={[{ flexDirection: "row" }, containerStyle]}
    >
      <Text selectable style={[style, { flexShrink: 1, minWidth: 0 }]}>
        {raw ? `${prefix}${value}` : `${prefix}${parts.day} ${parts.clock}`}
        {!raw && parts.relative ? (
          <Text style={{ color: parts.future ? palette.statusColors.running : styles.mutedText.color }}>
            {`（${parts.relative}）`}
          </Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

/** One scalar field value: strict ISO-8601 instants read in the device's zone (`InstantText`), the rest as text. */
function ScalarValue({
  value,
  palette,
  styles,
}: {
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (isInstantString(value)) {
    return <InstantText value={value} style={styles.paseoValue} palette={palette} styles={styles} />;
  }
  return (
    <Text selectable style={styles.paseoValue}>
      {scalarText(value)}
    </Text>
  );
}

function PaseoFieldValue({
  value,
  palette,
  styles,
  depth = 0,
}: {
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  if (depth > 2) return <ScalarValue value={value} palette={palette} styles={styles} />;
  const record = asRecord(value);
  if (record) {
    const entries = Object.entries(record).filter(
      ([, child]) => child !== undefined
    );
    if (entries.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {entries.map(([key, child]) => (
          <PaseoField
            key={`${key}-${stableItemKey(child, key)}`}
            label={humanizeKey(key)}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <Text style={styles.paseoValue}>—</Text>;
    return (
      <View style={styles.paseoRows}>
        {value.map((child) => (
          <PaseoFieldValue
            key={stableItemKey(child, "item")}
            value={child}
            palette={palette}
            styles={styles}
            depth={depth + 1}
          />
        ))}
      </View>
    );
  }
  return <ScalarValue value={value} palette={palette} styles={styles} />;
}

function PaseoField({
  label,
  value,
  palette,
  styles,
  depth = 0,
}: {
  label: string;
  value: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
  depth?: number;
}) {
  return (
    <View style={styles.paseoRow}>
      <Text style={styles.paseoKey}>{label}</Text>
      <View style={{ flex: 1, minWidth: 0 }}>
        <PaseoFieldValue
          value={value}
          palette={palette}
          styles={styles}
          depth={depth}
        />
      </View>
    </View>
  );
}

const STATUS_FIELDS: ReadonlySet<string> = new Set(["状态", "需要关注"]);

export function PaseoFields({
  fields,
  palette,
  styles,
}: {
  fields: Array<[string, unknown]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  // 本地补丁：状态类字段的值（idle、running、paused…）显示中文；其他字段值是数据，原样显示。
  const visible = fields
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => [label, STATUS_FIELDS.has(label) && typeof value === "string" ? statusLabel(value) : value] as [string, unknown]);
  if (visible.length === 0) return null;
  return (
    <View style={styles.paseoRows}>
      {visible.map(([label, value]) => (
        <PaseoField
          key={`${label}-${stableItemKey(value, label)}`}
          label={label}
          value={value}
          palette={palette}
          styles={styles}
        />
      ))}
    </View>
  );
}

/** Field value with header-duplicate scalars removed (see `notInHeader`). */
function unlessInHeader(value: unknown, headerSummary: string | undefined): unknown {
  return typeof value === "string" || typeof value === "number"
    ? notInHeader(value, headerSummary)
    : value;
}

/** One muted line of secondary facts, joined with middots. */
function MetaLine({ parts, styles }: { parts: Array<string | undefined>; styles: ActivityStyles }) {
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return null;
  return (
    <Text numberOfLines={2} style={styles.paseoHeroSubtitle}>
      {text}
    </Text>
  );
}

/** A titled field list that disappears when every field is already shown elsewhere. */
export function FieldsSection({
  title,
  fields,
  palette,
  styles,
}: {
  title: string;
  fields: Array<[string, unknown]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (fields.every(([, value]) => value === undefined)) return null;
  return (
    <Section title={title} styles={styles}>
      <PaseoFields fields={fields} palette={palette} styles={styles} />
    </Section>
  );
}

export function PaseoHero({
  icon,
  title,
  subtitle,
  status,
  palette,
  color,
  styles,
}: {
  icon: string;
  title: string;
  subtitle?: string;
  status?: string;
  palette?: ActivityPalette;
  color: string;
  styles: ActivityStyles;
}) {
  return (
    <View style={[styles.paseoHero, { borderLeftColor: color }]}>
      <View style={styles.paseoHeroRow}>
        <View style={styles.paseoHeroIcon}>
          <Icon name={icon} color={color} size={12} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.paseoHeroTitle}>{title}</Text>
          {subtitle || status ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {subtitle ? (
                <Text numberOfLines={1} style={styles.paseoHeroSubtitle}>
                  {subtitle}
                </Text>
              ) : null}
              {status && palette ? (
                <Text
                  numberOfLines={1}
                  style={[styles.paseoHeroSubtitle, { color: statusColor(status, palette) }]}
                >
                  {status}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function PromptBlock({
  text,
  label = "提示词",
  styles,
  compact = false,
}: {
  text: string | undefined;
  label?: string;
  styles: ActivityStyles;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const prompt = compact ? (
    <Pressable
      accessibilityLabel={`${expanded ? "收起" : "展开"}提示词：${text}`}
      accessibilityRole="button"
      {...aria({ expanded })}
      onPress={() => setExpanded((current) => !current)}
    >
      <Text numberOfLines={expanded ? undefined : 2} selectable style={styles.paseoPrompt}>
        {text}
      </Text>
    </Pressable>
  ) : (
    <Text selectable style={styles.paseoPrompt}>
      {text}
    </Text>
  );
  return label ? <Section title={label} styles={styles}>{prompt}</Section> : prompt;
}

function TokenizedLines({
  lines,
  styles,
}: {
  lines: HighlightToken[][];
  styles: ActivityStyles;
}) {
  return (
    <View>
      {lines.map((line, lineIndex) => (
        <Text key={`line-${lineIndex}`} selectable style={styles.codeLine}>
          {line.length === 0
            ? " "
            : line.map((token, tokenIndex) => {
                const tokenStyle: TextStyle = {
                  color: token.color ?? styles.codeLine.color,
                  ...(token.fontStyle && token.fontStyle & 1
                    ? { fontStyle: "italic" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 2
                    ? { fontWeight: "700" }
                    : {}),
                  ...(token.fontStyle && token.fontStyle & 4
                    ? { textDecorationLine: "underline" }
                    : {}),
                };
                return (
                  <Text key={`${lineIndex}-${tokenIndex}`} style={tokenStyle}>
                    {token.content}
                  </Text>
                );
              })}
        </Text>
      ))}
    </View>
  );
}

export function PaseoCodeBlock({
  code,
  language,
  label,
  theme,
  styles,
}: {
  code: string;
  language: string;
  label?: string;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const [showAll, setShowAll] = useState(false);
  // 0.5.0: terminal escape sequences (logs, terminal captures) never show; the copy buttons sit next to the label.
  const clean = useMemo(() => stripAnsi(code), [code]);
  const view = useMemo(() => outputView(code, clean, showAll, language === "ansi", false), [clean, code, language, showAll]);
  const { preview, shown: displayCode } = view;
  const tokens = useHighlightTokens(
    view.highlight,
    language,
    theme.colors,
  );
  const title = label ?? "输出";
  return (
    <View style={styles.section}>
      <View style={styles.codeHeader}>
        <Text style={[styles.detailLabel, { flexShrink: 1 }]}>{title}</Text>
        <OutputCopyButtons clean={clean} raw={code} label={`复制${title}`} theme={theme} styles={styles} />
      </View>
      <ScrollView horizontal nestedScrollEnabled style={styles.codeScroll}>
        <View style={styles.codeSurface}>
          {tokens ? (
            <TokenizedLines lines={tokens} styles={styles} />
          ) : (
            <Text selectable style={styles.codeLine}>
              {displayCode || " "}
            </Text>
          )}
        </View>
      </ScrollView>
      {preview.truncated ? (
        <Pressable
          accessibilityRole="button"
          {...aria({ expanded: showAll })}
          onPress={() => setShowAll(!showAll)}
          style={styles.showMoreButton}
        >
          <Text style={styles.showMoreText}>
            {showAll
              ? "收起"
              : `展开全部（${preview.totalLines} 行，${preview.totalChars.toLocaleString()} 字符）`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function OutputFields({
  result,
  fields,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  fields: Array<[string, string]>;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const values = fields.map(
    ([key, label]) => [label, result?.[key]] as [string, unknown]
  );
  if (values.every(([, value]) => value === undefined)) return null;
  return (
    <Section title="结果" styles={styles}>
      <PaseoFields fields={values} palette={palette} styles={styles} />
    </Section>
  );
}

function ActionResult({
  result,
  palette,
  styles,
  fields = [],
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
  fields?: Array<[string, string]>;
}) {
  const visibleFields = fields
    .map(([key, label]) => [label, result?.[key]] as [string, unknown])
    .filter(([, value]) => value !== undefined);
  const success = result?.success;
  if (typeof success !== "boolean" && visibleFields.length === 0) return null;
  return (
    <Section title="结果" styles={styles}>
      <View style={styles.paseoRows}>
        {typeof success === "boolean" ? (
          <StatusPill
            value={success ? "Success" : "Failed"}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <PaseoFields fields={visibleFields} palette={palette} styles={styles} />
      </View>
    </Section>
  );
}

function AgentSnapshot({
  snapshot,
  headerSummary,
  palette,
  styles,
}: {
  snapshot: JsonRecord | null;
  headerSummary: string | undefined;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!snapshot) return null;
  const capabilities = asRecord(snapshot.capabilities);
  const modes = fieldArray(snapshot, "availableModes");
  const permissions = fieldArray(snapshot, "pendingPermissions");
  return (
    <View style={styles.paseoStack}>
      <PaseoFields
        fields={[
          ["Agent", unlessInHeader(snapshot.id, headerSummary)],
          ["标题", snapshot.title],
          ["Provider", snapshot.provider],
          ["模型", snapshot.model],
          ["状态", snapshot.status],
          ["工作目录", snapshot.cwd],
          ["工作区", snapshot.workspaceId],
          ["模式", snapshot.currentModeId],
          [
            "思考强度",
            snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId,
          ],
          ["需要关注", snapshot.attentionReason],
          ["最近错误", snapshot.lastError],
        ]}
        palette={palette}
        styles={styles}
      />
      {capabilities ? (
        <Section title="能力" styles={styles}>
          <View style={styles.paseoChips}>
            {Object.entries(capabilities)
              .filter(([, value]) => value === true)
              .map(([key]) => (
                <View key={key} style={styles.paseoChip}>
                  <Text style={styles.paseoChipText}>{humanizeKey(key)}</Text>
                </View>
              ))}
          </View>
        </Section>
      ) : null}
      {modes.length > 0 ? (
        <ModeList modes={modes} palette={palette} styles={styles} />
      ) : null}
      {permissions.length > 0 ? (
        <Section
          title={`待审批（${permissions.length}）`}
          styles={styles}
        >
          <PermissionList
            permissions={permissions}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}

function ModeList({
  modes,
  palette,
  styles,
}: {
  modes: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (modes.length === 0) return null;
  return (
    <Section title="可用模式" styles={styles}>
      <View style={styles.paseoList}>
        {modes.map((mode) => {
          const record = asRecord(mode);
          return (
            <View
              key={stableItemKey(mode, "mode")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "模式"}
                </Text>
                {fieldString(record, "id") ? (
                  <Text
                    style={[
                      styles.paseoListItemMeta,
                      ROW_TAIL,
                      { color: palette.categoryColors.agent },
                    ]}
                  >
                    {fieldString(record, "id")}
                  </Text>
                ) : null}
              </View>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function PermissionList({
  permissions,
  palette,
  styles,
}: {
  permissions: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (permissions.length === 0) return <Text style={styles.empty}>没有待审批。</Text>;
  return (
    <View style={styles.paseoList}>
      {permissions.map((permission) => {
        const record = asRecord(permission);
        const actions = fieldArray(record, "actions");
        return (
          <View
            key={stableItemKey(permission, "permission")}
            style={styles.paseoListItem}
          >
            <View style={styles.paseoListItemHeader}>
              <Text style={styles.paseoListItemTitle}>
                {fieldString(record, "title") ??
                  fieldString(record, "name") ??
                  "权限请求"}
              </Text>
              {fieldString(record, "kind") ? (
                <StatusPill
                  value={fieldString(record, "kind")!}
                  palette={palette}
                  styles={styles}
                />
              ) : null}
            </View>
            {fieldString(record, "description") ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            ) : null}
            {actions.length > 0 ? (
              <Text style={styles.paseoListItemMeta}>
                可选操作：
                {actions
                  .map(
                    (action) =>
                      fieldString(asRecord(action), "label") ?? "操作"
                  )
                  .join(" · ")}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function AgentTool({
  leaf,
  headerSummary,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_agent": {
      const childAgentId = extractPaseoChildAgentId(outputRecord);
      const provider = fieldString(inputRecord, "provider");
      const settings = asRecord(inputRecord?.settings);
      const thinkingOptionId = fieldString(settings, "thinkingOptionId");
      return (
        <View style={styles.paseoStack}>
          <MetaLine
            parts={[
              notInHeader(fieldString(inputRecord, "title"), headerSummary),
              notInHeader(provider, headerSummary),
              thinkingOptionId ? `思考强度 ${thinkingOptionId}` : undefined,
              inputRecord?.background === true ? "后台运行" : undefined,
              inputRecord?.notifyOnFinish === true ? "完成时通知" : undefined,
              fieldString(outputRecord, "status") ? statusLabel(fieldString(outputRecord, "status")!) : undefined,
            ]}
            styles={styles}
          />
          <PromptBlock
            text={fieldString(inputRecord, "initialPrompt")}
            label=""
            compact
            styles={styles}
          />
          {childAgentId ? (
            <ChildAgentTimeline
              agentId={childAgentId}
              theme={theme}
              palette={palette}
              styles={styles}
            />
          ) : null}
        </View>
      );
    }
    case "send_agent_prompt":
      return (
        <View style={styles.paseoStack}>
          <PromptBlock
            text={fieldString(inputRecord, "prompt")}
            styles={styles}
          />
          <FieldsSection
            title="发送方式"
            fields={[
              ["Agent", unlessInHeader(inputRecord?.agentId, headerSummary)],
              ["会话模式", inputRecord?.sessionMode],
              ["后台运行", inputRecord?.background],
              ["完成时通知", inputRecord?.notifyOnFinish],
            ]}
            palette={palette}
            styles={styles}
          />
          <OutputFields
            result={outputRecord}
            fields={[
              ["status", "状态"],
              ["lastMessage", "最后一条消息"],
              ["guidance", "提示"],
            ]}
            palette={palette}
            styles={styles}
          />
          {outputRecord?.permission ? (
            <Section title="权限" styles={styles}>
              <PermissionList
                permissions={[outputRecord.permission]}
                palette={palette}
                styles={styles}
              />
            </Section>
          ) : null}
        </View>
      );
    case "get_agent_status":
      return (
        <View style={styles.paseoStack}>
          <AgentSnapshot
            snapshot={asRecord(outputRecord?.snapshot) ?? outputRecord}
            headerSummary={headerSummary}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_agents":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["工作目录", inputRecord?.cwd],
              ["状态筛选", inputRecord?.statuses],
              ["最近（小时）", inputRecord?.sinceHours],
              ["数量上限", inputRecord?.limit],
              ["包含已归档", inputRecord?.includeArchived],
            ]}
            palette={palette}
            styles={styles}
          />
          <AgentList
            agents={fieldArray(outputRecord, "agents")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "get_agent_activity":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", unlessInHeader(inputRecord?.agentId, headerSummary)],
              ["数量上限", inputRecord?.limit],
              ["模式", outputRecord?.currentModeId],
              ["更新数", outputRecord?.updateCount],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(outputRecord, "content") ? (
            <PaseoCodeBlock
              code={fieldString(outputRecord, "content")!}
              language="markdown"
              label="动态"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "set_agent_mode":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", unlessInHeader(inputRecord?.agentId, headerSummary)],
              ["模式", inputRecord?.modeId],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={
              outputRecord?.newMode !== undefined && outputRecord.newMode !== inputRecord?.modeId
                ? [["newMode", "新模式"]]
                : []
            }
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "update_agent":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", unlessInHeader(inputRecord?.agentId, headerSummary)],
              ["名称", inputRecord?.name],
              ["标签", inputRecord?.labels],
              ["设置", inputRecord?.settings],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "cancel_agent":
    case "archive_agent":
    case "kill_agent":
      return (
        <View style={styles.paseoStack}>
          {notInHeader(fieldString(inputRecord, "agentId"), headerSummary) ? (
            <PaseoFields
              fields={[["Agent", inputRecord?.agentId]]}
              palette={palette}
              styles={styles}
            />
          ) : null}
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_pending_permissions":
      return (
        <View style={styles.paseoStack}>
          <PermissionList
            permissions={fieldArray(outputRecord, "permissions")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "respond_to_permission":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["Agent", inputRecord?.agentId],
              ["请求", inputRecord?.requestId],
              ["回复", inputRecord?.response],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function AgentList({
  agents,
  palette,
  styles,
}: {
  agents: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <Section title={`Agent（${agents.length}）`} styles={styles}>
      {agents.length === 0 ? (
        <Text style={styles.empty}>没有返回 Agent。</Text>
      ) : (
        <View style={styles.paseoList}>
          {agents.map((agent) => {
            const record = asRecord(agent);
            return (
              <View
                key={stableItemKey(agent, "agent")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "title") ??
                      fieldString(record, "shortId") ??
                      fieldString(record, "id") ??
                      "Agent"}
                  </Text>
                  {fieldString(record, "status") ? (
                    <StatusPill
                      value={fieldString(record, "status")!}
                      palette={palette}
                      styles={styles}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {[
                    fieldString(record, "provider"),
                    fieldString(record, "model"),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "cwd") ?? fieldString(record, "id")}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </Section>
  );
}

function WorkspaceSummary({
  result,
  palette,
  styles,
}: {
  result: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <OutputFields
      result={result}
      fields={[
        ["workspaceId", "工作区"],
        ["projectId", "项目"],
        ["cwd", "工作目录"],
        ["isolation", "隔离方式"],
        ["kind", "类型"],
        ["title", "标题"],
      ]}
      palette={palette}
      styles={styles}
    />
  );
}

function WorkspaceTool({
  leaf,
  headerSummary,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "create_workspace":
      return (
        <View style={styles.paseoStack}>
          <Section title="配置" styles={styles}>
            <PaseoFields
              fields={[
                ["标题", unlessInHeader(inputRecord?.title, headerSummary)],
                ["隔离方式", inputRecord?.isolation],
                ["路径", inputRecord?.path],
                ["项目", inputRecord?.projectId],
                ["模式", inputRecord?.mode],
                ["工作树", inputRecord?.worktreeSlug],
                ["分支", inputRecord?.branchName ?? inputRecord?.branch],
                ["基准分支", inputRecord?.baseBranch],
                ["合并请求", inputRecord?.prNumber],
                ["代码托管", inputRecord?.forge],
              ]}
              palette={palette}
              styles={styles}
            />
          </Section>
          <WorkspaceSummary
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "list_workspaces":
      return (
        <WorkspaceList
          workspaces={fieldArray(outputRecord, "workspaces")}
          palette={palette}
          styles={styles}
        />
      );
    case "archive_workspace":
      return (
        <View style={styles.paseoStack}>
          <ActionResult
            result={outputRecord}
            fields={[
              ...(notInHeader(fieldString(outputRecord, "workspaceId"), headerSummary)
                ? ([["workspaceId", "工作区"]] as Array<[string, string]>)
                : []),
              ["archivedAgentIds", "已归档的 Agent"],
              ["removedDirectory", "已删除的目录"],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "rename_workspace":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["工作区", unlessInHeader(inputRecord?.workspaceId, headerSummary)],
              ["新标题", inputRecord?.title],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            fields={[
              ["workspaceId", "工作区"],
              ["title", "标题"],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function WorkspaceList({
  workspaces,
  palette,
  styles,
}: {
  workspaces: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (workspaces.length === 0) {
    return <Text style={styles.empty}>没有返回工作区。</Text>;
  }
  return (
    <Section title={`工作区（${workspaces.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {workspaces.map((workspace) => {
          const record = asRecord(workspace);
          return (
            <View
              key={stableItemKey(workspace, "workspace")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ??
                    fieldString(record, "workspaceId") ??
                    "工作区"}
                </Text>
                {fieldString(record, "isolation") ? (
                  <StatusPill
                    value={fieldString(record, "isolation")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "workspaceId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScriptList({
  scripts,
  palette,
  styles,
}: {
  scripts: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (scripts.length === 0) {
    return <Text style={styles.empty}>没有返回工作区脚本。</Text>;
  }
  return (
    <Section title={`脚本（${scripts.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {scripts.map((script) => {
          const record = asRecord(script);
          return (
            <View
              key={stableItemKey(script, "script")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "scriptName") ?? "脚本"}
                </Text>
                {fieldString(record, "lifecycle") ? (
                  <StatusPill
                    value={fieldString(record, "lifecycle")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "type"),
                  fieldString(record, "health"),
                  fieldString(record, "port"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "proxyUrl") ??
                  fieldString(record, "localProxyUrl")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalList({
  terminals,
  palette,
  styles,
}: {
  terminals: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (terminals.length === 0) {
    return <Text style={styles.empty}>没有返回终端。</Text>;
  }
  return (
    <Section title={`终端（${terminals.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {terminals.map((terminal) => {
          const record = asRecord(terminal);
          return (
            <View
              key={stableItemKey(terminal, "terminal")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "终端"}
                </Text>
                <Icon
                  name="SquareTerminal"
                  color={palette.categoryColors.shell}
                  size={12}
                />
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "cwd")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function TerminalTool({
  leaf,
  input,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  switch (leaf) {
    case "list_workspace_scripts":
    case "start_workspace_script":
    case "stop_workspace_script": {
      const scriptResult = asRecord(result)?.script ?? result;
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["工作区", inputRecord?.workspaceId],
              ["脚本", inputRecord?.scriptName],
            ]}
            palette={palette}
            styles={styles}
          />
          {leaf === "list_workspace_scripts" ? (
            <ScriptList
              scripts={fieldArray(outputRecord, "scripts")}
              palette={palette}
              styles={styles}
            />
          ) : (
            <Section title="脚本" styles={styles}>
              <ScriptList
                scripts={[scriptResult]}
                palette={palette}
                styles={styles}
              />
            </Section>
          )}
        </View>
      );
    }
    case "list_terminals":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["工作目录", inputRecord?.cwd],
              ["所有目录", inputRecord?.all],
            ]}
            palette={palette}
            styles={styles}
          />
          <TerminalList
            terminals={fieldArray(outputRecord, "terminals")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "create_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["工作目录", inputRecord?.cwd],
              ["工作区", inputRecord?.workspaceId],
              ["名称", inputRecord?.name],
            ]}
            palette={palette}
            styles={styles}
          />
          <Section title="终端" styles={styles}>
            <TerminalList
              terminals={[result]}
              palette={palette}
              styles={styles}
            />
          </Section>
        </View>
      );
    case "capture_terminal": {
      const lines = fieldArray(outputRecord, "lines")
        .map(scalarText)
        .join("\n");
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["终端", inputRecord?.terminalId],
              ["起始行", inputRecord?.start],
              ["结束行", inputRecord?.end],
              ["回滚行数", inputRecord?.scrollback],
              ["去掉颜色代码", inputRecord?.stripAnsi],
              ["总行数", outputRecord?.totalLines],
            ]}
            palette={palette}
            styles={styles}
          />
          {lines ? (
            <PaseoCodeBlock
              code={lines}
              language="ansi"
              label="终端输出"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    }
    case "send_terminal_keys":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["终端", inputRecord?.terminalId],
              ["按键", inputRecord?.keys],
              ["按原文发送", inputRecord?.literal],
            ]}
            palette={palette}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "kill_terminal":
      return (
        <View style={styles.paseoStack}>
          <PaseoHero
            icon="CircleX"
            title={fieldString(inputRecord, "terminalId") ?? "终端"}
            color={palette.categoryColors.shell}
            styles={styles}
          />
          <ActionResult
            result={outputRecord}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    default:
      return (
        <FallbackPaseo
          input={input}
          result={result}
          palette={palette}
          styles={styles}
        />
      );
  }
}

function ScheduleTool({
  leaf,
  headerSummary,
  input,
  result,
  theme: _theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  const isMutation = [
    "delete_heartbeat",
    "pause_schedule",
    "resume_schedule",
    "delete_schedule",
  ].includes(leaf);
  if (isMutation) {
    return (
      <View style={styles.paseoStack}>
        <PaseoHero
          icon={
            leaf.startsWith("delete")
              ? "Trash2"
              : leaf === "pause_schedule"
              ? "Pause"
              : "Play"
          }
          title={fieldString(inputRecord, "id") ?? "定时任务"}
          color={palette.categoryColors.plan}
          styles={styles}
        />
        <ActionResult result={outputRecord} palette={palette} styles={styles} />
      </View>
    );
  }
  if (leaf === "list_schedules")
    return (
      <ScheduleList
        schedules={fieldArray(outputRecord, "schedules")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "schedule_logs")
    return (
      <ScheduleRuns
        runs={fieldArray(outputRecord, "runs")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_schedule" || leaf === "run_schedule_once")
    return (
      <View style={styles.paseoStack}>
        <ScheduleSummary
          schedule={outputRecord}
          palette={palette}
          styles={styles}
        />
        <ScheduleRuns
          runs={fieldArray(outputRecord, "runs")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "create_schedule" || leaf === "create_heartbeat") {
    return (
      <View style={styles.paseoStack}>
        <PromptBlock
          text={notInHeader(fieldString(inputRecord, "prompt"), headerSummary)}
          styles={styles}
        />
        <Section title="配置" styles={styles}>
          <PaseoFields
            fields={[
              ["名称", inputRecord?.name],
              ["Cron 表达式", inputRecord?.cron],
              ["时区", inputRecord?.timezone],
              ["Provider", inputRecord?.provider],
              ["工作目录", inputRecord?.cwd],
              ["隔离方式", inputRecord?.isolation],
              ["最多运行次数", inputRecord?.maxRuns],
              ["有效期", inputRecord?.expiresIn],
            ]}
            palette={palette}
            styles={styles}
          />
        </Section>
        <ScheduleSummary
          schedule={outputRecord}
          input={inputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  if (leaf === "update_schedule")
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["定时任务", inputRecord?.id],
            ["名称", inputRecord?.name],
            ["提示词", inputRecord?.prompt],
            ["Cron 表达式", inputRecord?.cron],
            ["时区", inputRecord?.timezone],
            ["Provider", inputRecord?.provider],
            ["模型", inputRecord?.model],
            ["模式", inputRecord?.mode],
            ["工作目录", inputRecord?.cwd],
            ["最多运行次数", inputRecord?.maxRuns],
            ["有效期", inputRecord?.expiresIn],
            ["清除有效期", inputRecord?.clearExpires],
          ]}
          palette={palette}
          styles={styles}
        />
        <ScheduleSummary
          schedule={outputRecord}
          input={inputRecord}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ScheduleSummary({
  schedule,
  input = null,
  palette,
  styles,
}: {
  schedule: JsonRecord | null;
  /** Tool input already rendered above; result values that just echo it are skipped. */
  input?: JsonRecord | null;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (!schedule) return null;
  const echoed = (key: string) =>
    input?.[key] !== undefined && input[key] === schedule[key];
  const cadence = asRecord(schedule.cadence);
  const target = asRecord(schedule.target);
  const targetConfig = asRecord(target?.config);
  return (
    <View style={styles.paseoStack}>
      <OutputFields
        result={schedule}
        fields={[
          ["id", "ID"],
          ["name", "名称"],
          ["status", "状态"],
          ["nextRunAt", "下次运行"],
          ["lastRunAt", "上次运行"],
          ["expiresAt", "到期时间"],
          ["maxRuns", "最多运行次数"],
        ].filter(([key]) => !echoed(key)) as Array<[string, string]>}
        palette={palette}
        styles={styles}
      />
      <PromptBlock
        text={echoed("prompt") ? undefined : fieldString(schedule, "prompt")}
        styles={styles}
      />
      <Section title="周期与目标" styles={styles}>
        <PaseoFields
          fields={[
            ["周期", cadence],
            ["目标", target?.type],
            ["Agent", target?.agentId],
            ["Provider", targetConfig?.provider],
            ["模型", targetConfig?.model],
            ["模式", targetConfig?.modeId],
            ["工作目录", targetConfig?.cwd],
            ["隔离方式", targetConfig?.isolation],
          ]}
          palette={palette}
          styles={styles}
        />
      </Section>
    </View>
  );
}

function ScheduleList({
  schedules,
  palette,
  styles,
}: {
  schedules: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (schedules.length === 0) {
    return <Text style={styles.empty}>没有返回定时任务。</Text>;
  }
  return (
    <Section title={`定时任务（${schedules.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {schedules.map((schedule) => {
          const record = asRecord(schedule);
          const expression = fieldString(asRecord(record?.cadence), "expression");
          const nextRunAt = fieldString(record, "nextRunAt");
          return (
            <View
              key={stableItemKey(schedule, "schedule")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "定时任务"}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              {/* 本地补丁（0.6.0，opus-F53）：cron 表达式后面接设备时区的下次运行时间（暂停、结束的没有下次）。 */}
              {nextRunAt ? (
                <InstantText
                  value={nextRunAt}
                  prefix={`${expression ? `${expression} · ` : ""}下次运行 `}
                  style={styles.paseoListItemMeta}
                  palette={palette}
                  styles={styles}
                />
              ) : expression ? (
                <Text style={styles.paseoListItemMeta}>{expression}</Text>
              ) : null}
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "prompt")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ScheduleRuns({
  runs,
  palette,
  styles,
}: {
  runs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (runs.length === 0) {
    return <Text style={styles.empty}>没有运行记录。</Text>;
  }
  return (
    <Section title={`运行记录（${runs.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {runs.map((run) => {
          const record = asRecord(run);
          const scheduledFor = fieldString(record, "scheduledFor");
          return (
            <View key={stableItemKey(run, "run")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                {/* 本地补丁（0.6.0，opus-F53）：这次运行排定的时刻，按设备时区显示。 */}
                {scheduledFor ? (
                  <InstantText
                    value={scheduledFor}
                    style={styles.paseoListItemTitle}
                    containerStyle={ROW_FILL}
                    palette={palette}
                    styles={styles}
                  />
                ) : (
                  <Text style={styles.paseoListItemTitle}>
                    {fieldString(record, "id") ?? "运行"}
                  </Text>
                )}
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {[
                  fieldString(record, "agentId"),
                  fieldString(record, "workspaceId"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {fieldString(record, "output") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "output")}
                </Text>
              ) : null}
              {fieldString(record, "error") ? (
                <Text
                  selectable
                  style={[
                    styles.paseoListItemMeta,
                    { color: palette.statusColors.failed },
                  ]}
                >
                  {fieldString(record, "error")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProviderTool({
  leaf,
  headerSummary,
  input,
  result,
  palette,
  styles,
}: Omit<PaseoProps, "toolName" | "output" | "theme"> & {
  leaf: string;
  headerSummary: string | undefined;
  result: unknown;
}) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(result);
  if (leaf === "list_providers")
    return (
      <ProviderList
        providers={fieldArray(outputRecord, "providers")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "list_models")
    return (
      <View style={styles.paseoStack}>
        {notInHeader(fieldString(outputRecord, "provider"), headerSummary) ? (
          <PaseoFields
            fields={[["Provider", outputRecord?.provider]]}
            palette={palette}
            styles={styles}
          />
        ) : null}
        <ModelList
          models={fieldArray(outputRecord, "models")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  if (leaf === "list_profiles")
    return (
      <ProfileList
        profiles={fieldArray(outputRecord, "profiles")}
        palette={palette}
        styles={styles}
      />
    );
  if (leaf === "inspect_provider")
    return (
      <View style={styles.paseoStack}>
        <MetaLine parts={[fieldString(outputRecord, "description")]} styles={styles} />
        <PaseoFields
          fields={[
            ["Provider", outputRecord?.provider ?? inputRecord?.provider],
            ["名称", outputRecord?.label],
            ["状态", outputRecord?.status],
            ["已启用", outputRecord?.enabled],
            ["选用模型", outputRecord?.selectedModel],
          ]}
          palette={palette}
          styles={styles}
        />
        <ModeList
          modes={fieldArray(outputRecord, "modes")}
          palette={palette}
          styles={styles}
        />
        <FeatureList
          features={fieldArray(outputRecord, "features")}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}

function ProviderList({
  providers,
  palette,
  styles,
}: {
  providers: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (providers.length === 0) {
    return <Text style={styles.empty}>没有返回 Provider。</Text>;
  }
  return (
    <Section title={`Provider（${providers.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {providers.map((provider) => {
          const record = asRecord(provider);
          return (
            <View
              key={stableItemKey(provider, "provider")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "Provider"}
                </Text>
                {fieldString(record, "status") ? (
                  <StatusPill
                    value={fieldString(record, "status")!}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ModelList({
  models,
  palette,
  styles,
}: {
  models: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (models.length === 0) {
    return <Text style={styles.empty}>没有返回模型。</Text>;
  }
  return (
    <Section title={`模型（${models.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {models.map((model) => {
          const record = asRecord(model);
          return (
            <View
              key={stableItemKey(model, "model")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "模型"}
                </Text>
                {fieldBoolean(record, "isDefault") ? (
                  <StatusPill
                    value="Default"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "id")}
              </Text>
              {fieldString(record, "description") ? (
                <Text style={styles.paseoListItemMeta}>
                  {fieldString(record, "description")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function ProfileList({
  profiles,
  palette,
  styles,
}: {
  profiles: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (profiles.length === 0) {
    return <Text style={styles.empty}>没有返回配置。</Text>;
  }
  return (
    <Section title={`配置（${profiles.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {profiles.map((profile) => {
          const record = asRecord(profile);
          return (
            <View
              key={stableItemKey(profile, "profile")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "name") ??
                    fieldString(record, "id") ??
                    "配置"}
                </Text>
              </View>
              <PaseoFields
                fields={[
                  ["Provider", record?.provider],
                  ["模型", record?.model],
                  ["模式", record?.modeId],
                  ["思考强度", record?.thinkingOptionId],
                ]}
                palette={palette}
                styles={styles}
              />
              {fieldString(record, "notes") ? (
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "notes")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function FeatureList({
  features,
  palette,
  styles,
}: {
  features: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (features.length === 0) return null;
  return (
    <Section title={`功能（${features.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {features.map((feature) => {
          const record = asRecord(feature);
          return (
            <View
              key={stableItemKey(feature, "feature")}
              style={styles.paseoListItem}
            >
              <View style={styles.paseoListItemHeader}>
                <Text style={styles.paseoListItemTitle}>
                  {fieldString(record, "label") ??
                    fieldString(record, "id") ??
                    "功能"}
                </Text>
                {record?.value !== undefined ? (
                  <StatusPill
                    value={scalarText(record.value)}
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "description")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserTool({
  leaf,
  headerSummary,
  input,
  output,
  result,
  theme,
  palette,
  styles,
}: Omit<PaseoProps, "toolName"> & { leaf: string;
  headerSummary: string | undefined; result: unknown }) {
  const inputRecord = asRecord(input);
  const outputRecord = asRecord(output);
  const resultRecord = asRecord(result);
  const browserResult =
    resultRecord?.ok === true ? asRecord(resultRecord.result) : resultRecord;
  const browserFailure =
    outputRecord?.ok === false
      ? outputRecord
      : resultRecord?.ok === false
        ? resultRecord
        : null;
  if (browserFailure) {
    const error = asRecord(browserFailure.error);
    return (
      <View style={styles.paseoStack}>
        <PaseoFields
          fields={[
            ["浏览器标签页", unlessInHeader(inputRecord?.browserId, headerSummary)],
            ["错误", error?.message],
            ["可重试", error?.retryable],
          ]}
          palette={palette}
          styles={styles}
        />
        <StatusPill value="Failed" palette={palette} styles={styles} />
      </View>
    );
  }
  switch (leaf) {
    case "browser_list_tabs":
      return (
        <BrowserTabList
          tabs={fieldArray(asRecord(browserResult), "tabs")}
          palette={palette}
          styles={styles}
        />
      );
    case "browser_new_tab":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["浏览器标签页", unlessInHeader(asRecord(browserResult)?.browserId, headerSummary)],
              ["工作区", asRecord(browserResult)?.workspaceId],
              ["网址", unlessInHeader(asRecord(browserResult)?.url, headerSummary)],
            ]}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_snapshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["浏览器标签页", unlessInHeader(browserResult?.browserId, headerSummary)],
              ["网址", unlessInHeader(browserResult?.url, headerSummary)],
              ["标题", browserResult?.title],
              ["格式", browserResult?.format],
              ["已截断", browserResult?.truncated],
              ["统计", browserResult?.stats],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(browserResult, "snapshot") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "snapshot")!}
              language="yaml"
              label="页面结构"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    case "browser_screenshot":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["浏览器标签页", unlessInHeader(browserResult?.browserId, headerSummary)],
              ["MIME 类型", browserResult?.mimeType],
              ["宽度", browserResult?.width],
              ["高度", browserResult?.height],
              ["整页", inputRecord?.fullPage],
            ]}
            palette={palette}
            styles={styles}
          />
          <Text style={styles.mutedText}>
            截图已作为图片附件返回给 Agent。
          </Text>
        </View>
      );
    case "browser_logs":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["浏览器标签页", unlessInHeader(browserResult?.browserId, headerSummary)],
              ["最多条数", inputRecord?.maxEntries],
            ]}
            palette={palette}
            styles={styles}
          />
          <BrowserLogs
            consoleEntries={fieldArray(browserResult, "console")}
            networkEntries={fieldArray(browserResult, "network")}
            palette={palette}
            styles={styles}
          />
        </View>
      );
    case "browser_evaluate":
      return (
        <View style={styles.paseoStack}>
          <PaseoFields
            fields={[
              ["浏览器标签页", unlessInHeader(browserResult?.browserId, headerSummary)],
              ["元素", inputRecord?.ref],
            ]}
            palette={palette}
            styles={styles}
          />
          {fieldString(inputRecord, "function") ? (
            <PaseoCodeBlock
              code={fieldString(inputRecord, "function")!}
              language="javascript"
              label="函数"
              theme={theme}
              styles={styles}
            />
          ) : null}
          {fieldString(browserResult, "resultJson") ? (
            <PaseoCodeBlock
              code={fieldString(browserResult, "resultJson")!}
              language="json"
              label="结果"
              theme={theme}
              styles={styles}
            />
          ) : null}
        </View>
      );
    default: {
      const visible = (fields: Array<[string, unknown]>) =>
        fields
          .map(([label, value]) => [label, unlessInHeader(value, headerSummary)] as [string, unknown])
          .filter(([, value]) => value !== undefined);
      const inputFields = visible(browserInputFields(leaf, inputRecord));
      const outputFields = visible(browserOutputFields(leaf, browserResult));
      return (
        <View style={styles.paseoStack}>
          <PaseoFields fields={inputFields} palette={palette} styles={styles} />
          <PaseoFields fields={outputFields} palette={palette} styles={styles} />
        </View>
      );
    }
  }
}

function browserInputFields(
  leaf: string,
  input: JsonRecord | null
): Array<[string, unknown]> {
  if (!input) return [];
  const labels: Record<string, string> = {
    browserId: "浏览器标签页",
    ref: "元素",
    sourceRef: "起点元素",
    targetRef: "目标元素",
    url: "网址",
    value: "值",
    text: "文本",
    key: "按键",
    button: "鼠标按键",
    doubleClick: "双击",
    modifiers: "修饰键",
    filePaths: "文件",
    fullPage: "整页",
    maxEntries: "最多条数",
    timeoutMs: "超时（毫秒）",
    deltaX: "水平滚动",
    deltaY: "垂直滚动",
    width: "宽度",
    height: "高度",
    function: "函数",
  };
  const excluded = new Set(["browserId"]);
  return Object.entries(input)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        (!excluded.has(key) || leaf === "browser_list_tabs")
    )
    .map(([key, value]) => [labels[key] ?? humanizeKey(key), value]);
}

function browserOutputFields(
  leaf: string,
  result: JsonRecord | null
): Array<[string, unknown]> {
  if (!result) return [];
  const excluded = new Set([
    "command",
    "browserId",
    "snapshot",
    "console",
    "network",
    "resultJson",
  ]);
  return Object.entries(result)
    .filter(([key, value]) => value !== undefined && !excluded.has(key))
    .map(([key, value]) => [humanizeKey(key), value]);
}

function BrowserTabList({
  tabs,
  palette,
  styles,
}: {
  tabs: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  if (tabs.length === 0) {
    return <Text style={styles.empty}>没有返回浏览器标签页。</Text>;
  }
  return (
    <Section title={`浏览器标签页（${tabs.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {tabs.map((tab) => {
          const record = asRecord(tab);
          return (
            <View key={stableItemKey(tab, "tab")} style={styles.paseoListItem}>
              <View style={styles.paseoListItemHeader}>
                <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                  {fieldString(record, "title") ?? "无标题页面"}
                </Text>
                {fieldBoolean(record, "isActive") ? (
                  <StatusPill
                    value="Active"
                    palette={palette}
                    styles={styles}
                  />
                ) : null}
              </View>
              <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                {fieldString(record, "url")}
              </Text>
              <Text style={styles.paseoListItemMeta}>
                {fieldString(record, "browserId")}
              </Text>
            </View>
          );
        })}
      </View>
    </Section>
  );
}

function BrowserLogs({
  consoleEntries,
  networkEntries,
  palette,
  styles,
}: {
  consoleEntries: unknown[];
  networkEntries: unknown[];
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title={`控制台（${consoleEntries.length}）`} styles={styles}>
        <View style={styles.paseoList}>
          {consoleEntries.map((entry) => {
            const record = asRecord(entry);
            const level = fieldString(record, "level") ?? "log";
            return (
              <View
                key={stableItemKey(entry, "console")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text style={[styles.paseoListItemTitle, { color: statusColor(level, palette) }]}>{level}</Text>
                  <Text style={[styles.paseoListItemMeta, ROW_TAIL]}>
                    {fieldString(record, "source")}
                  </Text>
                </View>
                <Text selectable style={styles.paseoListItemMeta}>
                  {fieldString(record, "message")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
      <Section title={`网络请求（${networkEntries.length}）`} styles={styles}>
        <View style={styles.paseoList}>
          {networkEntries.map((entry) => {
            const record = asRecord(entry);
            return (
              <View
                key={stableItemKey(entry, "network")}
                style={styles.paseoListItem}
              >
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {fieldString(record, "method") ?? "请求"}{" "}
                    {fieldNumber(record, "status") ?? ""}
                  </Text>
                  <Text style={styles.paseoListItemMeta}>
                    {fieldNumber(record, "duration")} ms
                  </Text>
                </View>
                <Text numberOfLines={2} style={styles.paseoListItemMeta}>
                  {fieldString(record, "url")}
                </Text>
              </View>
            );
          })}
        </View>
      </Section>
    </View>
  );
}

function ExaResultList({
  results,
  styles,
}: {
  results: ExaSearchResult[];
  styles: ActivityStyles;
}) {
  return (
    <Section title={`结果（${results.length}）`} styles={styles}>
      <View style={styles.paseoList}>
        {results.map((result) => (
          <View key={result.url ?? result.title} style={styles.paseoListItem}>
            {/* 本地补丁（0.6.0，opus-F49）：标题样式带 flex: 1，放在 row 里才安全；直接放进自动高度的列，原生端可能塌成 0 高。 */}
            <View style={styles.paseoListItemHeader}>
              <Text selectable style={styles.paseoListItemTitle}>
                {result.title}
              </Text>
            </View>
            {result.url ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {result.url}
              </Text>
            ) : null}
            {result.published || result.author ? (
              <Text style={styles.paseoListItemMeta}>
                {[result.published, result.author].filter(Boolean).join(" · ")}
              </Text>
            ) : null}
            {result.highlights ? (
              <Text selectable style={styles.paseoListItemMeta}>
                {result.highlights}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Section>
  );
}

export function ExaToolDetail({
  toolName,
  input,
  output,
  theme,
  styles,
}: {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  styles: ActivityStyles;
}) {
  const kind = exaToolKind(toolName);
  if (!kind) return null;
  const results = kind === "search" ? parseExaSearchResults(output) : [];
  const outputText = exaOutputText(output);
  const inputRecord = asRecord(input);
  const query = fieldString(inputRecord, "query");
  const url = fieldString(inputRecord, "url");
  const prompt = fieldString(inputRecord, "prompt");
  const headerSummary = exaToolSummary(kind, input);
  const shownQuery = notInHeader(query, headerSummary);
  const shownUrl = notInHeader(url, headerSummary);
  const shownPrompt = notInHeader(prompt, headerSummary);
  return (
    <View style={styles.paseoStack}>
      {shownQuery ? <PromptBlock text={shownQuery} label="查询" styles={styles} /> : null}
      {shownUrl ? <PromptBlock text={shownUrl} label="网址" styles={styles} /> : null}
      {shownPrompt ? <PromptBlock text={shownPrompt} label="提示词" styles={styles} /> : null}
      {results.length > 0 ? (
        <ExaResultList results={results} styles={styles} />
      ) : outputText ? (
        <PaseoCodeBlock
          code={outputText}
          language="markdown"
          label="输出"
          theme={theme}
          styles={styles}
        />
      ) : (
        <PaseoCodeBlock
          code={formatUnknownValue(output)}
          language="json"
          label="输出"
          theme={theme}
          styles={styles}
        />
      )}
    </View>
  );
}

function FallbackPaseo({
  input,
  result,
  palette,
  styles,
}: {
  input: unknown;
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  return (
    <View style={styles.paseoStack}>
      <Section title="输入" styles={styles}>
        <PaseoFieldValue value={input} palette={palette} styles={styles} />
      </Section>
      <Section title="结果" styles={styles}>
        <PaseoFieldValue value={result} palette={palette} styles={styles} />
      </Section>
    </View>
  );
}

function PaseoFailure({
  result,
  palette,
  styles,
}: {
  result: unknown;
  palette: ActivityPalette;
  styles: ActivityStyles;
}) {
  const failure = asRecord(result);
  const error = asRecord(failure?.error);
  return (
    <View style={styles.paseoStack}>
      <StatusPill value="Failed" palette={palette} styles={styles} />
      <PaseoFields
        fields={[
          ["错误码", error?.code],
          ["错误", error?.message ?? failure?.error],
          ["可重试", error?.retryable],
        ]}
        palette={palette}
        styles={styles}
      />
    </View>
  );
}

// 本地补丁：常见字段名（Agent 能力、通用结果字段）的中文名；没列出的字段名属于数据，按原样人性化。
const FIELD_ZH: Readonly<Record<string, string>> = {
  supportsStreaming: "流式输出", supportsSessionPersistence: "会话持久化", supportsSessionListing: "列出会话",
  supportsDynamicModes: "动态切换模式", supportsMcpServers: "MCP 服务器", supportsReasoningStream: "思考过程流",
  supportsToolInvocations: "工具调用", supportsRewindConversation: "回退对话", supportsRewindFiles: "回退文件",
  supportsRewindBoth: "同时回退对话和文件",
  id: "ID", agentId: "Agent ID", workspaceId: "工作区 ID", projectId: "项目 ID", terminalId: "终端 ID", browserId: "浏览器标签页",
  title: "标题", name: "名称", status: "状态", cwd: "工作目录", provider: "Provider", model: "模型", mode: "模式",
  modeId: "模式", prompt: "提示词", message: "消息", error: "错误", output: "输出", result: "结果", url: "网址",
  path: "路径", branch: "分支", createdAt: "创建时间", updatedAt: "更新时间", startedAt: "开始时间", finishedAt: "结束时间",
  ok: "成功", success: "成功", count: "数量", total: "总数", description: "说明", labels: "标签", text: "文本",
};

function humanizeKey(key: string): string {
  if (FIELD_ZH[key]) return FIELD_ZH[key]!;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean);
  const sentence = words.join(" ").toLowerCase();
  return `${sentence[0]?.toUpperCase() ?? ""}${sentence.slice(1)}`;
}

export function PaseoToolDetail({
  toolName,
  input,
  output,
  theme,
  palette,
  styles,
}: PaseoProps) {
  const leaf = paseoToolLeafName(toolName);
  if (!leaf) return null;
  const result = paseoToolResult(output);
  const headerSummary = paseoToolSummary(toolName, input);
  if (asRecord(result)?.ok === false) {
    return <PaseoFailure result={result} palette={palette} styles={styles} />;
  }
  if (leaf.startsWith("browser_")) {
    return (
      <BrowserTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        output={output}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("agent") || leaf.includes("permission")) {
    return (
      <AgentTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("workspace") && !leaf.includes("script")) {
    return (
      <WorkspaceTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("terminal") || leaf.includes("workspace_script")) {
    return (
      <TerminalTool
        leaf={leaf}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("schedule") || leaf.includes("heartbeat")) {
    return (
      <ScheduleTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        theme={theme}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf.includes("provider") || leaf.includes("profile") || leaf === "list_models") {
    return (
      <ProviderTool
        leaf={leaf}
        headerSummary={headerSummary}
        input={input}
        result={result}
        palette={palette}
        styles={styles}
      />
    );
  }
  if (leaf === "speak") {
    const inputRecord = asRecord(input);
    return (
      <View style={styles.paseoStack}>
        <PromptBlock
          text={notInHeader(fieldString(inputRecord, "text"), headerSummary)}
          label="消息"
          styles={styles}
        />
        <ActionResult
          result={asRecord(result)}
          palette={palette}
          styles={styles}
        />
      </View>
    );
  }
  return (
    <FallbackPaseo
      input={input}
      result={result}
      palette={palette}
      styles={styles}
    />
  );
}
