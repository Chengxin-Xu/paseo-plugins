import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { Text, View } from "react-native";
import type { ActivityStyles } from "./activity";
import { FieldsSection, PaseoCodeBlock, Section } from "./paseo";
import {
  notInHeader,
  opencodeSubagentSummary,
  parseOpencodeSubagentInput,
  parseOpencodeSubagentOutput,
  type ActivityPalette,
} from "../shared/presentation";

type Theme = PluginTimelineItemProps["theme"];

type DetailProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  theme: Theme;
  palette: ActivityPalette;
  styles: ActivityStyles;
};

export function OpencodeSubagentToolDetail({ input, output, theme, palette, styles }: DetailProps) {
  const parsedInput = parseOpencodeSubagentInput(input);
  const parsedOutput = parseOpencodeSubagentOutput(output);
  const summary = opencodeSubagentSummary(input, output);
  const status = parsedOutput?.status;
  const sessionID = parsedOutput?.sessionID ?? parsedInput.sessionID;
  const resultText = parsedOutput?.text;

  return (
    <View style={styles.paseoStack}>
      <FieldsSection
        title="任务"
        fields={[
          ["Agent", notInHeader(parsedInput.agent, summary)],
          ["说明", notInHeader(parsedInput.description, summary)],
          ["模型", parsedInput.model],
          ["状态", status],
          ["会话", sessionID],
          ["继续会话", parsedInput.sessionID && parsedInput.sessionID !== sessionID ? parsedInput.sessionID : undefined],
          ["后台运行", parsedInput.background],
        ]}
        palette={palette}
        styles={styles}
      />
      {parsedInput.prompt ? (
        <PaseoCodeBlock
          code={parsedInput.prompt}
          language="text"
          label="提示词"
          theme={theme}
          styles={styles}
        />
      ) : null}
      {resultText && !parsedOutput?.isBackgroundNotice ? (
        <Section title="结果" styles={styles}>
          <Text selectable style={styles.detailText}>
            {resultText}
          </Text>
        </Section>
      ) : resultText ? (
        <Section title="状态" styles={styles}>
          <Text selectable style={styles.mutedText}>
            {resultText}
          </Text>
        </Section>
      ) : null}
    </View>
  );
}
