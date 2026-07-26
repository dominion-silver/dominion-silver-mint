# Dominion Admin UI

Private Next.js app at `admin.dominion.market`. Squads-gated administrative console for Dominion Silver protocol.

## Setup

```bash
cd apps/admin
yarn install
cp .env.example .env.local  # fill in HELIUS + Squads multisig addresses
yarn dev   # runs on :3001
```

## Security

- Behind Cloudflare Access in production (second auth layer on top of Squads membership).
- `robots: noindex, nofollow` via metadata.
- Strict CSP (inherited from `next.config.ts`).
- Every admin action = create a Squads proposal, threshold-sign, execute (never direct signing).
- Wallet membership in Ops Squads verified via `@sqds/multisig` SDK before showing the dashboard.

## Structure

```
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx            # auth gate + dashboard
│   └── globals.css
├── components/
│   ├── WalletProvider.tsx
│   └── Dashboard.tsx       # treasury, supply, volumes, actions grid
└── lib/
    ├── constants.ts        # shared with public app
    ├── pdas.ts             # shared
    └── squads.ts           # Squads v4 multisig helpers
```

## TODO

1. Wire `@sqds/multisig` SDK: `getMembers()` for auth, `createProposal()` for actions, `vote()`, `execute()`, `getPendingProposals()`.
2. Replace `Dashboard.fetchDashboard` mock with real on-chain reads via Anchor Program (once IDL available).
3. Build action modals:
   - Premium change (new value input + preview)
   - Withdraw (amount + recipient + reserve ratio preview)
   - Oracle guards (Option<T> per field)
   - Reserve min-reserve (with impact simulation)
   - Metadata update (name, symbol, URI)
   - Compliance toggle (with big warning)
   - Pyth feed migration (auto-pauses)
   - Timelock duration
   - Pause / unpause / add guardian / remove guardian / deposit / transfer admin
4. Timelock queue viewer: pending proposals with countdown, cancel button (admin or guardian).
5. Event log viewer (from indexer).
6. Incident comm drafts: pre-written Twitter/Discord/status templates with state injection.

## Actions overview

| Action | Timelocked | Notes |
|---|---|---|
| `set_mint_caps` / `set_redeem_caps` / `set_hourly_redeem_cap` | Instant | Admin Squads signing only |
| `add_guardian` | Instant | Refuses the current AND the pending admin |
| `remove_guardian` | **SCHEDULES only** | Writes `pending_removal_at = now + 24h`. The guardian keeps every power until finalized. Refused if it would leave no guardian free to react |
| `finalize_guardian_removal` | Permissionless, after the 24h ETA | Anyone may apply a matured removal. Expires 7 days after the ETA |
| `cancel_guardian_removal` | Instant | Admin (free), the targeted guardian (ONCE), or anyone once the notice has expired |
| `propose_admin_transfer` + `accept_admin_transfer` | 2-step, 7d expiry | |
| `cancel_timelocked_action` | Instant | Admin OR guardian |
| `thaw_account` | Instant | Requires PermanentDelegate authority (Ops Squads vault) |
| `pause` | Instant | Admin OR guardian |
| `unpause` | Instant | Admin only |
| `deposit_usdc` | Instant | Anyone can deposit |
| `propose_set_premium_mint/redeem` → execute | 24h timelock | Mint pause during window |
| `propose_withdraw_usdc` → execute | 24h timelock | Blocked while paused at execute |
| `propose_set_oracle_guards` → execute | 24h timelock | Option<T> per field |
| `propose_set_treasury_min_reserve` → execute | 24h timelock | |
| `propose_update_metadata` → execute | 24h timelock | CPI to Token-2022 metadata interface |
| `propose_set_compliance_mode` → execute | 24h timelock | Atomic auto-pause on execute |
| `propose_set_pyth_feed` → execute | 24h timelock | Atomic auto-pause on execute |
| `propose_set_admin_timelock` → execute | 24h timelock | Bounded [1h, 30d] |
| `close_daily_counter` / `close_hourly_counter` / `close_timelock_account` | Instant | Rent reclaim after retention |
