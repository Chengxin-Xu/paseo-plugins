// Renders the theme family as a swatch sheet so the palettes can be judged by eye, not only
// by contrast numbers. Writes preview/dist/themes.png, which is git-ignored.
// Usage: npm run preview
import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { THEMES } = await import(join(root, "shared/palette.ts"));

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
  const x = GAP + (index % COLUMNS) * (CARD.width + GAP);
  const y = GAP + Math.floor(index / COLUMNS) * (CARD.height + GAP);

  fill(x, y, CARD.width, CARD.height, colors.background, 10);
  fill(x + 12, y + 12, CARD.width - 24, 3, colors.border); // top rule

  // Sidebar of "rows", one highlighted with the accent, mimicking a selected item.
  fill(x + 12, y + 26, 96, CARD.height - 38, colors.raised, 8);
  for (let row = 0; row < 5; row += 1) {
    const rowY = y + 38 + row * 20;
    fill(x + 20, rowY, row === 1 ? 60 : 72, 8, row === 1 ? colors.accent : colors.mutedForeground);
  }

  // Main card with a heading, body lines and a muted caption.
  fill(x + 120, y + 26, CARD.width - 132, 116, colors.raised, 8);
  fill(x + 132, y + 40, 120, 11, colors.foreground);
  fill(x + 132, y + 60, CARD.width - 160, 7, colors.mutedForeground);
  fill(x + 132, y + 74, CARD.width - 186, 7, colors.mutedForeground);
  fill(x + 132, y + 88, CARD.width - 210, 7, colors.mutedForeground);
  fill(x + 132, y + 110, 78, 20, colors.accent, 6); // primary button
  fill(x + 220, y + 110, 78, 20, colors.control, 6); // secondary button

  // Composer input with a focus ring underneath.
  fill(x + 120, y + 152, CARD.width - 132, 34, colors.control, 8);
  fill(x + 132, y + 165, 132, 8, colors.mutedForeground);
  fill(x + 120, y + 190, CARD.width - 132, 2, colors.ring);

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
