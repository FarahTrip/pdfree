// Remove original text from a page's content stream, so edited lines don't keep their old words
// hidden (and copyable) under the cover box. Anything we can't handle safely is left in place;
// the cover box still hides it visually.
import { PDFArray, PDFDocument, PDFName, PDFPage, PDFRawStream, decodePDFRawStream } from "pdf-lib";

/** Axis-aligned rect in PDF user space. */
export type Rect = { x0: number; y0: number; x1: number; y1: number };
type M = number[]; // [a b c d e f]

const mul = (m: M, n: M): M => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const I: M = [1, 0, 0, 1, 0, 0];

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const isWs = (c: number) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

type Tok = { s: number; e: number; k: "num" | "val" | "op" | "open" | "close"; v: string };

function lex(b: Uint8Array, i: number): Tok | null {
  const n = b.length;
  for (;;) {
    while (i < n && isWs(b[i])) i++;
    if (i < n && b[i] === 37) while (i < n && b[i] !== 10 && b[i] !== 13) i++; // % comment
    else break;
  }
  if (i >= n) return null;
  const s = i;
  const c = b[i];
  if (c === 40) {
    // (literal string) with nesting and escapes
    let depth = 0;
    do {
      if (b[i] === 92) i++;
      else if (b[i] === 40) depth++;
      else if (b[i] === 41) depth--;
      i++;
    } while (i < n && depth > 0);
    return { s, e: i, k: "val", v: "" };
  }
  if (c === 60 && b[i + 1] === 60) return { s, e: i + 2, k: "open", v: "<<" };
  if (c === 62 && b[i + 1] === 62) return { s, e: i + 2, k: "close", v: ">>" };
  if (c === 60) {
    while (i < n && b[i] !== 62) i++;
    return { s, e: i + 1, k: "val", v: "" };
  }
  if (c === 91 || c === 123) return { s, e: i + 1, k: "open", v: "[" };
  if (c === 93 || c === 125) return { s, e: i + 1, k: "close", v: "]" };
  i++;
  while (i < n && !isWs(b[i]) && !isDelim(b[i])) i++;
  const v = String.fromCharCode(...b.subarray(s, i));
  if (c === 47) return { s, e: i, k: "val", v };
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(v)) return { s, e: i, k: "num", v };
  if (v === "true" || v === "false" || v === "null") return { s, e: i, k: "val", v };
  return { s, e: i, k: "op", v };
}

/** Skip inline image data after `ID`: binary until whitespace + "EI" + whitespace/end. */
function skipInlineImage(b: Uint8Array, i: number) {
  for (i += 1; i < b.length - 1; i++) {
    if (b[i] === 69 && b[i + 1] === 73 && isWs(b[i - 1]) && (i + 2 >= b.length || isWs(b[i + 2]))) return i + 2;
  }
  return b.length;
}

/**
 * Drop text-showing operators whose start point is inside one of `rects`.
 * A dropped Tj/TJ that a following, kept Tj relies on for its position (no Td/Tm in between) is kept,
 * because removing it would slide the kept text left.
 */
export function eraseInStream(b: Uint8Array, rects: Rect[]): { bytes: Uint8Array; removed: number } {
  type Cut = { s: number; e: number; with: string; keep: boolean };
  const cuts: Cut[] = [];
  let chain: Cut[] = []; // removals since the last explicit text positioning
  let ctm = I;
  const stack: M[] = [];
  let tm = I;
  let tlm = I;
  let leading = 0;
  let operands: Tok[] = [];
  // After a show without a new Td/Tm we don't know where the next piece starts (no glyph widths).
  // Same font, same line: it belongs to the run the user clicked. A font switch means a different run.
  let unknownPos = false;
  let lastHit = false;
  let fontChanged = false;
  let depth = 0;

  const moveLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
    chain = [];
    unknownPos = false;
  };
  const show = (s: number, e: number, replacement: string) => {
    const m = mul(tm, ctm);
    const [x, y] = [m[4], m[5]];
    const hit = unknownPos
      ? lastHit && !fontChanged
      : rects.some((r) => x >= r.x0 - 0.5 && x <= r.x1 + 0.5 && y >= r.y0 - 0.5 && y <= r.y1 + 0.5);
    unknownPos = true;
    lastHit = hit;
    fontChanged = false;
    if (hit) {
      const cut = { s, e, with: replacement, keep: false };
      cuts.push(cut);
      chain.push(cut);
    } else {
      chain.forEach((c) => (c.keep = true));
      chain = [];
    }
  };

  let i = 0;
  for (let t = lex(b, i); t; t = lex(b, i)) {
    i = t.e;
    if (t.k === "open") {
      if (depth++ === 0) operands.push(t);
      continue;
    }
    if (t.k === "close") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (t.k !== "op") {
      operands.push(t);
      continue;
    }
    const num = operands.map((o) => Number(o.v));
    const start = operands[0]?.s ?? t.s;
    switch (t.v) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() ?? I; break;
      case "cm": if (num.length === 6) ctm = mul(num, ctm); break;
      case "BT": tm = tlm = I; chain = []; unknownPos = false; break;
      case "Tm": if (num.length === 6) { tm = tlm = num; chain = []; unknownPos = false; } break;
      case "Tf": fontChanged = true; break;
      case "Td": moveLine(num[0], num[1]); break;
      case "TD": leading = -num[1]; moveLine(num[0], num[1]); break;
      case "TL": leading = num[0]; break;
      case "T*": moveLine(0, -leading); break;
      case "Tj": case "TJ": show(start, t.e, " "); break;
      case "'": moveLine(0, -leading); show(start, t.e, " T* "); break;
      case '"': moveLine(0, -leading); show(start, t.e, ` ${operands[0]?.v} Tw ${operands[1]?.v} Tc T* `); break;
      case "ID": i = skipInlineImage(b, t.e); break;
    }
    operands = [];
  }

  const done = cuts.filter((c) => !c.keep);
  if (!done.length) return { bytes: b, removed: 0 };
  const parts: Uint8Array[] = [];
  let at = 0;
  const enc = new TextEncoder();
  for (const c of done) {
    parts.push(b.subarray(at, c.s), enc.encode(c.with));
    at = c.e;
  }
  parts.push(b.subarray(at));
  return { bytes: concat(parts), removed: done.length };
}

/** Rewrite the page's own content with text inside `rects` removed. Returns how many text pieces went. */
export function eraseText(doc: PDFDocument, page: PDFPage, rects: Rect[]): number {
  const contents = page.node.Contents();
  if (!contents || !rects.length) return 0;
  const streams = contents instanceof PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const chunks: Uint8Array[] = [];
  for (const s of streams) {
    if (!(s instanceof PDFRawStream)) return 0; // something exotic: leave it, the cover still hides it
    chunks.push(decodePDFRawStream(s).decode(), new Uint8Array([10]));
  }
  const { bytes, removed } = eraseInStream(concat(chunks), rects);
  if (removed) page.node.set(PDFName.of("Contents"), doc.context.register(doc.context.flateStream(bytes)));
  return removed;
}
