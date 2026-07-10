// Generate a 1024x1024 app icon (PNG, RGBA) from scratch — no dependencies.
// The KestraVault brand mark: the white geometric monogram (from build/logo.svg)
// centered on a dark rounded "squircle" tile. electron-builder derives the macOS
// .icns and Windows .ico from this single PNG.
//
// The logo is defined by two straight-line subpaths with an even-odd fill (see
// build/logo.svg / build/logo-on-black.svg), so it rasterizes cleanly with the
// same supersampled point-in-polygon approach used for the tile — no SVG engine.
//
// Usage:  node build/make-icon.mjs build/icon.png
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const SIZE = 1024;
const SS = 4; // supersample factor for smooth (anti-aliased) edges

// ── palette (brand: white mark on black); canvas stays transparent behind tile ──
const TILE = [10, 10, 10]; // near-black brand surface
const BORDER = [40, 40, 40]; // a hair of definition on dark backgrounds
const WHITE = [245, 245, 245]; // the mark

// Rounded-rect coverage helper: true if (x,y) is inside a rounded rectangle
// [x0,x1]×[y0,y1] with corner radius r.
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  if (x >= x0 + r && x <= x1 - r) return y >= y0 && y <= y1;
  if (y >= y0 + r && y <= y1 - r) return x >= x0 && x <= x1;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// ── KestraVault logo, in its native 837×837 viewBox (build/logo.svg) ──
// Two closed subpaths; fill-rule even-odd (the triangle + interior read as holes).
const LOGO_VIEWBOX = 837;
const LOGO_SUBPATHS = [
  [
    [77.7, 49.3], [529.1, 49.3], [464.5, 121.9], [156.9, 123.2], [158.2, 586.6],
    [641.3, 48], [758.8, 52], [754.9, 755.5], [662.5, 755.5], [439.4, 527.2],
    [496.1, 467.8], [682.3, 648.6], [678.3, 129.8], [77.7, 788.5],
  ],
  [
    [378.7, 595.8], [533.1, 755.5], [236.1, 754.2],
  ],
];

// Ray-cast point-in-polygon (odd crossings ⇒ inside).
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// Tile geometry: ~6% padding so macOS' own corner mask never clips the art.
const pad = SIZE * 0.06;
const x0 = pad;
const y0 = pad;
const x1 = SIZE - pad;
const y1 = SIZE - pad;
const radius = (x1 - x0) * 0.235; // squircle-ish corner

// Fit the logo's 837 box into a centered square ~70% of the tile width so the
// mark breathes inside the rounded tile. Transform each vertex into canvas space.
const logoSide = (x1 - x0) * 0.7;
const logoX0 = x0 + ((x1 - x0) - logoSide) / 2;
const logoY0 = y0 + ((y1 - y0) - logoSide) / 2;
const scale = logoSide / LOGO_VIEWBOX;
const LOGO = LOGO_SUBPATHS.map((sub) =>
  sub.map(([lx, ly]) => [logoX0 + lx * scale, logoY0 + ly * scale]),
);

// Per-pixel render with SSxSS supersampling.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  raw[py * (SIZE * 4 + 1)] = 0; // PNG filter byte (none) per scanline
  for (let px = 0; px < SIZE; px++) {
    let tile = 0;
    let mark = 0;
    let border = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const x = px + (sx + 0.5) / SS;
        const y = py + (sy + 0.5) / SS;
        const inTile = inRoundRect(x, y, x0, y0, x1, y1, radius);
        if (inTile) {
          tile++;
          const inBorder = !inRoundRect(x, y, x0 + 6, y0 + 6, x1 - 6, y1 - 6, radius - 6);
          if (inBorder) border++;
          // Even-odd across the two subpaths ⇒ XOR of per-subpath containment.
          if (inPolygon(x, y, LOGO[0]) !== inPolygon(x, y, LOGO[1])) {
            mark++;
          }
        }
      }
    }
    const n = SS * SS;
    const tileA = tile / n;
    const markA = mark / n;
    const borderA = border / n;
    // Compose: transparent → tile (with border tint) → white mark.
    let rgb = mix(TILE, BORDER, Math.min(1, borderA));
    rgb = mix(rgb, WHITE, Math.min(1, markA));
    const alpha = Math.round(255 * tileA);
    const o = py * (SIZE * 4 + 1) + 1 + px * 4;
    raw[o] = rgb[0];
    raw[o + 1] = rgb[1];
    raw[o + 2] = rgb[2];
    raw[o + 3] = alpha;
  }
}

// ── minimal PNG container ──
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
const png = Buffer.concat([
  sig,
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = process.argv[2];
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
