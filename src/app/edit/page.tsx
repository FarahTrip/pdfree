"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { Btn, Drop, Header } from "@/components/ui";
import { LINE, applyEdits, baseline, fontKey, fontUrl, inkPath, type Family, type FontKey, type Item } from "@/lib/ops";
import { baseName, download, fontStyle, friendly, openPdf, pageRuns, readFile, sampleColors, toEmbeddable, type PageRun } from "@/lib/browser";

type Ed = Item & { id: number; url?: string };
type Tool = "select" | "text" | "whiteout" | "highlight" | "draw" | "image";
type Pg = { w: number; h: number; vp: PageViewport; page: PDFPageProxy; runs: PageRun[] };
type Img = Awaited<ReturnType<typeof toEmbeddable>>;

const TOOLS: [Tool, string, string][] = [
  ["select", "Select", "Move, resize or delete things (Del key)"],
  ["text", "Text", "Click existing text to change it, or click anywhere to add new text"],
  ["draw", "Draw / Sign", "Draw with the pen"],
  ["highlight", "Highlight", "Drag over text"],
  ["whiteout", "White-out", "Drag to cover. Covers visually only: hidden text is still in the file."],
  ["image", "Image", "Pick an image, then click to place it"],
];
const PEN = 2.5;
const HIGHLIGHT = "#fde047";
const fontCss = (k: FontKey) => ({
  fontFamily: `"Liberation ${k.split("-")[0]}"`,
  fontWeight: k.includes("Bold") ? 700 : 400,
  fontStyle: k.includes("Italic") ? "italic" : "normal",
});

/** Track a pointer drag in page units (zoom removed). */
function drag(e: React.PointerEvent, z: number, move: (dx: number, dy: number) => void, done?: (dx: number, dy: number) => void) {
  e.preventDefault();
  e.stopPropagation();
  const sx = e.clientX;
  const sy = e.clientY;
  let last = [0, 0];
  const mv = (ev: PointerEvent) => {
    last = [(ev.clientX - sx) / z, (ev.clientY - sy) / z];
    move(last[0], last[1]);
  };
  const up = () => {
    removeEventListener("pointermove", mv);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    done?.(last[0], last[1]);
  };
  addEventListener("pointermove", mv);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
}

function PdfCanvas({ doc, n, zoom }: { doc: PDFDocumentProxy; n: number; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let dead = false;
    let task: { cancel(): void } | undefined;
    doc.getPage(n + 1).then((page) => {
      if (dead || !ref.current) return;
      const vp = page.getViewport({ scale: zoom * (window.devicePixelRatio || 1) });
      ref.current.width = vp.width;
      ref.current.height = vp.height;
      const t = page.render({ canvas: ref.current, viewport: vp });
      t.promise.catch(() => {}); // cancelled on zoom change
      task = t;
    });
    return () => {
      dead = true;
      task?.cancel();
    };
  }, [doc, n, zoom]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />;
}

