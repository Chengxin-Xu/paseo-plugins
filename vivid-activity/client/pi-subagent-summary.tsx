import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { ActivityStyles } from "./activity";
import type { ActivityPalette } from "../shared/presentation";
import { parsePiSubagentCall } from "../shared/pi-subagents";
import { StatusPill } from "./status-pill";
type DetailProps = { output: unknown; palette: ActivityPalette; styles: ActivityStyles; toolName: string; input: unknown; theme: PluginTimelineItemProps["theme"] };
export function PiSubagentLifecycleSummary({ output, palette, styles }: DetailProps) {
  const parsed = parsePiSubagentCall(undefined, output);
  if (!parsed.lifecycle) return null;
  const usage = [
    parsed.toolUses !== undefined ? `${parsed.toolUses} 次工具调用` : undefined,
    parsed.tokens ? `${parsed.tokens} token` : undefined,
    parsed.context ? `上下文 ${parsed.context}` : undefined,
    parsed.duration,
  ].filter(Boolean).join(" · ");
  return (
    <View style={styles.subAgentProgress}>
      <View style={styles.subAgentLine}>
        {parsed.status ? <StatusPill value={parsed.status} palette={palette} styles={styles} /> : null}
        {/* 0.6.0 (opus-F49): beside the pill on a phone the usage wraps instead of running off the row (native Text does not shrink). */}
        {usage ? <Text style={[styles.mutedText, { flexShrink: 1 }]}>{usage}</Text> : null}
      </View>
      {parsed.error ? <Text style={[styles.detailText, { color: palette.statusColors.failed }]}>{parsed.error}</Text> : null}
      {parsed.notice ? <Text style={styles.mutedText}>{parsed.notice}</Text> : null}
    </View>
  );
}
