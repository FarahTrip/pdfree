// Pure pdf-lib operations. No DOM, so scripts/check.mjs can run them in Node.
import { BlendMode, LineCapStyle, PDFDocument, PDFFont, PDFPage, degrees, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { eraseText, type Rect } from "./erase.ts";

export type Source =
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "image"; bytes: Uint8Array; png: boolean };

/** One output page: page `index` of `sources[src]`, plus extra clockwise rotation. */
export type PageRef = { src: number; index: number; rotate: number };

/** Merge / reorder / rotate / delete / extract / images-to-PDF: all of it is "build a new doc from these pages". */
export async function assemble(sources: Source[], pages: PageRef[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const copied = new Map<number, Map<number, PDFPage>>();

  // Copy each source's pages in one call so shared fonts/images are not duplicated.
  for (const [src, s] of sources.entries()) {
    if (s.kind !== "pdf") continue;
    const want = [...new Set(pages.filter((p) => p.src === src).map((p) => p.index))];
    if (!want.length) continue;
    const doc = await PDFDocument.load(s.bytes);
    const got = await out.copyPages(doc, want);
    copied.set(src, new Map(want.map((i, k) => [i, got[k]])));
  }

  for (const p of pages) {
    const s = sources[p.src];
    let page: PDFPage;
    if (s.kind === "pdf") {
      page = out.addPage(copied.get(p.src)!.get(p.index)!);
    } else {
      const img = s.png ? await out.embedPng(s.bytes) : await out.embedJpg(s.bytes);
      const { width, height } = img.scale(0.75); // 96 dpi px -> 72 dpi pt
      page = out.addPage([width, height]);
      page.drawImage(img, { x: 0, y: 0, width, height });
    }
    page.setRotation(degrees((((page.getRotation().angle + p.rotate) % 360) + 360) % 360));
  }
  return out.save();
}

/**
 * Edits use the page as the user sees it at zoom 1: top-left origin, y down, already rotated.
 * Each page's geometry maps that back to PDF user space (pdf.js viewport.convertToPdfPoint).
 */
export type Geom = { rotate: number; toPdf: (x: number, y: number) => number[] };

type Base = { page: number };
export type Item = Base &
  (
    | { kind: "text"; x: number; y: number; text: string; size: number; color: string; font: FontKey }
    | { kind: "box"; x: number; y: number; w: number; h: number; color: string; highlight: boolean; erase?: boolean }
    | { kind: "image"; x: number; y: number; w: number; h: number; bytes: Uint8Array; png: boolean }
    | { kind: "ink"; points: number[]; color: string; width: number }
  );

export const LINE = 1.2;

/**
 * Liberation fonts (public/fonts): metric-compatible with Arial/Helvetica, Times and Courier,
 * so replaced text keeps the width of the original in most PDFs. Key = file suffix.
 */
export type Family = "Sans" | "Serif" | "Mono";
export type FontKey = `${Family}-${"Regular" | "Bold" | "Italic" | "BoldItalic"}`;
export const fontKey = (family: Family, bold: boolean, italic: boolean): FontKey =>
  `${family}-${bold ? (italic ? "BoldItalic" : "Bold") : italic ? "Italic" : "Regular"}`;
export const fontUrl = (k: FontKey) => `/fonts/Liberation${k}.ttf`;

// hhea ascent/descent per em, read from the font files.
const METRICS: Record<Family, [number, number]> = { Sans: [0.9053, 0.2119], Serif: [0.8911, 0.2163], Mono: [0.8325, 0.3003] };
/** Baseline offset from the top of a CSS line box at line-height LINE, so PDF text lands where the editor showed it. */
export const baseline = (k: FontKey) => {
  const [a, d] = METRICS[k.split("-")[0] as Family];
  return (LINE - a - d) / 2 + a;
};

/** Flat [x0,y0,x1,y1,…] -> SVG path. Shared by the editor preview and the PDF output. */
export function inkPath(p: number[]) {
  let d = `M ${p[0]} ${p[1]}`;
  for (let i = 2; i < p.length; i += 2) d += ` L ${p[i]} ${p[i + 1]}`;
  return p.length === 2 ? `${d} L ${p[0] + 0.01} ${p[1]}` : d; // a single tap is a dot
}

const hex = (c: string) => {
  const n = parseInt(c.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export async function applyEdits(
  bytes: Uint8Array,
  items: Item[],
  geoms: Geom[],
  fonts: Partial<Record<FontKey, Uint8Array>> = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  doc.registerFontkit(fontkit);
  const embedded = new Map<FontKey, PDFFont>();
  const font = async (k: FontKey) => {
    if (!embedded.has(k)) {
      if (!fonts[k]) throw new Error(`font ${k} not loaded`);
      embedded.set(k, await doc.embedFont(fonts[k], { subset: true }));
    }
    return embedded.get(k)!;
  };
  const pages = doc.getPages();

  // Edited lines: take the original words out of the page, not just paint over them.
  for (const [n, page] of pages.entries()) {
    const g = geoms[n];
    const rects: Rect[] = items.flatMap((it) => {
      if (it.page !== n || it.kind !== "box" || !it.erase) return [];
      const [ax, ay] = g.toPdf(it.x, it.y);
      const [bx, by] = g.toPdf(it.x + it.w, it.y + it.h);
      return [{ x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) }];
    });
    try {
      eraseText(doc, page, rects);
    } catch (e) {
      console.warn("could not remove original text; it stays hidden under the cover", e);
    }
  }

  for (const it of items) {
    const page = pages[it.page];
    const g = geoms[it.page];
    const rotate = degrees(g.rotate);
    const at = (x: number, y: number) => {
      const [px, py] = g.toPdf(x, y);
      return { x: px, y: py, rotate };
    };

    if (it.kind === "text") {
      const { size } = it;
      const lines = it.text.split("\n");
      for (const [i, line] of lines.entries()) {
        if (!line.trim()) continue;
        const y = it.y + (baseline(it.font) + i * LINE) * size;
        page.drawText(line, { ...at(it.x, y), size, font: await font(it.font), color: hex(it.color) });
      }
    } else if (it.kind === "box") {
      page.drawRectangle({
        ...at(it.x, it.y + it.h),
        width: it.w,
        height: it.h,
        color: hex(it.color),
        blendMode: it.highlight ? BlendMode.Multiply : undefined,
      });
    } else if (it.kind === "image") {
      const img = it.png ? await doc.embedPng(it.bytes) : await doc.embedJpg(it.bytes);
      page.drawImage(img, { ...at(it.x, it.y + it.h), width: it.w, height: it.h });
    } else {
      if (it.points.length < 2) continue;
      page.drawSvgPath(inkPath(it.points), {
        ...at(0, 0),
        borderColor: hex(it.color),
        borderWidth: it.width,
        borderLineCap: LineCapStyle.Round,
      });
    }
  }
  return doc.save();
}

/** A piece of existing page text in display units: left x, baseline y, font size, width. */
export type Run = { str: string; x: number; base: number; size: number; w: number; font: string };

/**
 * pdf.js hands back text in fragments (words, sometimes single letters). Glue fragments that sit on
 * the same baseline in the same font into one line, so one click edits a whole line.
 */
export function mergeRuns(parts: Run[]): Run[] {
  const out: Run[] = [];
  for (const p of parts) {
    const cur = out.at(-1);
    const gap = cur ? p.x - (cur.x + cur.w) : 0;
    if (
      cur &&
      cur.font === p.font &&
      Math.abs(cur.base - p.base) < cur.size * 0.2 &&
      Math.abs(cur.size - p.size) < cur.size * 0.1 &&
      gap > -cur.size * 0.3 &&
      gap < cur.size * 1.0
    ) {
      const space = gap > cur.size * 0.15 && !/\s$/.test(cur.str) && !/^\s/.test(p.str) ? " " : "";
      cur.str += space + p.str;
      cur.w = p.x + p.w - cur.x;
    } else {
      out.push({ ...p });
    }
  }
  return out
    .map((r) => {
      // ponytail: a trimmed leading space is ~0.25em in Arial/Times; real glyph widths if odd fonts look off
      const lead = (r.str.length - r.str.trimStart().length) * r.size * 0.25;
      return { ...r, str: r.str.trim(), x: r.x + lead, w: r.w - lead };
    })
    .filter((r) => r.str && r.w > 0);
}
