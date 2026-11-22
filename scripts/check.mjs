// Self-check for src/lib/ops.ts. Run: npm run check (Node 22.18+ strips the TS types).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, degrees } from "pdf-lib";
import { applyEdits, assemble, mergeRuns } from "../src/lib/ops.ts";

const make = async (...sizes) => {
  const d = await PDFDocument.create();
  sizes.forEach((s) => d.addPage(s));
  return d.save();
};
const a = await make([100, 200], [300, 400]);
const b = await make([500, 600]);
// 1x1 red PNG
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

const out = await PDFDocument.load(
  await assemble(
    [{ kind: "pdf", bytes: a }, { kind: "pdf", bytes: b }, { kind: "image", bytes: png, png: true }],
    [
      { src: 1, index: 0, rotate: 0 },
      { src: 0, index: 1, rotate: 90 },
      { src: 2, index: 0, rotate: -90 },
    ],
  ),
);
const pages = out.getPages();
assert.deepEqual(pages.map((p) => p.getWidth()), [500, 300, 0.75], "order + image size");
assert.deepEqual(pages.map((p) => p.getRotation().angle), [0, 90, 270], "rotation normalised");

// Edits on a page that is already rotated; text with non-Latin chars must embed, not throw.
const r = await PDFDocument.create();
r.addPage([200, 300]).setRotation(degrees(90));
const font = (k) => readFileSync(new URL(`../public/fonts/Liberation${k}.ttf`, import.meta.url));
const edited = await applyEdits(
  await r.save(),
  [
    { page: 0, kind: "text", x: 10, y: 10, text: "Șțăî ok\nЖ line 2", size: 12, color: "#112233", font: "Sans-Regular" },
    { page: 0, kind: "text", x: 10, y: 40, text: "bold serif", size: 9, color: "#000000", font: "Serif-Bold" },
    { page: 0, kind: "box", x: 0, y: 0, w: 50, h: 20, color: "#ffffff", highlight: false },
    { page: 0, kind: "box", x: 0, y: 0, w: 50, h: 20, color: "#ffeb3b", highlight: true },
    { page: 0, kind: "image", x: 5, y: 5, w: 10, h: 10, bytes: png, png: true },
    { page: 0, kind: "ink", points: [1, 1, 20, 20, 40, 5], color: "#000000", width: 2 },
    { page: 0, kind: "ink", points: [7, 7], color: "#000000", width: 2 },
  ],
  [{ rotate: 90, toPdf: (x, y) => [y, x] }],
  { "Sans-Regular": font("Sans-Regular"), "Serif-Bold": font("Serif-Bold") },
);
const e = await PDFDocument.load(edited);
assert.equal(e.getPageCount(), 1);
assert.ok(edited.length > 1000, "font subset embedded");
// A font that was never loaded is a clear error, not a silent fallback.
await assert.rejects(applyEdits(await make([10, 10]), [{ page: 0, kind: "text", x: 0, y: 0, text: "x", size: 9, color: "#000000", font: "Mono-Bold" }], [{ rotate: 0, toPdf: (x, y) => [x, y] }]), /Mono-Bold/);
// No text, no font needed.
await applyEdits(await make([10, 10]), [], [{ rotate: 0, toPdf: (x, y) => [x, y] }]);
console.log("ops ok");

const run = (str, x, base = 100, font = "f1", size = 10) => ({ str, x, base, size, w: str.length * 5, font });
assert.deepEqual(
  mergeRuns([run("Hello", 0), run("world", 27), run("Bold", 53, 100, "f2"), run("next line", 0, 115), run(" ", 200)]).map((r) => [r.str, r.w]),
  [["Hello world", 52], ["Bold", 20], ["next line", 45]],
  "fragments merge into lines; font change and new baseline split; blank runs dropped",
);
const [lead] = mergeRuns([run(" this", 100)]);
assert.deepEqual([lead.str, lead.x, lead.w], ["this", 102.5, 22.5], "leading space trimmed and x nudged past it");
console.log("runs ok");

