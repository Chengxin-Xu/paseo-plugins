import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { parsePiSubagentCall } from "../shared/pi-subagents";
import { bgWaitSummary, extractPiToolText, formatWaitTimeout, notInHeader, parseBgWaitInput, parseBgWaitOutput, parseSubagentSupervisorInput, subagentSupervisorSummary, textAfterHeader, type ActivityPalette, } from "../shared/presentation";
import type { ActivityStyles } from "./activity";
import { ReasoningMarkdown } from "./activity-details";
import { FieldsSection, PaseoCodeBlock, Section, StatusPill } from "./paseo";

type Theme = PluginTimelineItemProps["theme"];

type DetailProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
  agentType?: string;
  description?: string;
  childSessionId?: string;
};

function MessageBlock({ label, text, styles }: { label: string; text: string; styles: ActivityStyles }) {
  return (
    <Section title={label} styles={styles}>
      <Text selectable style={styles.paseoPrompt}>
        {text}
      </Text>
    </Section>
  );
}

export function PiSubagentToolDetail({ input, output, theme, palette, styles, agentType, description, childSessionId }: DetailProps) {
  const parsed = parsePiSubagentCall(input, output);
  return (
    <View style={styles.paseoStack}>
      <FieldsSection title="Agent" fields={[
        ["Agent ID", parsed.agentId], ["类型", agentType ?? parsed.agentType],
        ["说明", parsed.description ?? description], ["会话", childSessionId],
        ["模式", parsed.wait === true ? "阻塞等待" : parsed.wait === false ? "非阻塞查看结果" : undefined],
      ]} palette={palette} styles={styles} />
      {parsed.status ? <StatusPill value={parsed.status} palette={palette} styles={styles} /> : null}
      <FieldsSection title="用量" fields={[
        ["工具调用次数", parsed.toolUses], ["Token", parsed.tokens],
        ["上下文", parsed.context], ["耗时", parsed.duration],
      ]} palette={palette} styles={styles} />
      <FieldsSection title="对话记录" fields={[["输出文件", parsed.outputFile]]} palette={palette} styles={styles} />
      {parsed.error ? <Section title="错误" styles={styles}>
        <Text selectable style={[styles.detailText, { color: palette.statusColors.failed }]}>{parsed.error}</Text>
      </Section> : null}
      {parsed.notice ? <Text style={styles.mutedText}>{parsed.notice}</Text> : null}
      {parsed.prompt ? <MessageBlock label="提示词" text={parsed.prompt} styles={styles} /> : null}
      {parsed.message ? <MessageBlock label="引导消息" text={parsed.message} styles={styles} /> : null}
      {parsed.body ? <Section title="结果" styles={styles}>
        <ReasoningMarkdown text={parsed.body} theme={theme} styles={styles} />
      </Section> : null}
    </View>
  );
}

export function SupervisorToolDetail({ input, output, palette, styles }: DetailProps) {
  const parsed = parseSubagentSupervisorInput(input);
  const envelope = extractPiToolText(output);
  const details = envelope?.details ?? {};
  const agent = typeof details.agent === "string" && details.agent.trim() ? details.agent : undefined;
  const runId = typeof details.runId === "string" && details.runId.trim() ? details.runId : undefined;
  const replyTo = parsed.replyTo ?? (typeof details.replyTo === "string" ? details.replyTo : undefined);
  const headerSummary = subagentSupervisorSummary(input, output);
  const knownAction = ["reply", "pending", "list", "status"].includes(parsed.action);
  const resultText = textAfterHeader(envelope?.text, headerSummary);
  const message = notInHeader(parsed.message, headerSummary);

  return (
    <View style={styles.paseoStack}>
      {parsed.action === "reply" ? (
        <>
          {message ? <MessageBlock label="回复消息" text={message} styles={styles} /> : null}
          <FieldsSection
            title="请求"
            fields={[
              ["请求 ID", replyTo],
              ["运行", runId],
              ["Agent", notInHeader(agent, headerSummary)],
              ["确认", envelope?.text || undefined],
            ]}
            palette={palette}
            styles={styles}
          />
        </>
      ) : (
        <>
          <FieldsSection
            title="查询"
            fields={[
              ["操作", knownAction ? undefined : parsed.action || undefined],
              ["发给", notInHeader(parsed.to, headerSummary)],
              ["消息", message],
            ]}
            palette={palette}
            styles={styles}
          />
          {resultText ? (
            <MessageBlock label="结果" text={resultText} styles={styles} />
          ) : envelope?.text ? null : (
            <Text style={styles.empty}>没有待处理的子 Agent 请求。</Text>
          )}
        </>
      )}
    </View>
  );
}

export function BgWaitToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsed = parseBgWaitInput(input);
  const summary = parseBgWaitOutput(output);
  const headerSummary = bgWaitSummary(input, output);
  const timeout = formatWaitTimeout(parsed.timeoutMs);

  return (
    <View style={styles.paseoStack}>
      {summary?.headline ? (
        <Section title="概况" styles={styles}>
          <Text selectable style={styles.detailText}>
            {summary.headline}
          </Text>
        </Section>
      ) : null}
      <FieldsSection
        title="等待"
        fields={[
          ["运行", parsed.id],
          ["超时", notInHeader(timeout ? `${timeout} timeout` : undefined, headerSummary)],
          ["非阻塞", parsed.nonBlocking],
          ["需要关注时停止", parsed.stopOnAttention],
          ["进行中的运行", summary && summary.activeRunIds.length > 0 ? summary.activeRunIds.join(", ") : undefined],
          [
            "Provider 条目",
            summary && summary.activeProviderItems.length > 0
              ? summary.activeProviderItems.map((item) => `${item.provider}:${item.id}`).join(", ")
              : undefined,
          ],
        ]}
        palette={palette}
        styles={styles}
      />
      {summary && summary.completions.length > 0 ? (
        <Section title={`已完成（${summary.completions.length}）`} styles={styles}>
          <View style={styles.paseoList}>
            {summary.completions.map((completion) => (
              <View key={`completion-${completion.runId}-${completion.agent ?? "run"}`} style={styles.paseoListItem}>
                <View style={styles.paseoListItemHeader}>
                  <Text numberOfLines={1} style={styles.paseoListItemTitle}>
                    {completion.agent ?? "运行结束"}
                  </Text>
                  {completion.success !== undefined ? (
                    <StatusPill
                      value={completion.success ? "Success" : "Failed"}
                      palette={palette}
                      styles={styles}
                    />
                  ) : null}
                </View>
                <Text numberOfLines={1} style={styles.paseoListItemMeta}>
                  {completion.runId}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {summary?.body ? (
        <PaseoCodeBlock code={summary.body} language="text" label="等待日志" theme={theme} styles={styles} />
      ) : null}
    </View>
  );
}
