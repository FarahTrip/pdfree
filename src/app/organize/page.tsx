"use client";
import { useRef, useState } from "react";
import { Btn, Drop, Header } from "@/components/ui";
import { assemble, type Source } from "@/lib/ops";
import { baseName, download, friendly, isPdf, openPdf, readFile, toEmbeddable } from "@/lib/browser";

type Card = { key: string; src: number; index: number; rotate: number; thumb: string; label: string };

const ACCEPT = "application/pdf,image/*";

export default function Organize() {
  const sources = useRef<Source[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [name, setName] = useState("merged");
  const dragKey = useRef("");

  async function add(files: File[]) {
    setErr("");
    if (!cards.length && files[0]) setName(baseName(files[0].name));
    for (const f of files) {
      setBusy(`Reading ${f.name}…`);
      try {
        if (isPdf(f)) {
          const bytes = await readFile(f);
          const doc = await openPdf(bytes);
          const src = sources.current.push({ kind: "pdf", bytes }) - 1;
          // ponytail: renders every thumbnail up front; lazy-render on scroll if 500+ page files show up
          for (let i = 0; i < doc.numPages; i++) {
            const page = await doc.getPage(i + 1);
            const vp = page.getViewport({ scale: 1 });
            const canvas = document.createElement("canvas");
            const view = page.getViewport({ scale: 320 / Math.max(vp.width, vp.height) });
            canvas.width = view.width;
            canvas.height = view.height;
            await page.render({ canvas, viewport: view }).promise;
            const thumb = canvas.toDataURL("image/jpeg", 0.8);
            setCards((c) => [...c, { key: `${src}:${i}`, src, index: i, rotate: 0, thumb, label: `${f.name} · ${i + 1}` }]);
          }
          await doc.loadingTask.destroy();
        } else if (f.type.startsWith("image/")) {
          const img = await toEmbeddable(f);
          const src = sources.current.push({ kind: "image", bytes: img.bytes, png: img.png }) - 1;
          setCards((c) => [...c, { key: `${src}:0`, src, index: 0, rotate: 0, thumb: img.url, label: f.name }]);
        } else {
          setErr(`${f.name}: only PDFs and images.`);
        }
      } catch (e) {
        setErr(`${f.name}: ${friendly(e)}`);
      }
    }
    setBusy("");
  }

  async function save(only?: Set<string>) {
    const list = only ? cards.filter((c) => only.has(c.key)) : cards;
    setBusy("Building PDF…");
    try {
      download(await assemble(sources.current, list), `${name || "document"}.pdf`);
    } catch (e) {
      setErr(friendly(e));
    }
    setBusy("");
  }

  const patch = (key: string, f: (c: Card) => Partial<Card>) =>
    setCards((cs) => cs.map((c) => (c.key === key ? { ...c, ...f(c) } : c)));

  function move(from: string, to: string) {
    setCards((cs) => {
      const a = [...cs];
      const j = a.findIndex((c) => c.key === to);
      const [card] = a.splice(a.findIndex((c) => c.key === from), 1);
      a.splice(j, 0, card); // dragging right lands after the target, left lands before
      return a;
    });
  }

  const remove = (keys: Set<string>) => {
    setCards((cs) => cs.filter((x) => !keys.has(x.key)));
    setPicked((p) => new Set([...p].filter((k) => !keys.has(k))));
  };

  const togglePick = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (!n.delete(key)) n.add(key);
      return n;
    });

  return (
    <>
      <Header>
        {cards.length > 0 && (
          <>
            <label className="flex cursor-pointer items-center rounded-md border border-line px-3 py-1.5 text-sm hover:bg-muted">
              + Add files
              <input type="file" accept={ACCEPT} multiple className="sr-only" onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
            </label>
            <Btn onClick={() => setCards((c) => c.map((x) => ({ ...x, rotate: x.rotate + 90 })))}>↻ Rotate all</Btn>
            {picked.size > 0 && (
              <>
                <Btn onClick={() => remove(picked)}>
                  Delete {picked.size}
                </Btn>
                <Btn onClick={() => save(picked)}>Extract {picked.size} as PDF</Btn>
                <Btn onClick={() => setPicked(new Set())}>Clear selection</Btn>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="File name"
                className="w-40 rounded-md border border-line bg-transparent px-2 py-1.5 text-sm"
              />
              <Btn on disabled={!!busy || !cards.length} onClick={() => save()}>
                Download PDF ({cards.length} pages)
              </Btn>
            </div>
          </>
        )}
      </Header>

      {(busy || err) && (
        <p className={`px-4 py-2 text-sm ${err ? "text-accent" : "text-dim"}`}>{err || busy}</p>
      )}

      {!cards.length ? (
        <div className="px-4">
          <Drop accept={ACCEPT} multiple onFiles={add} label="Choose PDFs or images" />
          <p className="mt-4 text-center text-sm text-dim">Merge, reorder, rotate, delete and extract pages. Images become pages.</p>
        </div>
      ) : (
        <main
          className="grid flex-1 content-start grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-4 p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            // Files dropped onto the grid get appended; card drags are handled per card.
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              add([...e.dataTransfer.files]);
            }
          }}
        >
          {cards.map((c, n) => (
            <div
              key={c.key}
              draggable
              onDragStart={() => (dragKey.current = c.key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                if (!dragKey.current || e.dataTransfer.files.length) return;
                e.stopPropagation();
                if (dragKey.current !== c.key) move(dragKey.current, c.key);
                dragKey.current = "";
              }}
              onClick={() => togglePick(c.key)}
              className={`group relative cursor-grab rounded-xl border-2 bg-desk p-2 transition active:cursor-grabbing ${
                picked.has(c.key) ? "border-accent" : "border-transparent hover:border-line"
              }`}
            >
              <div className="flex aspect-square items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={c.thumb}
                  alt={c.label}
                  draggable={false}
                  className="max-h-full max-w-full bg-white shadow transition-transform"
                  style={{ transform: `rotate(${c.rotate}deg)` }}
                />
              </div>
              <div className="mt-2 flex items-center gap-1 text-xs">
                <span className="font-semibold">{n + 1}</span>
                <span className="truncate text-dim" title={c.label}>
                  {c.label}
                </span>
              </div>
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition group-hover:opacity-100">
                {([
                  ["↺", "Rotate left", () => patch(c.key, (x) => ({ rotate: x.rotate - 90 }))],
                  ["↻", "Rotate right", () => patch(c.key, (x) => ({ rotate: x.rotate + 90 }))],
                  ["×", "Delete page", () => remove(new Set([c.key]))],
                ] as const).map(([icon, title, fn]) => (
                  <button
                    key={title}
                    title={title}
                    aria-label={title}
                    onClick={(e) => (e.stopPropagation(), fn())}
                    className="h-7 w-7 rounded-full bg-foreground/80 text-sm text-background hover:bg-accent"
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </main>
      )}
    </>
  );
}
