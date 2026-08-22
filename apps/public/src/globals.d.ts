// Global window typings for the Dominion app.
// Typed window globals, so call sites do not need (window as any) casts.

declare global {
  interface Window {
    /** Manually triggers TransactionHistory SWR refresh. Set by the component. */
    __dominionHistoryRefresh?: () => void;
  }
}

export {};
