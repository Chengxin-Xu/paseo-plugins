import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import React from "react";
import { View } from "react-native";
import type { ActivityStyles } from "./activity";
import { PaseoFields, Section } from "./paseo";
import {
  formatWaitTimeout,
  parseOmpWaitOutput,
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

const JOB_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  completed: "已完成",
  done: "已完成",
  failed: "失败",
  error: "失败",
  canceled: "已取消",
  cancelled: "已取消",
};

function displayStatus(status: string | undefined): string {
  if (!status) return "等待中";
  return JOB_STATUS_LABELS[status] ?? status;
}

export function OmpWaitToolDetail({ output, palette, styles }: DetailProps) {
  const jobs = parseOmpWaitOutput(output)?.jobs ?? [];

  return (
    <View style={styles.paseoStack}>
      {jobs.length > 0 ? (
        <Section title="Agent" styles={styles}>
          <PaseoFields
            fields={jobs.map((job) => [
              job.label ?? job.id,
              [
                displayStatus(job.status),
                job.durationMs !== undefined ? formatWaitTimeout(job.durationMs) : undefined,
                job.model,
              ]
                .filter(Boolean)
                .join(" · "),
            ])}
            palette={palette}
            styles={styles}
          />
        </Section>
      ) : null}
    </View>
  );
}
