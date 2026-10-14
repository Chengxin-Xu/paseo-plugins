import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ OS: "web" }));
vi.mock("react-native", () => ({ Platform: platform }));
import { findComposerDraft } from "../client/web";

class NativeTextarea {
  text = "";
  get value() { return this.text; }
  set value(value: string) { this.text = value; }
}
class Input extends NativeTextarea {
  disabled = false; readOnly = false; isConnected = true; visible = true;
  dispatchEvent = vi.fn(() => true);
  getClientRects() { return { length: this.visible ? 1 : 0 }; }
  ownerDocument = { defaultView: { HTMLTextAreaElement: NativeTextarea, Event: class { constructor(readonly type: string, readonly options: { bubbles: boolean }) {} } } };
}
let inputs: Input[];
beforeEach(() => {
  platform.OS = "web";
  inputs = [new Input()];
  vi.stubGlobal("document", { querySelectorAll: vi.fn(() => inputs) });
});
afterEach(() => vi.unstubAllGlobals());

describe("web composer drafts", () => {
  it("uses the native value setter and bubbling input event, then restores the previous draft", () => {
    const input = inputs[0]!, reactSetter = vi.fn();
    Object.defineProperty(input, "value", { get: () => input.text, set: reactSetter });
    input.text = "原草稿";
    const draft = findComposerDraft()!;
    const undo = draft.fill("新提示词", draft.read()!, "replace")!;
    expect(input.value).toBe("新提示词");
    expect(reactSetter).not.toHaveBeenCalled();
    expect(input.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "input", options: { bubbles: true } }));
    expect(undo.undo()).toBe(true);
    expect(input.value).toBe("原草稿");
    expect(undo.undo()).toBe(false);
  });
  it("appends with a blank line and never overwrites an intervening edit", () => {
    const input = inputs[0]!;
    input.value = "已有草稿";
    const draft = findComposerDraft()!;
    expect(draft.fill("新提示词", "过时的草稿", "replace")).toBeNull();
    const undo = draft.fill("新提示词", input.value, "append")!;
    expect(input.value).toBe("已有草稿\n\n新提示词");
    input.value += "，用户又改了";
    expect(undo.undo()).toBe(false);
    expect(input.value).toContain("用户又改了");
  });
  it("does not restore after sending or switching the composer", () => {
    const input = inputs[0]!, draft = findComposerDraft()!;
    const undo = draft.fill("提示词", "", "replace")!;
    input.value = "";
    expect(undo.undo()).toBe(false);
    input.value = "提示词";
    inputs = [new Input()];
    expect(draft.read()).toBeNull();
    expect(undo.undo()).toBe(false);
  });
  it("hides native, absent, readonly, invisible and ambiguous composer targets", () => {
    for (const os of ["ios", "android", "macos"]) {
      platform.OS = os;
      expect(findComposerDraft()).toBeNull();
    }
    platform.OS = "web";
    const input = inputs[0]!;
    input.readOnly = true; expect(findComposerDraft()).toBeNull();
    input.readOnly = false; input.visible = false; expect(findComposerDraft()).toBeNull();
    input.visible = true; inputs.push(new Input()); expect(findComposerDraft()).toBeNull();
    inputs = []; expect(findComposerDraft()).toBeNull();
    vi.stubGlobal("document", undefined); expect(findComposerDraft()).toBeNull();
  });
  it("revalidates the native gate and candidate identity before changing a captured draft", () => {
    const draft = findComposerDraft()!;
    platform.OS = "ios";
    expect(draft.fill("提示词", "", "replace")).toBeNull();
    expect(draft.read()).toBeNull();
  });
});
