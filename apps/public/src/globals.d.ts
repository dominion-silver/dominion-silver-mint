// Global window typings for the Dominion app.
// FE-M5 in REVIEW_REPORT.md: replaces (window as any) casts.

declare global {
  interface Window {
    /** Manually triggers TransactionHistory SWR refresh. Set by the component. */
    __dominionHistoryRefresh?: () => void;
  }
}

export {};
