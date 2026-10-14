import { describe, expect, it } from "vitest";
import { ansiColourPrefix, hasAnsi, outputView, PREVIEW_CHARS, PREVIEW_LINES, resolveToolCallPresentation, stripAnsi } from "./presentation";

const ESC = "\u001b";
const BEL = "\u0007";
const ST = `${ESC}\\`;

describe("stripAnsi: terminal escape sequences out of tool output (0.5.0)", () => {
  it("drops CSI sequences: colours, cursor moves, erasing, private modes", () => {
    expect(stripAnsi(`${ESC}[31mFAIL${ESC}[0m src/a.test.ts`)).toBe("FAIL src/a.test.ts");
    expect(stripAnsi(`${ESC}[1;32m✓${ESC}[39;22m 12 passed`)).toBe("✓ 12 passed");
    expect(stripAnsi(`${ESC}[38;2;255;100;0mrgb${ESC}[m ${ESC}[38:5:208mcolon${ESC}[0m`)).toBe("rgb colon");
    expect(stripAnsi(`${ESC}[2K${ESC}[1A${ESC}[1G[3/5] building${ESC}[?25l${ESC}[?25h`)).toBe("[3/5] building");
    expect(stripAnsi(`\u009b31mC1 CSI\u009b0m`)).toBe("C1 CSI");
  });

  it("drops OSC sequences ending in BEL or in ST (titles, hyperlinks)", () => {
    expect(stripAnsi(`${ESC}]0;npm test${BEL}done`)).toBe("done");
    expect(stripAnsi(`see ${ESC}]8;;https://example.com/docs${ST}the docs${ESC}]8;;${ST}.`)).toBe("see the docs.");
    expect(stripAnsi(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe("link");
    expect(stripAnsi(`\u009d0;title\u009cafter`)).toBe("after");
    // DCS, SOS, PM and APC end like OSC.
    expect(stripAnsi(`a${ESC}P1$r0m${ST}b${ESC}_app${ST}c${ESC}^pm${BEL}d`)).toBe("abcd");
  });

  it("drops the other escape sequences: character sets, two-character controls", () => {
    expect(stripAnsi(`${ESC}(Bplain${ESC})0 text${ESC}7${ESC}8${ESC}=${ESC}>${ESC}c`)).toBe("plain text");
  });

  it("drops incomplete sequences without eating the text after them", () => {
    // Cut off at the end of the text.
    expect(stripAnsi(`ok${ESC}[3`)).toBe("ok");
    expect(stripAnsi(`ok${ESC}[`)).toBe("ok");
    expect(stripAnsi(`ok${ESC}`)).toBe("ok");
    expect(stripAnsi(`ok${ESC}]8;;https://exa`)).toBe("ok");
    // An OSC that never ends stops at the end of its line, keeping the line break and the lines below.
    expect(stripAnsi(`a${ESC}]0;title\nnext line\n`)).toBe("a\nnext line\n");
    expect(stripAnsi(`a${ESC}]0;title\r\nnext`)).toBe("a\r\nnext");
    // ...or where the next sequence starts.
    expect(stripAnsi(`a${ESC}]0;title${ESC}[31mred${ESC}[0m`)).toBe("ared");
    // A CSI broken by a byte that cannot be in it: the introducer and parameters go, the byte stays.
    expect(stripAnsi(`x${ESC}[31\nz`)).toBe("x\nz");
    expect(stripAnsi(`x${ESC}[12${ESC}[0my`)).toBe("xy");
    // A lone ESC before ordinary text.
    expect(stripAnsi(`x${ESC}\ny`)).toBe("x\ny");
  });

  it("returns text without escape sequences as the very same string", () => {
    const text = "plain output\nwith [brackets] and ]8;; lookalikes\n中文 ✓\n";
    expect(stripAnsi(text)).toBe(text);
    expect(hasAnsi(text)).toBe(false);
    expect(hasAnsi(`a${ESC}[0m`)).toBe(true);
    expect(hasAnsi("a\u009b0m")).toBe(true);
    expect(stripAnsi("")).toBe("");
  });

  it("stays linear on large and hostile input", () => {
    const line = `${ESC}[32m✓${ESC}[0m ${ESC}]8;;https://example.com/a${ST}test name${ESC}]8;;${ST} ${ESC}[2m(12 ms)${ESC}[22m\n`;
    const big = line.repeat(Math.ceil(2_000_000 / line.length));
    const hostile = [`${ESC}[`.repeat(400_000), `${ESC}]`.repeat(400_000), ESC.repeat(800_000), `${ESC}[${"1;".repeat(400_000)}`, `\u009d${"x".repeat(800_000)}`];
    const started = Date.now();
    const clean = stripAnsi(big);
    for (const input of hostile) expect(stripAnsi(input)).toBe("");
    const elapsed = Date.now() - started;
    expect(clean.startsWith("✓ test name (12 ms)\n")).toBe(true);
    expect(hasAnsi(clean)).toBe(false);
    // Linear scans of about 6 million characters; a backtracking or quadratic version takes minutes here.
    expect(elapsed).toBeLessThan(3_000);
  });
});

describe("ansiColourPrefix: what the ansi highlighter gets", () => {
  const raw = `${ESC}]0;title${BEL}${ESC}[31mred${ESC}[0m ${ESC}[2Kplain ${ESC}[1;32mgreen${ESC}[0m${ESC}[?25h end`;

  it("keeps complete colour sequences and drops everything else", () => {
    expect(ansiColourPrefix(raw, Infinity)).toBe(`${ESC}[31mred${ESC}[0m plain ${ESC}[1;32mgreen${ESC}[0m end`);
    // Colour sequences the highlighter cannot read (colon form, C1 CSI) go too.
    expect(ansiColourPrefix(`${ESC}[38:5:1mx\u009b31my`, Infinity)).toBe("xy");
  });

  it("cuts after the same characters stripAnsi shows", () => {
    const clean = stripAnsi(raw);
    for (let visible = 0; visible <= clean.length; visible++) {
      expect(stripAnsi(ansiColourPrefix(raw, visible))).toBe(clean.slice(0, visible));
    }
  });
});

describe("outputView: preview and 「展开全部」 from the cleaned whole output", () => {
  it("cuts the preview from the cleaned text and counts cleaned lines and characters", () => {
    const lines = Array.from({ length: PREVIEW_LINES + 15 }, (_, index) => `${ESC}[3${index % 7}mline ${index}${ESC}[0m`);
    const raw = `${lines.join("\n")}\n`;
    const clean = stripAnsi(raw);
    const view = outputView(raw, clean, false, true);
    expect(view.preview.truncated).toBe(true);
    expect(view.preview.totalLines).toBe(PREVIEW_LINES + 15);
    expect(view.preview.totalChars).toBe(clean.length - 1);
    expect(view.shown.split("\n")).toHaveLength(PREVIEW_LINES);
    expect(hasAnsi(view.shown)).toBe(false);
    // The highlighter gets the same characters with their colours.
    expect(stripAnsi(view.highlight)).toBe(view.shown);
    expect(view.highlight).toContain(`${ESC}[31mline 1${ESC}[0m`);
  });

  it("shows all of the cleaned text when expanded, not the cleaned preview", () => {
    const raw = `${"x".repeat(PREVIEW_CHARS - 3)}${ESC}]8;;https://example.com/a-long-link${ST}LINK${ESC}]8;;${ST} tail${ESC}[0m\n`;
    const clean = stripAnsi(raw);
    expect(clean).toBe(`${"x".repeat(PREVIEW_CHARS - 3)}LINK tail\n`);
    const collapsed = outputView(raw, clean, false, false);
    expect(collapsed.shown).toBe(clean.slice(0, PREVIEW_CHARS));
    expect(hasAnsi(collapsed.shown)).toBe(false);
    const expanded = outputView(raw, clean, true, false);
    expect(expanded.shown).toBe(clean.replace(/\n$/, ""));
    expect(expanded.highlight).toBe(expanded.shown);
  });

  it("leaves text without escape sequences as it was", () => {
    const raw = "a\nb\n";
    const view = outputView(raw, stripAnsi(raw), true, true);
    expect(view).toMatchObject({ shown: "a\nb", highlight: "a\nb" });
    expect(outputView(raw, raw, true, true, false).shown).toBe(raw);
  });
});

describe("plain-text results", () => {
  it("summarise without escape sequences", () => {
    const presentation = resolveToolCallPresentation({
      name: "task_notification",
      detail: { type: "plain_text", label: "Notice", text: `${ESC}[33mwarning${ESC}[0m: disk ${ESC}]8;;https://x.test${BEL}almost${ESC}]8;;${BEL} full` },
    } as never);
    expect(presentation.summary).toBe("warning: disk almost full");
  });
});
