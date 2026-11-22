import Link from "next/link";
import { Header } from "@/components/ui";

const tools = [
  { href: "/edit", title: "Edit & sign", body: "Add text, sign, draw, highlight, white-out, drop in images." },
  { href: "/organize", title: "Organize", body: "Merge files, reorder, rotate, delete or extract pages. Images to PDF." },
];

export default function Home() {
  return (
    <>
      <Header />
      <main className="mx-auto w-full max-w-3xl px-4 py-20">
        <h1 className="text-5xl font-bold tracking-tight">
          PDF tools that are <span className="text-accent">actually free.</span>
        </h1>
        <p className="mt-4 text-lg text-dim">
          No account. No watermark. No page limit. Your files never leave your browser.
        </p>
        <div className="mt-12 grid gap-4 sm:grid-cols-2">
          {tools.map((t) => (
            <Link
              key={t.href}
              href={t.href}
              className="rounded-2xl border border-line p-6 transition hover:border-accent hover:shadow-lg"
            >
              <h2 className="text-xl font-semibold">{t.title} →</h2>
              <p className="mt-2 text-dim">{t.body}</p>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