// --- eraser: drops text inside rects, nothing else
const { eraseInStream } = await import("../src/lib/erase.ts");
const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const box = { x0: 90, y0: 690, x1: 300, y1: 715 }; // around the line at (100, 700)
const er = (s) => dec(eraseInStream(enc(s), [box]).bytes);

assert.equal(er("BT /F1 12 Tf 100 700 Td (Old \\) text \\(x) Tj ET"), "BT /F1 12 Tf 100 700 Td   ET", "escaped parens");
assert.equal(er("BT 100 700 Td [(A) -20 (B)] TJ 0 -40 Td (keep) Tj ET"), "BT 100 700 Td   0 -40 Td (keep) Tj ET", "TJ removed, next line kept");
assert.equal(er("BT 1 0 0 1 100 700 Tm <414243> Tj ET"), "BT 1 0 0 1 100 700 Tm   ET", "hex string + Tm");
assert.equal(er("q 2 0 0 2 0 0 cm BT 50 350 Td (scaled) Tj ET Q"), "q 2 0 0 2 0 0 cm BT 50 350 Td   ET Q", "cm is applied");
assert.equal(er("BT 30 TL 100 730 Td (a) Tj (b) ' ET"), "BT 30 TL 100 730 Td (a) Tj  T*  ET", "' keeps its line move");
// (gone) is in the box; (stays) is another font drawn right after it with no Td, so it's another run.
// Removing (gone) would slide (stays) left, so both stay (the cover still hides the old words).
assert.equal(er("BT /F1 12 Tf 100 700 Td (gone) Tj /F2 12 Tf (stays) Tj ET"), "BT /F1 12 Tf 100 700 Td (gone) Tj /F2 12 Tf (stays) Tj ET", "no sliding");
assert.equal(er("BT 100 700 Td (a) Tj (b) Tj 0 -40 Td (c) Tj ET"), "BT 100 700 Td     0 -40 Td (c) Tj ET", "whole line chain goes");
const img = "q BI /W 1 /H 1 /CS /G /BPC 8 ID \x00) Tj (EI-ish\x00 EI Q ";
assert.equal(er(img + "BT 100 700 Td (x) Tj ET"), img + "BT 100 700 Td   ET", "inline image skipped intact");
assert.equal(er("% comment (100 700 Td)\nBT 100 700 Td (x) Tj ET"), "% comment (100 700 Td)\nBT 100 700 Td   ET", "comment");
assert.equal(er("BT 300 300 Td (elsewhere) Tj ET"), "BT 300 300 Td (elsewhere) Tj ET", "outside untouched");

// End to end: edit a real line, the old words must be gone from the file's text.
const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
const textOf = async (bytes) => {
  const d = await getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  return (await (await d.getPage(1)).getTextContent()).items.map((i) => i.str).join("|");
};
const src = await PDFDocument.create();
const hel = await src.embedFont("Helvetica");
const pg = src.addPage([400, 400]);
pg.drawText("Total: 100 EUR", { x: 50, y: 300, size: 12, font: hel });
pg.drawText("Untouched line", { x: 50, y: 250, size: 12, font: hel });
const before = await src.save();
const flip = { rotate: 0, toPdf: (x, y) => [x, 400 - y] };
const after = await applyEdits(
  before,
  [
    { page: 0, kind: "box", x: 49, y: 89, w: 90, h: 15, color: "#ffffff", highlight: false, erase: true },
    { page: 0, kind: "text", x: 50, y: 88.6, text: "Total: 80 EUR", size: 12, color: "#000000", font: "Sans-Regular" },
  ],
  [flip],
  { "Sans-Regular": font("Sans-Regular") },
);
const t = await textOf(after);
assert.ok(!t.includes("100"), `old text removed: ${t}`);
assert.ok(t.includes("Total: 80 EUR") && t.includes("Untouched line"), `new + other text present: ${t}`);
console.log("erase ok");
