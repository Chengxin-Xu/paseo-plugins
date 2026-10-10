import React from "react";
import { Text, View } from "react-native";
import { parseOmpFindResult } from "../shared/omp-find";
import type { ActivityStyles } from "./activity";

type OmpFindToolDetailProps = { input: unknown; output: unknown; styles: ActivityStyles };

export function OmpFindToolDetail({ input, output, styles }: OmpFindToolDetailProps) {
  const result = parseOmpFindResult(input, output);
  if (!result) return null;
  const summary = [
    result.listed !== undefined ? `列出 ${result.listed} 个` : undefined,
    result.judged !== undefined ? `评估 ${result.judged} 个` : undefined,
    result.filesRead !== undefined ? `读了 ${result.filesRead} 个文件` : undefined,
  ].filter(Boolean).join(" · ");
  return (
    <View style={styles.section}>
      {result.query ? <Text selectable style={styles.detailText}>{result.query}</Text> : null}
      {result.path ? <Text selectable style={styles.mutedText}>范围：{result.path}</Text> : null}
      {result.keywords.length ? <Text selectable style={styles.mutedText}>关键词：{result.keywords.join("、")}</Text> : null}
      {summary ? <Text style={styles.mutedText}>{summary}</Text> : null}
      {result.hits.length ? result.hits.map((hit) => (
        <View key={hit.path} style={styles.section}>
          <Text selectable style={styles.detailText}>
            {hit.path}{hit.score !== undefined ? ` · ${Math.round(hit.score * 100)}%` : ""}
          </Text>
          {hit.ranges.map((range, index) => (
            <Text key={`${range.start}-${range.end}-${index}`} selectable style={styles.mutedText}>
              {range.start === range.end ? `第 ${range.start} 行` : `第 ${range.start}–${range.end} 行`}
              {range.snippet ? `  ${range.snippet}` : ""}
            </Text>
          ))}
        </View>
      )) : <Text style={styles.empty}>没有匹配的文件。</Text>}
    </View>
  );
}
