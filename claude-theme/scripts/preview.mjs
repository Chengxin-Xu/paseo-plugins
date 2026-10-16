// Renders the theme family as a swatch sheet so the palettes can be judged by eye, not only
// by contrast numbers. Models Paseo 0.11.1's real light/dark surface expansion:
//   - Light: sidebar = control (surfaceSidebar), selected = border (surface3), workspace = background (surface0)
//   - Dark:  sidebar = background (surfaceSidebar), selected = control (surface2), workspace = raised (surface1)
//   - Both:  user message bubble = border (surface3), composer input = control (surface2),
//            placeholder / timestamps / toolbar icons = ring (surface4 / foregroundExtraMuted),
//            primary button text = background (accentForeground) on accent.
// The last card is the custom slot at its default parameters (shared/custom.ts).
// Writes preview/dist/themes.png, which is git-ignored.
// Usage: npm run preview
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { THEMES: FIXED, resolveHostSurfaces } = await import(join(root, "shared/palette.ts"));
const { customTheme, DEFAULT_CUSTOM } = await import(join(root, "shared/custom.ts"));
const THEMES = [...FIXED, customTheme(DEFAULT_CUSTOM, "🎨 Custom")];

const CARD = { width: 380, height: 232 };
const GAP = 20;
const COLUMNS = 2;
const rows = Math.ceil(THEMES.length / COLUMNS);
const WIDTH = COLUMNS * CARD.width + (COLUMNS + 1) * GAP;
const HEIGHT = rows * CARD.height + (rows + 1) * GAP;

const canvas = new Uint8Array(WIDTH * HEIGHT * 3).fill(0x1a);

const parse = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));

function fill(x0, y0, width, height, hex, radius = 0) {
  const [r, g, b] = parse(hex);
  for (let y = Math.max(0, y0); y < Math.min(HEIGHT, y0 + height); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(WIDTH, x0 + width); x += 1) {
      if (radius) {
        // Skip the four corner quadrants so the mock reads as rounded UI rather than raw blocks.
        const dx = Math.min(x - x0, x0 + width - 1 - x);
        const dy = Math.min(y - y0, y0 + height - 1 - y);
        if (dx < radius && dy < radius && (radius - dx) ** 2 + (radius - dy) ** 2 > radius ** 2) continue;
      }
      const at = (y * WIDTH + x) * 3;
      canvas[at] = r;
      canvas[at + 1] = g;
      canvas[at + 2] = b;
    }
  }
}

THEMES.forEach((theme, index) => {
  const { colors } = theme;
  const host = resolveHostSurfaces(theme);
  const x = GAP + (index % COLUMNS) * (CARD.width + GAP);
  const y = GAP + Math.floor(index / COLUMNS) * (CARD.height + GAP);

  // Page frame (surface0) and top border rule.
  fill(x, y, CARD.width, CARD.height, host.surface0, 10);
  fill(x + 12, y + 12, CARD.width - 24, 3, colors.border);

  // Sidebar (`surfaceSidebar`: `control` in light mode, `background` in dark mode).
  fill(x + 12, y + 26, 96, CARD.height - 38, host.surfaceSidebar, 8);
  // Section header in `foregroundExtraMuted` (`ring`).
  fill(x + 20, y + 34, 44, 5, host.foregroundExtraMuted);
  for (let row = 0; row < 5; row += 1) {
    const rowY = y + 46 + row * 22;
    if (row === 1) {
      // Selected sidebar row (`surfaceSidebarSelected`: `border` in light, `control` in dark).
      fill(x + 16, rowY - 4, 88, 16, host.surfaceSidebarSelected, 4);
      fill(x + 20, rowY, 52, 8, colors.accent);
    } else {
      fill(x + 20, rowY, 54, 7, host.foregroundMuted);
    }
    // Trailing timestamp in `foregroundExtraMuted` (`ring`).
    fill(x + 82, rowY + 1, 16, 5, host.foregroundExtraMuted);
  }

  // Workspace pane (`surfaceWorkspace`: `background` in light mode, `raised` in dark mode).
  fill(x + 120, y + 26, CARD.width - 132, 116, host.surfaceWorkspace, 8);
  // User message bubble (`surface3` = `border`) with `foreground` text and `ring` timestamp.
  fill(x + 188, y + 34, CARD.width - 212, 24, host.userBubble, 6);
  fill(x + 196, y + 42, 96, 8, host.foreground);
  fill(x + 304, y + 43, 28, 6, host.foregroundExtraMuted);

  // Assistant card (`surface1` = `raised`) with heading, muted lines, primary & secondary buttons.
  fill(x + 128, y + 64, CARD.width - 148, 72, host.surface1, 6);
  fill(x + 138, y + 72, 116, 10, host.foreground);
  fill(x + 138, y + 88, CARD.width - 176, 6, host.foregroundMuted);
  fill(x + 138, y + 98, CARD.width - 204, 6, host.foregroundMuted);
  // Primary button (`accent` fill with `accentForeground` = `background` label).
  fill(x + 138, y + 110, 74, 20, host.accent, 6);
  fill(x + 152, y + 117, 46, 6, host.accentForeground);
  // Secondary button (`control` fill with `foreground` label).
  fill(x + 220, y + 110, 74, 20, host.input, 6);
  fill(x + 234, y + 117, 46, 6, host.foreground);

  // Composer input (`input` = `control`) with placeholder (`surface4` = `ring`) and focus ring.
  fill(x + 120, y + 152, CARD.width - 132, 34, host.input, 8);
  fill(x + 132, y + 165, 132, 8, host.surface4);
  fill(x + 120, y + 190, CARD.width - 132, 2, host.ring);

  // Palette strip: every token in registration order.
  const tokens = [
    colors.background,
    colors.raised,
    colors.control,
    colors.border,
    colors.accent,
    colors.foreground,
    colors.mutedForeground,
    colors.ring,
  ];
  tokens.forEach((hex, slot) => fill(x + 120 + slot * 32, y + 200, 28, 20, hex, 4));
  fill(x + 120, y + 198, 8 * 32 - 4, 1, colors.border);
});

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // truecolour
const raw = Buffer.alloc(HEIGHT * (WIDTH * 3 + 1));
for (let y = 0; y < HEIGHT; y += 1) {
  raw[y * (WIDTH * 3 + 1)] = 0; // no per-scanline filter
  Buffer.from(canvas.subarray(y * WIDTH * 3, (y + 1) * WIDTH * 3)).copy(raw, y * (WIDTH * 3 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", header),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(root, "preview/dist/themes.png");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, png);
console.log(`${out} (${WIDTH}x${HEIGHT}, ${THEMES.length} themes)`);
