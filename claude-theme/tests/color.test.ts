import { test } from "node:test";
import assert from "node:assert/strict";
import { contrast, fitContrast, luminance, oklch, toOklch } from "../shared/color.ts";

// The palettes are generated from measurements of real colours, so a conversion that drifts
// would silently move every theme. These anchors are Claude Code's own values.
test("measuring and rebuilding a colour is lossless", () => {
  for (const hex of ["#FFFFFF", "#000000", "#D77757", "#B1B9F9", "#1A1A1A", "#FAF9F5", "#4EBA65", "#B14C2A"]) {
    const { l, c, h } = toOklch(hex);
    assert.equal(oklch(l, c, h), hex);
  }
});

test("neutral greys zero out residual chroma and hue", () => {
  for (const grey of ["#FFFFFF", "#000000", "#1A1A1A", "#888888", "#999999"]) {
    const measured = toOklch(grey);
    assert.equal(measured.c, 0, `${grey} should have zero chroma`);
    assert.equal(measured.h, 0, `${grey} should have zero hue`);
  }
});

test("toOklch and luminance reject malformed hex strings", () => {
  for (const invalid of ["#FFF", "FFFFFF", "#GGGGGG", "#12345678", ""]) {
    assert.throws(() => toOklch(invalid), /Expected #RRGGBB/);
    assert.throws(() => luminance(invalid), /Expected #RRGGBB/);
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

test("fitContrast leaves compliant colours untouched and fits yellow/green/cyan/blue hues to 4.5:1", () => {
  // Terracotta already clears 4.5:1 against Oat Latte's background and raised surfaces.
  assert.equal(fitContrast(0.542, 0.15, 39.1, ["#FAF9F5", "#F0EEE6"], 4.5), oklch(0.542, 0.15, 39.1));

  // Across the entire 360° hue wheel, light-mode accents fitted against background + raised clear 4.5:1.
  for (let hue = 0; hue < 360; hue += 5) {
    const background = oklch(0.982, 0.04 * 0.22, hue);
    const raised = oklch(0.948, 0.04 * 0.45, hue);
    const fitted = fitContrast(0.542, 0.15, hue, [background, raised], 4.5);
    assert.ok(
      contrast(fitted, background) >= 4.5,
      `hue ${hue}° failed 4.5:1 against background (${contrast(fitted, background).toFixed(2)})`,
    );
    assert.ok(
      contrast(fitted, raised) >= 4.5,
      `hue ${hue}° failed 4.5:1 against raised (${contrast(fitted, raised).toFixed(2)})`,
    );
  }

  // Dark-mode accents too dark for a dark card are brightened until they clear the target ratio.
  const darkFitted = fitContrast(0.42, 0.14, 210, ["#131B22", "#1B2833"], 4.5);
  assert.ok(contrast(darkFitted, "#1B2833") >= 4.5);
});
