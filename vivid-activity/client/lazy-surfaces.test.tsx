import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { activitySettings } from "../shared/settings";

const host = vi.hoisted(() => ({ settings: {} as any }));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => host.settings }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsAction: "SettingsAction", SettingsCard: "SettingsCard", SettingsRow: "SettingsRow", SettingsSection: "SettingsSection", SettingsSelect: "SettingsSelect", SettingsSwitch: "SettingsSwitch" }));
vi.mock("react-native", () => ({ Text: "Text" }));
vi.mock("./language-settings", () => ({ LanguageSettings: () => null }));
vi.mock("./i18n-client", () => ({ useI18n: () => undefined }));
vi.mock("./kit", () => ({ toneColor: () => "#ffffff" }));
// 0.8.0: the running animations preview draws live loaders (fx code); the settings logic is what this test covers.
vi.mock("./loader-preview", () => ({ LoaderPreview: () => null, loaderLabels: { spinner: "转圈", sparkle: "星芒", orb: "光球", snake: "点阵 · 蛇形", matrix: "点阵 · 闪烁" } }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useMemo: (compute: () => unknown) => compute() }));

import { ActivitySettings, type SettingsActions } from "./settings";
import { PlainDetail } from "./activity-lazy";

function controls(node: ReactNode): Array<{ type: unknown; props: any }> {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(controls);
  const element = node as ReactElement<any>;
  if (typeof element.type === "function") return controls((element.type as (props: any) => ReactNode)(element.props));
  return [element, ...controls(element.props?.children)];
}
const settle = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

describe("lazy activity surfaces", () => {
  let actions: SettingsActions;
  beforeEach(() => {
    host.settings = { status: "ready", values: activitySettings.schema.parse({}), revision: "revision-1", saving: false, save: vi.fn(async () => true) };
    actions = { onFoldSettings: vi.fn(), onTakeover: vi.fn() };
  });
  const renderSettings = () => controls(ActivitySettings({ theme: { colors: { foreground: "#fff" } }, actions } as any));

  it("sends saved takeover and fold changes back to the eager runtime through props", async () => {
    const rendered = renderSettings();
    rendered.find((entry) => entry.props.label === "接管")!.props.onValueChange("off");
    expect(actions.onTakeover).not.toHaveBeenCalled();
    await settle();
    expect(actions.onFoldSettings).toHaveBeenCalledWith({ scope: "off" });
    expect(actions.onTakeover).toHaveBeenCalledWith("off");
    rendered.find((entry) => entry.type === "SettingsSwitch")!.props.onValueChange(false);
    await settle();
    expect(actions.onFoldSettings).toHaveBeenCalledWith({ enabled: false });
    expect(host.settings.save).toHaveBeenCalledWith(expect.objectContaining({ takeover: "off" }), "revision-1");
  });

  it("does not apply unsaved settings when a concurrent revision loses", async () => {
    host.settings.save.mockResolvedValue(false);
    const rendered = renderSettings();
    rendered.find((entry) => entry.props.label === "接管")!.props.onValueChange("off");
    rendered.find((entry) => entry.type === "SettingsSwitch")!.props.onValueChange(false);
    await settle();
    expect(actions.onFoldSettings).not.toHaveBeenCalled();
    expect(actions.onTakeover).not.toHaveBeenCalled();
  });

  it("shows readable plain text before detail code loads, including file bodies and empty-output commands", () => {
    const text = (props: any) => PlainDetail(props).props.children;
    expect(text({ data: { detail: { type: "shell", output: "", command: "npm run check" } } })).toBe("npm run check");
    expect(text({ data: { detail: { type: "read", content: "const answer = 42" } } })).toBe("const answer = 42");
    expect(text({ data: { detail: { type: "edit", unifiedDiff: "-old\n+new" } } })).toBe("-old\n+new");
    expect(text({ text: "\u001b[31m思考中\u001b[0m" })).toBe("思考中");
    expect(text({ text: "x".repeat(10_000) })).toHaveLength(4000);
    expect(text({})).toBe("正在加载详情…");
  });
});
