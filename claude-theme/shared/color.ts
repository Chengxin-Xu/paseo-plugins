/**
 * Minimal OKLCH ↔ sRGB conversion and WCAG contrast fitting.
 *
 * Palettes are derived in OKLCH rather than hand-tuned in hex because OKLCH lightness is
 * perceptually uniform: one L ladder produces the same visual spacing at every hue, so a
 * pink theme and an indigo theme end up with identically deep cards, inputs and borders.
 * Matrices are Björn Ottosson's published OKLab constants.
 */

/** Perceptual lightness 0–1, chroma (0 is grey), hue in degrees. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

type Linear = readonly [number, number, number];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const cube = (value: number) => value * value * value;

function toLinear({ l, c, h }: Oklch): Linear {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const long = cube(l + 0.3963377774 * a + 0.2158037573 * b);
  const medium = cube(l - 0.1055613458 * a - 0.0638541728 * b);
  const short = cube(l - 0.0894841775 * a - 1.291485548 * b);
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

const fits = (channels: Linear) => channels.every((value) => value >= -1e-4 && value <= 1 + 1e-4);

/**
 * sRGB covers only part of OKLCH. Clipping channels would shift the hue, so an out-of-gamut
 * colour keeps its hue and lightness and gives up chroma until it fits.
 */
function fitToSrgb(colour: Oklch): Linear {
  const direct = toLinear(colour);
  if (fits(direct)) return direct;
  let reachable = 0;
  let tooColourful = colour.c;
  for (let step = 0; step < 24; step += 1) {
    const middle = (reachable + tooColourful) / 2;
    if (fits(toLinear({ ...colour, c: middle }))) reachable = middle;
    else tooColourful = middle;
  }
  return toLinear({ ...colour, c: reachable });
}

const encode = (value: number) => {
  const clamped = Math.min(1, Math.max(0, value));
  const gamma = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(gamma * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
};

/** Renders an OKLCH colour as the `#RRGGBB` string Paseo requires. */
export function oklch(l: number, c: number, h: number): string {
  const [red, green, blue] = fitToSrgb({ l, c, h });
  return `#${encode(red)}${encode(green)}${encode(blue)}`;
}

const decode = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);

function assertHex(hex: string): void {
  if (!HEX_COLOR.test(hex)) {
    throw new Error(`Expected #RRGGBB hex colour, received "${hex}"`);
  }
}

/** Measures a hex colour, used to calibrate the recipe against the extracted Claude Code palette. */
export function toOklch(hex: string): Oklch {
  assertHex(hex);
  const channel = (offset: number) => decode(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const red = channel(1);
  const green = channel(3);
  const blue = channel(5);
  const long = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const medium = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const short = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
  const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
  const b = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;
  const chroma = Math.hypot(a, b);
  if (chroma < 1e-6) return { l, c: 0, h: 0 };
  const hue = (Math.atan2(b, a) * 180) / Math.PI;
  return { l, c: chroma, h: hue < 0 ? hue + 360 : hue };
}

/** WCAG relative luminance, for the contrast guards in the tests. */
export function luminance(hex: string): number {
  assertHex(hex);
  const channel = (offset: number) => decode(Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * OKLab perceptual lightness L and WCAG relative luminance Y weight green, cyan and blue
 * channels differently: a fixed OKLCH lightness that clears 4.5:1 at red/terracotta hues
 * drops to ~4.0:1 across yellow, green, cyan and blue (H ∈ [65°, 270°]).
 *
 * `fitContrast` returns `oklch(l, c, h)` untouched whenever it already meets `minRatio`
 * against every surface in `against` (so existing anchor palettes stay byte-identical),
 * and otherwise binary-searches lightness `l` toward the high-contrast pole while preserving
 * hue `h` and requested chroma `c`.
 */
export function fitContrast(
  l: number,
  c: number,
  h: number,
  against: string | readonly string[],
  minRatio: number,
): string {
  const targets = typeof against === "string" ? [against] : against;
  const direct = oklch(l, c, h);
  if (targets.length === 0) return direct;
  const passes = (hex: string) => targets.every((surface) => contrast(hex, surface) >= minRatio);
  if (passes(direct)) return direct;

  const avgLum = targets.reduce((sum, surface) => sum + luminance(surface), 0) / targets.length;
  const darken = luminance(direct) <= avgLum;
  let low = darken ? 0 : l;
  let high = darken ? l : 1;
  let best = oklch(darken ? 0 : 1, c, h);
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    const candidate = oklch(middle, c, h);
    if (passes(candidate)) {
      best = candidate;
      if (darken) low = middle;
      else high = middle;
    } else if (darken) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return best;
}
