import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, oklch, toOklch } from "../shared/color.ts";

// The palettes are generated from measurements of real colours, so a conversion that drifts
// would silently move every theme. These anchors are Claude Code's own values.
test("measuring and rebuilding a colour is lossless", () => {
  for (const hex of ["#FFFFFF", "#000000", "#D77757", "#B1B9F9", "#1A1A1A", "#FAF9F5", "#4EBA65", "#B14C2A"]) {
    const { l, c, h } = toOklch(hex);
    assert.equal(oklch(l, c, h), hex);
  }
});

test("lightness is ordered the way the eye sees it", () => {
  const ramp = ["#1A1A1A", "#262626", "#373737", "#505050", "#888888", "#999999", "#FFFFFF"];
  const measured = ramp.map((hex) => toOklch(hex).l);
  for (let index = 1; index < measured.length; index += 1) {
    assert.ok(measured[index]! > measured[index - 1]!, `${ramp[index]} should read lighter than ${ramp[index - 1]}`);
  }
});

// sRGB cannot show every OKLCH colour. Clipping channels would twist the hue, so the
// conversion gives up chroma instead — an unreachably vivid request must still land on its hue.
test("out-of-gamut colours keep their hue instead of clipping", () => {
  const asked = { l: 0.67, c: 0.4, h: 39.1 };
  const produced = toOklch(oklch(asked.l, asked.c, asked.h));
  assert.ok(produced.c < asked.c, "chroma should have been reduced to fit sRGB");
  assert.ok(Math.abs(produced.h - asked.h) < 1.5, `hue drifted to ${produced.h.toFixed(1)}`);
  assert.ok(Math.abs(produced.l - asked.l) < 0.02, `lightness drifted to ${produced.l.toFixed(3)}`);
});

test("contrast matches known WCAG pairs", () => {
  assert.equal(Number(contrast("#FFFFFF", "#000000").toFixed(2)), 21);
  assert.equal(Number(contrast("#000000", "#FFFFFF").toFixed(2)), 21);
  assert.equal(Number(contrast("#777777", "#777777").toFixed(2)), 1);
});
