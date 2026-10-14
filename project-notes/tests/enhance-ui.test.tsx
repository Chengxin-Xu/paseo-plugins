import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { Editor } from "../client/editor";

const host = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useRpc: () => host.probe }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ ScrollView: "ScrollView" }));
vi.mock("react-native", () => ({ View: "View" }));
vi.mock("../client/kit", () => ({ Banner: "Banner", Button: "Button", Chip: "Chip", Segmented: "Segmented", Spacer: "Spacer", hairline: 1, space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20 } }));
vi.mock("../client/projects", () => ({ ProjectList: "ProjectList" }));
vi.mock("../client/ui", () => ({ FieldLabel: "FieldLabel", FormField: "FormField", PickerButton: "PickerButton", ScopeMark: "ScopeMark", StatusSegmented: "StatusSegmented", KINDS: ["prompt"], KIND_LABELS: { prompt: "提示词" }, KIND_ICONS: {}, KIND_TONES: {}, MARK_HUES: {} }));
const { EditorForm } = await import("../client/editor");
let renderer: ReactTestRenderer | undefined;
afterEach(async () => { if (renderer) await act(async () => renderer!.unmount()); renderer = undefined; vi.resetAllMocks(); });
const draft: Editor = { original: null, projectId: "project", fields: { kind: "prompt", title: "检查项目", body: "已有草稿", status: "todo", pinned: false, priority: "normal" } };
function props(editor = draft) {
  return { theme: { colors: {} }, editor, projects: [{ id: "project", name: "项目", path: "/example" }], projectName: () => "项目", busy: false, compact: false, error: null, changedElsewhere: false, onChange: vi.fn(), onProject: vi.fn(), onCancel: vi.fn(), onSave: vi.fn(), onCopyDraft: vi.fn(), onLoadLatest: vi.fn() } as unknown as Parameters<typeof EditorForm>[0];
}
async function mount(value: Parameters<typeof EditorForm>[0]) { await act(async () => { renderer = create(createElement(EditorForm, value)); }); }
const button = () => renderer!.root.find(node => (node.type as unknown) === "Button" && node.props.label === "生成四段模板");
describe("prompt template editing", () => {
  it("fills the template from the selected project without saving it automatically", async () => {
    host.probe.mockResolvedValue({ languages: ["TypeScript"], testCommands: ["npm run test"], notices: [] });
    const value = props(); await mount(value); await act(async () => { button().props.onPress(); });
    expect(host.probe).toHaveBeenCalledWith({ projectId: "project" });
    expect(value.onChange).toHaveBeenCalledWith({ body: expect.stringContaining("npm run test") });
    expect(value.onSave).not.toHaveBeenCalled();
  });
  it("preserves a newer draft when an earlier probe arrives late", async () => {
    let finish!: (value: unknown) => void; host.probe.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const value = props(); await mount(value); await act(async () => { button().props.onPress(); });
    await act(async () => { renderer!.update(createElement(EditorForm, { ...value, editor: { ...draft, fields: { ...draft.fields, body: "刚刚输入" } } })); });
    await act(async () => { finish({ languages: [], testCommands: [], notices: [] }); });
    expect(value.onChange).not.toHaveBeenCalled();
    expect(renderer!.root.findAll(node => (node.type as unknown) === "Banner")[0]!.props.message).toContain("草稿已变化");
  });
  it("keeps drafts after a probe error and does not expose enhancement for an ordinary idea", async () => {
    host.probe.mockRejectedValue(new Error("读取项目失败")); const value = props(); await mount(value);
    await act(async () => { button().props.onPress(); }); expect(value.onChange).not.toHaveBeenCalled();
    expect(renderer!.root.findAll(node => (node.type as unknown) === "Banner")[0]!.props.message).toBe("读取项目失败");
    await act(async () => { renderer!.update(createElement(EditorForm, { ...value, editor: { ...draft, fields: { ...draft.fields, kind: "idea" } } })); });
    expect(renderer!.root.findAll(node => node.props.label === "生成四段模板")).toHaveLength(0);
  });
});
