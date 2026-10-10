import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { INBOX_PROJECT_ID, type BoardProject } from "../shared/board";
import { Row, SearchField, fontSize, space, toneColor } from "./kit";
import { ScopeMark } from "./ui";


/**
 * Searchable project list (scope sheet and the editor's 保存到 picker). Rows keep the kit inset, so the caller removes 12 px
 * of its padding. Projects in `unavailable` (boards left out of the overview for their size) say so instead of a count.
 */
export function ProjectList({ theme, projects, selectedId, counts, unavailable, onSelect, loading = false, searchLabel = "搜索项目" }: {
  theme: PluginTheme; projects: readonly BoardProject[]; selectedId: string; counts?: ReadonlyMap<string, number>; unavailable?: ReadonlySet<string>; onSelect: (project: BoardProject) => void; loading?: boolean; searchLabel?: string;
}) {
  const { colors } = theme;
  const [search, setSearch] = useState("");
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return needle ? projects.filter(project => `${project.name} ${project.path}`.toLowerCase().includes(needle)) : projects;
  }, [projects, search]);
  return <View style={{ gap: space.sm }}>
    {projects.length > 6 ? <View style={{ paddingHorizontal: space.md }}><SearchField theme={theme} value={search} onChangeText={setSearch} placeholder="搜索项目或路径" accessibilityLabel={searchLabel} /></View> : null}
    <View>
      {rows.map(project => {
        const selected = project.id === selectedId, count = counts?.get(project.id) ?? 0;
        return <Row key={project.id} theme={theme} title={project.name} titleLines={1} selected={selected} onPress={() => onSelect(project)} accessibilityLabel={project.name}
          leading={<ScopeMark theme={theme} project={project} size={20} />}
          subtitle={project.id !== INBOX_PROJECT_ID && project.path ? project.path : undefined}
          trailing={selected ? <Icon name="Check" size={16} color={toneColor(theme, "accent")} /> : unavailable?.has(project.id) ? <Text style={{ color: toneColor(theme, "warning"), fontSize: fontSize.meta }}>不可用</Text>
            : count ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{count}</Text> : null} />;
      })}
      {!rows.length ? <Text style={{ paddingHorizontal: space.md, paddingVertical: space.md, color: colors.foregroundMuted, fontSize: fontSize.small }}>{loading ? "正在读取项目…" : "没有匹配的项目"}</Text> : null}
    </View>
  </View>;
}
