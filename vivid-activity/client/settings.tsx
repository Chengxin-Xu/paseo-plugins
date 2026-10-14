import { useMemo } from "react";
import { Text } from "react-native";
import {
  useSettings,
  type PluginSurfaceProps,
  type SettingsState,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import {
  activitySettings,
  DEFAULT_EXPANSION,
  densitySchema,
  expansionModeSchema,
  paletteModeSchema,
  takeoverScopeSchema,
  visibleExpansionTargets,
} from "../shared/settings";
import type { Density, ExpansionMode, ExpansionTarget, TakeoverScope } from "../shared/settings";
import { toneColor } from "./kit";

export interface SettingsActions { onFoldSettings(value: { enabled?: boolean; scope?: TakeoverScope }): void; onTakeover(scope: TakeoverScope): void }

type ReadySettings = Extract<SettingsState<typeof activitySettings.schema>, { status: "ready" }>;

const takeoverOptions = [
  { value: "all", label: "全部" },
  { value: "reasoning", label: "仅思考行" },
  { value: "off", label: "关闭" },
];

const takeoverDescriptions: Record<TakeoverScope, string> = {
  all: "思考行和工具调用行都换成彩色中文行。",
  reasoning: "只重绘思考行；工具行保持 Paseo 原样，可以按「摘要」合并、点路径打开文件。",
  off: "全部交还 Paseo 原样显示；插件保持安装，随时可以重新打开。",
};

const TAKEOVER_COSTS = [
  "· 「设置 → 聊天 → 工具调用显示 → 摘要」不再把工具行合并成一句",
  "· 不能点文件路径直接打开文件",
  "· 手机上工具详情改为在行内展开，不再弹出详情页",
].join("\n");

const paletteOptions = [
  { value: "vivid", label: "鲜明" },
  { value: "theme", label: "跟随主题色" },
  { value: "soft", label: "柔和" },
  { value: "high_contrast", label: "高对比" },
];

const paletteDescriptions = {
  vivid: "每类工具一个颜色（思考紫、读文件蓝、改文件绿、命令橙、搜索靛……）；运行中蓝色转圈、等你批准琥珀闪动、失败红色、完成绿色。",
  theme: "原版 colorful-agent-activity 的配色：图标取当前主题的强调色，行背景保持中性。",
  soft: "图标基本中性，只有状态有颜色。",
  high_contrast: "更粗的分隔线和更强的状态色。",
} as const;

const expansionOptions = [
  { value: "always", label: "总是展开" },
  { value: "latest", label: "只展开最新" },
  { value: "never", label: "默认收起" },
];

const expansionDescriptions = {
  always: "不论新旧都展开。",
  latest: "只有最新一行展开，后面来了新行就收起。",
  never: "一开始收起，运行中也一样；点一下即可展开。",
} as const;

function expansionDescription(target: ExpansionTarget, mode: ExpansionMode): string {
  if (target !== "todo") return expansionDescriptions[mode];
  if (mode === "always") return "任务清单类工具行总是展开。";
  if (mode === "never") return "任务清单类工具行默认收起。";
  return "只展开最新的任务清单类工具行。";
}

function TakeoverControls({ settings, actions }: { settings: ReadySettings; actions: SettingsActions }) {
  const scope = settings.values.takeover;
  const changeScope = (value: string) => {
    const parsed = takeoverScopeSchema.safeParse(value);
    if (!parsed.success || parsed.data === scope) return;
    const next = parsed.data;
    void settings.save({ ...settings.values, takeover: next }, settings.revision).then((saved) => {
      if (!saved) return;
      actions.onFoldSettings({ scope: next });
      actions.onTakeover(next);
    });
  };
  return (
    <SettingsSection title="接管范围">
      <SettingsCard>
        <SettingsSelect
          label="接管"
          hint={takeoverDescriptions[scope]}
          value={scope}
          options={takeoverOptions}
          disabled={settings.saving}
          onValueChange={changeScope}
        />
        {scope === "all" ? <SettingsRow label="接管工具行的代价" hint={TAKEOVER_COSTS} /> : null}
        <SettingsRow
          label="始终由 Paseo 显示"
          hint="计划卡、任务行、审批卡，以及 Bots 等插件自己的卡片。改动对所有设备生效。"
        />
      </SettingsCard>
    </SettingsSection>
  );
}

const densityOptions = [
  { value: "compact", label: "紧凑" },
  { value: "standard", label: "标准" },
];

const densityDescriptions: Record<Density, string> = {
  compact: "行更矮，行与行之间只留 4px（抵掉 Paseo 给每条插件行加的 16px 间距）；同样一屏，手机多放约两成、桌面多放约四成。",
  standard: "行高和行距与之前的版本相同，行与行之间留 10px。",
};

const FOLD_HINT =
  "一段思考和工具调用全部完成后收成一行：类别计数、失败数和用时，点一下展开，再点收起。" +
  "运行中的段只留运行中、等你批准、失败的行和最近两步，更早的收成「前面 N 步」。改动对所有设备生效。";

const PIN_HINT =
  "Agent 干了很久、中间说过几段话之后，把你这一轮的提问钉在最新一段活动的上方：默认显示三行，点一下看全文，可以复制。" +
  "提问还在附近（大约一屏之内）时不显示。改动对所有设备生效。";

function foldScopeNote(scope: TakeoverScope): string | null {
  if (scope === "reasoning") return "现在只接管思考行：只有相邻的思考行会折叠；工具行由 Paseo 显示，可用「设置 → 聊天 → 工具调用显示 → 摘要」合并。";
  if (scope === "off") return "接管已关闭，折叠和行密度在重新打开接管后生效。";
  return null;
}

function FoldControls({ settings, actions }: { settings: ReadySettings; actions: SettingsActions }) {
  const fold = settings.values.fold;
  const density = settings.values.density;
  const note = foldScopeNote(settings.values.takeover);
  const changeFold = (value: boolean) => {
    if (value === fold) return;
    void settings.save({ ...settings.values, fold: value }, settings.revision).then((saved) => {
      if (saved) actions.onFoldSettings({ enabled: value });
    });
  };
  const changeDensity = (value: string) => {
    const parsed = densitySchema.safeParse(value);
    if (!parsed.success || parsed.data === density) return;
    void settings.save({ ...settings.values, density: parsed.data }, settings.revision);
  };
  const pinPrompt = settings.values.pinPrompt;
  const changePin = (value: boolean) => {
    if (value === pinPrompt) return;
    void settings.save({ ...settings.values, pinPrompt: value }, settings.revision);
  };
  return (
    <SettingsSection title="折叠、行距与提问">
      <SettingsCard>
        <SettingsSwitch
          label="完成后折叠连续的思考与工具行"
          hint={FOLD_HINT}
          value={fold}
          disabled={settings.saving}
          onValueChange={changeFold}
        />
        <SettingsSelect
          label="行密度"
          hint={densityDescriptions[density]}
          value={density}
          options={densityOptions}
          disabled={settings.saving}
          onValueChange={changeDensity}
        />
        <SettingsSwitch
          label="钉住本轮提问"
          hint={PIN_HINT}
          value={pinPrompt}
          disabled={settings.saving}
          onValueChange={changePin}
        />
        {note ? <SettingsRow label="接管范围" hint={note} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ExpansionControls({ settings }: { settings: ReadySettings }) {
  const changeExpansion = (target: ExpansionTarget) => (value: string) => {
    const parsed = expansionModeSchema.safeParse(value);
    if (!parsed.success) return;
    const mode: ExpansionMode = parsed.data;
    void settings.save(
      { ...settings.values, expansion: { ...DEFAULT_EXPANSION, ...settings.values.expansion, [target]: mode } },
      settings.revision,
    );
  };
  return (
    <SettingsSection title="展开方式">
      <SettingsCard>
        {visibleExpansionTargets(settings.values.takeover).map((target) => {
          const mode = settings.values.expansion?.[target.key] ?? target.default;
          return (
            <SettingsSelect
              key={target.key}
              label={target.label}
              hint={expansionDescription(target.key, mode)}
              value={mode}
              options={expansionOptions}
              disabled={settings.saving}
              onValueChange={changeExpansion(target.key)}
            />
          );
        })}
      </SettingsCard>
    </SettingsSection>
  );
}

function PaletteControls({ settings, theme }: { settings: ReadySettings; theme: PluginSurfaceProps["theme"] }) {
  const errorStyle = useMemo(
    () => ({ color: toneColor(theme, "danger"), fontSize: 13, lineHeight: 18 }),
    [theme],
  );
  const changePalette = (value: string) => {
    const parsed = paletteModeSchema.safeParse(value);
    if (!parsed.success) return;
    void settings.save({ ...settings.values, palette: parsed.data }, settings.revision);
  };
  return (
    <SettingsSection title="配色">
      <SettingsCard>
        {settings.values.takeover === "off" ? (
          <SettingsRow label="接管已关闭" hint="下面的配色和展开方式在重新打开接管后生效。" />
        ) : null}
        <SettingsSelect
          label="调色板"
          hint={paletteDescriptions[settings.values.palette]}
          value={settings.values.palette}
          options={paletteOptions}
          disabled={settings.saving}
          onValueChange={changePalette}
        />
      </SettingsCard>
      {settings.saveError ? <Text accessibilityRole="alert" style={errorStyle}>{settings.saveError}</Text> : null}
    </SettingsSection>
  );
}

export function ActivitySettings({ theme, actions }: PluginSurfaceProps & { actions: SettingsActions }) {
  const settings = useSettings(activitySettings);
  const textStyle = useMemo(() => ({ color: theme.colors.foreground }), [theme.colors.foreground]);
  if (settings.status === "loading") return <Text style={textStyle}>正在读取设置…</Text>;
  if (settings.status === "error") {
    return (
      <SettingsSection title="彩色活动行">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="设置" actionLabel="重新读取" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="彩色活动行">
        <Text style={textStyle}>{settings.error}</Text>
        <SettingsAction label="已保存的设置" actionLabel="恢复默认" onPress={settings.reset} />
        <SettingsAction label="已保存的设置" actionLabel="重新读取" onPress={settings.reload} />
      </SettingsSection>
    );
  }
  return (
    <>
      <TakeoverControls settings={settings} actions={actions} />
      <FoldControls settings={settings} actions={actions} />
      <PaletteControls settings={settings} theme={theme} />
      <ExpansionControls settings={settings} />
    </>
  );
}
