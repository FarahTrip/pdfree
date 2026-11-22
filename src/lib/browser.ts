// Browser-only helpers: pdf.js loading, image normalising, downloads.
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { mergeRuns, type Family, type Run } from "./ops";

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
  // pdf.js transfers the buffer to its worker; give it a copy so pdf-lib keeps the original.
  // fontExtraProperties keeps each font's real name (e.g. "ABCDEF+Arial-BoldMT"), our only bold/italic signal for embedded fonts.
  return pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true }).promise;
}

export async function readFile(f: File) {
  return new Uint8Array(await f.arrayBuffer());
}

export const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");

/**
 * Any browser-decodable image -> PNG/JPEG bytes pdf-lib can embed.
 * Always re-drawn through a canvas so phone photos get their EXIF rotation baked in.
 */
export async function toEmbeddable(f: File) {
  const bmp = await createImageBitmap(f);
  const { width: w, height: h } = bmp;
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const png = f.type !== "image/jpeg";
  const blob = await c.convertToBlob(png ? { type: "image/png" } : { type: "image/jpeg", quality: 0.92 });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), png, w, h, url: URL.createObjectURL(blob) };
}

export function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const baseName = (n: string) => n.replace(/\.[^.]+$/, "");

export const friendly = (e: unknown) =>
  /encrypt/i.test(String(e)) ? "This PDF is password-protected. Unlock it first." : `Could not read that file: ${String(e)}`;

export type PageRun = Run & { family: Family; asc: number; desc: number };

/** Lines of existing text on a page, in display units at zoom 1. Only upright horizontal text. */
export async function pageRuns(page: PDFPageProxy, vp: PageViewport): Promise<PageRun[]> {
  const { Util } = await import("pdfjs-dist");
  const tc = await page.getTextContent();
  const parts: Run[] = [];
  for (const it of tc.items) {
    if (!("str" in it) || !it.str) continue;
    const t = Util.transform(vp.transform, it.transform);
    if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01 || t[0] <= 0 || t[3] >= 0) continue;
    parts.push({ str: it.str, x: t[4], base: t[5], size: -t[3], w: it.width, font: it.fontName });
  }
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v || lo));
  return mergeRuns(parts).map((r) => {
    const st = tc.styles[r.font];
    const generic = st?.fontFamily ?? "";
    return {
      ...r,
      family: generic === "serif" ? "Serif" : generic === "monospace" ? "Mono" : "Sans",
      asc: clamp(st?.ascent, 0.7, 1.1),
      desc: clamp(Math.abs(st?.descent), 0.15, 0.4),
    };
  });
}

/** Bold/italic from the loaded font object (exists once the page has rendered): flags, else the font's name. */
export function fontStyle(page: PDFPageProxy, fontName: string) {
  try {
    const f = page.commonObjs.has(fontName) ? page.commonObjs.get(fontName) : null;
    const name = String(f?.name ?? "");
    return {
      bold: !!(f?.bold || f?.black) || /bold|black|heavy|semibold|demi/i.test(name),
      italic: !!f?.italic || /italic|oblique/i.test(name),
    };
  } catch {
    return { bold: false, italic: false };
  }
}

const toHex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/** Background = most common colour in the box, ink = the pixel furthest from it. */
export function sampleColors(canvas: HTMLCanvasElement, pageW: number, r: { x: number; y: number; w: number; h: number }) {
  const k = canvas.width / pageW;
  const x = Math.max(0, Math.floor(r.x * k));
  const y = Math.max(0, Math.floor(r.y * k));
  const w = Math.max(1, Math.min(canvas.width - x, Math.ceil(r.w * k)));
  const h = Math.max(1, Math.min(canvas.height - y, Math.ceil(r.h * k)));
  const d = canvas.getContext("2d")!.getImageData(x, y, w, h).data;
  const counts = new Map<number, number>();
  let top = 0;
  let bgAt = 0;
  for (let i = 0; i < d.length; i += 4) {
    const q = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const c = (counts.get(q) ?? 0) + 1;
    counts.set(q, c);
    if (c > top) [top, bgAt] = [c, i];
  }
  const bg = [d[bgAt], d[bgAt + 1], d[bgAt + 2]];
  let far = -1;
  let fg = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const dist = (d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2;
    if (dist > far) [far, fg] = [dist, [d[i], d[i + 1], d[i + 2]]];
  }
  return { bg: toHex(bg[0], bg[1], bg[2]), fg: toHex(fg[0], fg[1], fg[2]) };
}
