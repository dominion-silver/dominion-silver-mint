"use client";

// FE-L19: Next.js App Router error boundary.
// Catches render-time errors in the home page so a bug in MintRedeemCard
// (or anything else) doesn't blow up the whole app with a blank screen.
//
// Server-side errors and 404s are handled separately by Next.js.

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to console for dev visibility. In prod, wire to Sentry / analytics.
    console.error("App error boundary caught:", error);
  }, [error]);

  return (
    <div className="min-h-screen bg-bg p-8 text-white">
      <div className="mx-auto max-w-2xl rounded-xl border border-danger bg-card p-6">
        <h1 className="mb-3 text-xl font-bold text-danger">Something went wrong</h1>
        <p className="mb-4 text-sm text-muted">
          The app hit an unexpected error. Try reloading. If it persists, copy
          the error below and contact{" "}
          <a href="mailto:support@dominion.market" className="text-accent underline">
            support
          </a>
          .
        </p>
        <pre className="mb-4 max-h-48 overflow-auto rounded-md bg-bg p-3 text-xs text-danger">
          {error.message}
          {error.digest ? `\n\nDigest: ${error.digest}` : ""}
        </pre>
        <button
          onClick={reset}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-bg hover:bg-accentDim"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