export default function Edit() {
  const [file, setFile] = useState<{ name: string; bytes: Uint8Array; doc: PDFDocumentProxy } | null>(null);
  const [pages, setPages] = useState<Pg[]>([]);
  const [items, setItems] = useState<Ed[]>([]);
  const [tool, setTool] = useState<Tool>("text");
  const [sel, setSel] = useState<number | null>(null);
  const [color, setColor] = useState("#111111");
  const [size, setSize] = useState(14);
  const [family, setFamily] = useState<Family>("Sans");
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [edited, setEdited] = useState<Set<string>>(new Set()); // existing lines already turned into editable text
  const focusId = useRef(0);
  const [zoom, setZoom] = useState(1.25);
  const [pending, setPending] = useState<Img | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const nextId = useRef(1);
  const imgInput = useRef<HTMLInputElement>(null);

  async function open([f]: File[]) {
    if (!f) return;
    setErr("");
    setBusy("Opening…");
    try {
      const bytes = await readFile(f);
      const doc = await openPdf(bytes);
      // ponytail: every page is rendered; virtualise with IntersectionObserver if 200+ page docs get slow
      const pgs: Pg[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        pgs.push({ w: vp.width, h: vp.height, vp, page, runs: await pageRuns(page, vp) });
      }
      file?.doc.loadingTask.destroy();
      setFile({ name: f.name, bytes, doc });
      setPages(pgs);
      setItems([]);
      setEdited(new Set());
      setSel(null);
      setZoom(Math.min(1.5, (window.innerWidth - 32) / Math.max(...pgs.map((p) => p.w))));
    } catch (e) {
      setErr(friendly(e));
    }
    setBusy("");
  }

  const add = (it: Item & { url?: string }) => {
    const id = nextId.current++;
    setItems((a) => [...a, { ...it, id } as Ed]);
    return id;
  };
  const update = (id: number, p: Partial<Ed>) => setItems((a) => a.map((x) => (x.id === id ? ({ ...x, ...p } as Ed) : x)));
  const remove = (id: number) => {
    setItems((a) => a.filter((x) => x.id !== id));
    setSel((s) => (s === id ? null : s));
  };
  const selItem = items.find((i) => i.id === sel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (sel == null || t.isContentEditable || t.tagName === "INPUT") return;
      if (e.key === "Delete" || e.key === "Backspace") setItems((a) => a.filter((x) => x.id !== sel));
      if (["Delete", "Backspace", "Escape"].includes(e.key)) setSel(null);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [sel]);

  function pickTool(t: Tool) {
    if (t === "image") return imgInput.current?.click();
    setTool(t);
    setSel(null);
  }

  function onPagePointer(e: React.PointerEvent<HTMLDivElement>, page: number) {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / zoom;
    const y = (e.clientY - r.top) / zoom;
    if (tool === "select") return setSel(null);
    if (tool === "text") {
      e.preventDefault();
      const font = fontKey(family, bold, italic);
      setSel(add({ kind: "text", page, x, y: y - (baseline(font) * size) / 2, text: "", size, color, font }));
    } else if (tool === "whiteout" || tool === "highlight") {
      const hl = tool === "highlight";
      const id = add({ kind: "box", page, x, y, w: 0, h: 0, color: hl ? HIGHLIGHT : "#ffffff", highlight: hl });
      drag(
        e,
        zoom,
        (dx, dy) => update(id, { x: Math.min(x, x + dx), y: Math.min(y, y + dy), w: Math.abs(dx), h: Math.abs(dy) }),
        (dx, dy) => Math.abs(dx) < 3 && Math.abs(dy) < 3 && remove(id),
      );
    } else if (tool === "draw") {
      const pts = [x, y];
      const id = add({ kind: "ink", page, points: pts, color, width: PEN });
      drag(e, zoom, (dx, dy) => {
        pts.push(x + dx, y + dy);
        update(id, { points: [...pts] });
      });
    } else if (tool === "image" && pending) {
      const w = Math.min(200, pending.w * 0.75);
      const h = (w * pending.h) / pending.w;
      const { bytes, png, url } = pending;
      setSel(add({ kind: "image", page, x: x - w / 2, y: y - h / 2, w, h, bytes, png, url }));
      setPending(null);
      setTool("select");
    }
  }

  /** Existing line -> cover it with its own background colour, put the same words on top as editable text. */
  function editRun(e: React.PointerEvent<HTMLElement>, n: number, i: number, r: PageRun) {
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget.parentElement!.querySelector("canvas")!;
    const cover = { x: r.x - 1, y: r.base - r.size * r.asc - 0.5, w: r.w + 2, h: r.size * (r.asc + r.desc) + 1 };
    const { bg, fg } = sampleColors(canvas, pages[n].w, cover);
    const st = fontStyle(pages[n].page, r.font);
    const font = fontKey(r.family, st.bold, st.italic);
    const sz = Math.round(r.size * 100) / 100;
    add({ kind: "box", page: n, ...cover, color: bg, highlight: false, erase: true });
    const id = add({ kind: "text", page: n, x: r.x, y: r.base - baseline(font) * sz, text: r.str, size: sz, color: fg, font });
    focusId.current = id;
    setSel(id);
    setEdited((s) => new Set(s).add(`${n}:${i}`));
    // Match the toolbar to what was clicked, so new text you add looks like the document.
    setFamily(r.family);
    setBold(st.bold);
    setItalic(st.italic);
    setSize(sz);
    setColor(fg);
  }

  function setFont(f: { family?: Family; bold?: boolean; italic?: boolean }) {
    const next = { family, bold, italic, ...f };
    setFamily(next.family);
    setBold(next.bold);
    setItalic(next.italic);
    if (selItem?.kind === "text") update(selItem.id, { font: fontKey(next.family, next.bold, next.italic) });
  }

  function startMove(e: React.PointerEvent, it: Ed) {
    setSel(it.id);
    drag(e, zoom, (dx, dy) =>
      update(it.id, it.kind === "ink" ? { points: it.points.map((v, i) => v + (i % 2 ? dy : dx)) } : { x: it.x + dx, y: it.y + dy }),
    );
  }

  function startResize(e: React.PointerEvent, it: Ed) {
    if (it.kind !== "box" && it.kind !== "image") return;
    drag(e, zoom, (dx, dy) => {
      const w = Math.max(5, it.w + dx);
      update(it.id, { w, h: it.kind === "image" ? (w * it.h) / it.w : Math.max(5, it.h + dy) });
    });
  }

  async function save() {
    if (!file) return;
    setBusy("Saving…");
    try {
      const geoms = pages.map((p) => ({ rotate: p.vp.rotation, toPdf: (x: number, y: number) => p.vp.convertToPdfPoint(x, y) }));
      const keys = [...new Set(items.flatMap((i) => (i.kind === "text" && i.text.trim() ? [i.font] : [])))];
      const fonts = Object.fromEntries(
        await Promise.all(keys.map(async (k) => [k, new Uint8Array(await (await fetch(fontUrl(k))).arrayBuffer())])),
      );
      download(await applyEdits(file.bytes, items, geoms, fonts), `${baseName(file.name)}-edited.pdf`);
    } catch (e) {
      setErr(friendly(e));
    }
    setBusy("");
  }

  const selectMode = tool === "select";
  const chrome = (it: Ed) =>
    sel === it.id && (
      <>
        <button
          aria-label="Delete"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => remove(it.id)}
          className="absolute -right-3 -top-3 z-10 h-6 w-6 rounded-full bg-accent text-xs text-white shadow"
        >
          ×
        </button>
        {(it.kind === "box" || it.kind === "image") && (
          <span
            onPointerDown={(e) => startResize(e, it)}
            className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-accent"
          />
        )}
      </>
    );

  return (
    <>
      <Header>
        {file && (
          <>
            <div className="flex flex-wrap gap-1">
              {TOOLS.map(([t, label, tip]) => (
                <Btn key={t} on={tool === t} title={tip} onClick={() => pickTool(t)}>
                  {label}
                </Btn>
              ))}
            </div>
            <input
              ref={imgInput}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                try {
                  setPending(await toEmbeddable(f));
                  setTool("image");
                  setSel(null);
                } catch (er) {
                  setErr(friendly(er));
                }
              }}
            />
            <label className="flex items-center gap-1 text-sm" title="Text and pen colour">
              <input
                type="color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  if (selItem?.kind === "text" || selItem?.kind === "ink") update(selItem.id, { color: e.target.value });
                }}
                className="h-8 w-8 cursor-pointer rounded border border-line bg-transparent"
              />
            </label>
            <label className="flex items-center gap-1 text-sm" title="Text size">
              <span className="text-dim">Aa</span>
              <input
                type="number"
                min={4}
                max={144}
                value={size}
                onChange={(e) => {
                  const v = Math.max(4, Math.min(144, +e.target.value || 14));
                  setSize(v);
                  if (selItem?.kind === "text") update(selItem.id, { size: v });
                }}
                className="w-14 rounded-md border border-line bg-transparent px-2 py-1 text-sm"
              />
            </label>
            <select
              value={family}
              onChange={(e) => setFont({ family: e.target.value as Family })}
              aria-label="Font"
              className="rounded-md border border-line bg-background px-2 py-1.5 text-sm"
            >
              <option value="Sans">Sans (Arial)</option>
              <option value="Serif">Serif (Times)</option>
              <option value="Mono">Mono (Courier)</option>
            </select>
            <Btn on={bold} aria-label="Bold" className="font-bold" onClick={() => setFont({ bold: !bold })}>B</Btn>
            <Btn on={italic} aria-label="Italic" className="italic" onClick={() => setFont({ italic: !italic })}>I</Btn>
            <div className="flex items-center gap-1">
              <Btn aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))}>−</Btn>
              <span className="w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
              <Btn aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.2))}>+</Btn>
            </div>
            <div className="ml-auto flex gap-2">
              <label className="flex cursor-pointer items-center rounded-md border border-line px-3 py-1.5 text-sm hover:bg-muted">
                Open…
                <input type="file" accept="application/pdf" className="sr-only" onChange={(e) => (open([...(e.target.files ?? [])]), (e.target.value = ""))} />
              </label>
              <Btn on disabled={!!busy} onClick={save}>
                Download PDF
              </Btn>
            </div>
          </>
        )}
      </Header>

      {(busy || err || pending) && (
        <p className={`px-4 py-2 text-sm ${err ? "text-accent" : "text-dim"}`}>
          {err || busy || "Click on a page to place the image."}
        </p>
      )}

      {!file ? (
        <div className="px-4">
          <Drop accept="application/pdf" onFiles={open} label="Choose a PDF to edit" />
        </div>
      ) : (
        <main className="flex flex-1 flex-col items-center gap-6 overflow-auto bg-desk p-4">
          {pages.map((p, n) => (
            <div key={n} className="relative shrink-0 bg-white shadow-lg" style={{ width: p.w * zoom, height: p.h * zoom }}>
              <PdfCanvas doc={file.doc} n={n} zoom={zoom} />
              <div
                className="absolute inset-0"
                style={{
                  touchAction: selectMode ? "auto" : "none",
                  cursor: selectMode ? "default" : tool === "text" ? "text" : tool === "image" ? "copy" : "crosshair",
                }}
                onPointerDown={(e) => onPagePointer(e, n)}
              />
              <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${p.w} ${p.h}`}>
                {items.map(
                  (it) =>
                    it.page === n &&
                    it.kind === "ink" && (
                      <path
                        key={it.id}
                        d={inkPath(it.points)}
                        fill="none"
                        stroke={it.color}
                        strokeWidth={sel === it.id ? it.width + 2 : it.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ pointerEvents: selectMode ? "stroke" : "none", cursor: "move", touchAction: "none" }}
                        onPointerDown={(e) => startMove(e, it)}
                      />
                    ),
                )}
              </svg>
              {tool === "text" &&
                p.runs.map(
                  (r, i) =>
                    !edited.has(`${n}:${i}`) && (
                      <span
                        key={i}
                        title="Click to edit this text"
                        onPointerDown={(e) => editRun(e, n, i, r)}
                        className="absolute cursor-text rounded-sm hover:bg-accent/10 hover:outline hover:outline-1 hover:outline-accent/60"
                        style={{ left: r.x * zoom, top: (r.base - r.size * r.asc) * zoom, width: r.w * zoom, height: r.size * (r.asc + r.desc) * zoom }}
                      />
                    ),
                )}
              {items.map((it) => {
                if (it.page !== n || it.kind === "ink") return null;
                if (it.kind === "text")
                  return (
                    <div
                      key={it.id}
                      className={`absolute ${sel === it.id ? "outline outline-1 outline-dashed outline-accent" : ""}`}
                      style={{ left: it.x * zoom, top: it.y * zoom }}
                    >
                      <div
                        ref={(el) => {
                          if (!el || el.dataset.ready) return;
                          el.dataset.ready = "1";
                          el.innerText = it.text;
                          if (!it.text || focusId.current === it.id) {
                            el.focus();
                            getSelection()?.selectAllChildren(el);
                            getSelection()?.collapseToEnd();
                            focusId.current = 0;
                          }
                        }}
                        contentEditable="plaintext-only"
                        suppressContentEditableWarning
                        spellCheck={false}
                        onFocus={() => setSel(it.id)}
                        onInput={(e) => update(it.id, { text: e.currentTarget.innerText })}
                        onBlur={(e) => !e.currentTarget.innerText.trim() && remove(it.id)}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="min-w-[1ch] whitespace-pre px-0 outline-none"
                        style={{ ...fontCss(it.font), fontSize: it.size * zoom, lineHeight: LINE, color: it.color }}
                      />
                      {sel === it.id && (
                        <span
                          title="Drag to move"
                          onPointerDown={(e) => startMove(e, it)}
                          className="absolute -left-6 top-0 flex h-5 w-5 cursor-move touch-none items-center justify-center rounded bg-accent text-[10px] text-white"
                        >
                          ✥
                        </span>
                      )}
                      {chrome(it)}
                    </div>
                  );
                return (
                  <div
                    key={it.id}
                    onPointerDown={(e) => startMove(e, it)}
                    className={`absolute touch-none ${it.kind === "box" && it.highlight ? "mix-blend-multiply" : ""} ${
                      sel === it.id ? "outline outline-1 outline-accent" : selectMode && it.kind === "box" && !it.highlight ? "outline outline-1 outline-dashed outline-dim/40" : ""
                    }`}
                    style={{
                      left: it.x * zoom,
                      top: it.y * zoom,
                      width: it.w * zoom,
                      height: it.h * zoom,
                      background: it.kind === "box" ? it.color : `center / 100% 100% url(${it.url})`,
                      pointerEvents: selectMode ? "auto" : "none",
                      cursor: "move",
                    }}
                  >
                    {chrome(it)}
                  </div>
                );
              })}
            </div>
          ))}
        </main>
      )}
    </>
  );
}
