"use client";
import Link from "next/link";
import { useState } from "react";

export function Header({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-line bg-background/90 px-4 py-2 backdrop-blur">
      <Link href="/" className="mr-2 text-lg font-bold tracking-tight">
        PD<span className="text-accent">Free</span>
      </Link>
      {children}
    </header>
  );
}

export function Btn({ on, className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button
      {...p}
      className={`rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-40 ${
        on ? "border-accent bg-accent text-white" : "border-line hover:bg-muted"
      } ${className}`}
    />
  );
}

export function Drop({
  accept,
  multiple,
  onFiles,
  label,
}: {
  accept: string;
  multiple?: boolean;
  onFiles: (f: File[]) => void;
  label: string;
}) {
  const [over, setOver] = useState(false);
  return (
    <label
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onFiles([...e.dataTransfer.files]);
      }}
      className={`mx-auto mt-16 flex w-full max-w-xl cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed p-16 text-center transition ${
        over ? "border-accent bg-accent/5" : "border-line hover:border-accent"
      }`}
    >
      <span className="text-lg font-medium">{label}</span>
      <span className="text-sm text-dim">or drop {multiple ? "files" : "a file"} here. Nothing is uploaded.</span>
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </label>
  );
}
