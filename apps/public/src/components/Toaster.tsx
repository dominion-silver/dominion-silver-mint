"use client";

import { useEffect, useState } from "react";

interface ToastEntry {
  id: number;
  message: string;
  variant: "success" | "error" | "info";
  href?: string;
  hrefLabel?: string;
}

// FE-L5: timestamp-based id avoids HMR collisions during dev
// (modules are reloaded; static counters reset, so two toasts could
// share an id). 53-bit precision is fine for our use.
function genId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

/**
 * Fire a toast from anywhere via window event. Decouples sender from receiver.
 *   toast({ message: "Mint confirmed", variant: "success", href: solscanUrl, hrefLabel: "View tx" })
 */
export function toast(entry: Omit<ToastEntry, "id">) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("dominion-toast", { detail: { ...entry, id: genId() } }),
  );
}

export function Toaster() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // FE-L3: errors get longer dwell so users can read 140-char messages.
  // Also exposes a programmatic dismiss via close button (FE-L4).
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      setToasts((cur) => [...cur, detail]);
      const timeoutMs = detail.variant === "error" ? 12_000 : 6_000;
      setTimeout(() => {
        setToasts((cur) => cur.filter((t) => t.id !== detail.id));
      }, timeoutMs);
    };
    window.addEventListener("dominion-toast", onToast);
    return () => window.removeEventListener("dominion-toast", onToast);
  }, []);

  function dismiss(id: number) {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }

  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto relative min-w-[280px] max-w-[420px] rounded-lg border px-4 py-3 pr-9 text-sm shadow-lg backdrop-blur ${
            t.variant === "success"
              ? "border-accent bg-accent/10 text-white"
              : t.variant === "error"
              ? "border-danger bg-danger/10 text-danger"
              : "border-border bg-card text-white"
          }`}
        >
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
            className="absolute right-2 top-2 text-base leading-none opacity-60 hover:opacity-100"
          >
            ×
          </button>
          <div className="break-words">{t.message}</div>
          {t.href && (
            <a
              href={t.href}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-xs text-accent underline"
            >
              {t.hrefLabel ?? "Open"}
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
