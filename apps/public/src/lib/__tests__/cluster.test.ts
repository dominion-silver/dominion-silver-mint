/**
 * Audit finding : the cluster must DERIVE from the RPC, and everything cluster-dependent must
 * follow it.
 * Four explorer links carried a literal `?cluster=devnet` and the low-SOL notice always pointed at the
 * devnet faucet. On mainnet that means the toast after a successful mint opens a transaction that does
 * not exist on the cluster it links to, which reads to the user as "my mint failed", and a user out of
 * SOL is sent to a faucet that cannot fund them.
 * WHY A UNIT TEST AND NOT A BUNDLE GREP. My first check was `grep cluster=devnet` over a mainnet-env
 * build, expecting zero hits. It found two, and that proved nothing either way: both arms of
 * `CLUSTER === "devnet" ? "?cluster=devnet" : ""` are string literals in the source, so both survive
 * into the bundle whether or not the runtime ever reaches them. Presence of a literal is not evidence
 * about a value. This asserts the values.
 * The env is set BEFORE the dynamic import in each case, because `CLUSTER` is computed once at module
 * evaluation from `process.env.NEXT_PUBLIC_*`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * this helper used to set BOTH `NEXT_PUBLIC_HELIUS_RPC` and
 * `NEXT_PUBLIC_TRITON_RPC` to the same value in every case, which made the production configuration
 * unreachable from this suite. The runbook lists only HELIUS, TRITON has no consumer in the app, and
 * TRITON's fallback to devnet was what poisoned `CLUSTER`. A test that can only express the
 * both-set shape cannot fail on the only shape that ships.
 * `triton` is therefore separate, and defaults to UNSET, which is production.
 */
async function load(rpc?: string, triton?: string) {
  vi.resetModules();
  if (rpc === undefined) delete process.env.NEXT_PUBLIC_HELIUS_RPC;
  else process.env.NEXT_PUBLIC_HELIUS_RPC = rpc;
  if (triton === undefined) delete process.env.NEXT_PUBLIC_TRITON_RPC;
  else process.env.NEXT_PUBLIC_TRITON_RPC = triton;
  return await import("../constants");
}

afterEach(() => {
  delete process.env.NEXT_PUBLIC_HELIUS_RPC;
  delete process.env.NEXT_PUBLIC_TRITON_RPC;
});

describe("cluster derivation drives every cluster-dependent output", () => {
  it("no RPC env means devnet, and devnet links carry the cluster parameter", async () => {
    const c = await load(undefined);
    expect(c.CLUSTER).toBe("devnet");
    expect(c.solscanTx("SIG")).toBe("https://solscan.io/tx/SIG?cluster=devnet");
    expect(c.solscanAccount("ADDR")).toBe("https://solscan.io/account/ADDR?cluster=devnet");
    expect(c.SOL_TOPUP_URL).toBe("https://faucet.solana.com");
  });

  it("a mainnet RPC means mainnet, links carry NO cluster parameter, and there is no faucet", async () => {
    const c = await load("https://mainnet.helius-rpc.com/?api-key=x");
    expect(c.CLUSTER).toBe("mainnet-beta");
    // The parameter must be ABSENT, not "mainnet-beta": solscan's default is mainnet and an explicit
    // wrong value is worse than none.
    expect(c.solscanTx("SIG")).toBe("https://solscan.io/tx/SIG");
    expect(c.solscanTx("SIG")).not.toContain("cluster");
    expect(c.solscanAccount("ADDR")).toBe("https://solscan.io/account/ADDR");
    // Null, not a faucet URL: there is no mainnet faucet, so the UI must say something else.
    expect(c.SOL_TOPUP_URL).toBeNull();
  });

  it("an unrecognised private RPC host is treated as mainnet, not devnet", async () => {
    // A real mainnet operator uses a private endpoint whose hostname says nothing. Defaulting an
    // unknown host to devnet would reintroduce the scenario for exactly the deployments that matter.
    for (const rpc of [
      "https://dominion.rpcpool.com",
      "https://my-node.internal/rpc",
      "https://solana-mainnet.g.alchemy.com/v2/key",
    ]) {
      const c = await load(rpc);
      expect(c.CLUSTER, rpc).toBe("mainnet-beta");
      expect(c.SOL_TOPUP_URL, rpc).toBeNull();
    }
  });

  it("an explicit devnet RPC is still devnet", async () => {
    const c = await load("https://api.devnet.solana.com");
    expect(c.CLUSTER).toBe("devnet");
    expect(c.EXPLORER_CLUSTER_QS).toBe("?cluster=devnet");
  });
});

describe("the production configuration: HELIUS set, TRITON unset", () => {
  it("a mainnet HELIUS with TRITON unset is mainnet (the P0 this suite could not see)", async () => {
    const c = await load("https://mainnet.helius-rpc.com/?api-key=real");
    expect(c.CLUSTER).toBe("mainnet-beta");
    expect(c.solscanTx("SIG")).toBe("https://solscan.io/tx/SIG");
    expect(c.SOL_TOPUP_URL).toBeNull();
  });

  it("a stale TRITON pointing at devnet does NOT drag the cluster back to devnet", async () => {
    // The variable has no consumer, so it must have no influence. If it ever gains one, that consumer
    // is the thing that has to be reconciled, not the cluster derivation.
    const c = await load(
      "https://mainnet.helius-rpc.com/?api-key=real",
      "https://api.devnet.solana.com",
    );
    expect(c.CLUSTER).toBe("mainnet-beta");
  });

  it("the cluster follows the endpoint the app actually connects with", async () => {
    const c = await load("https://api.devnet.solana.com", "https://mainnet.helius-rpc.com/?x=1");
    expect(c.APP_RPC).toBe("https://api.devnet.solana.com");
    expect(c.CLUSTER).toBe("devnet");
  });

  it("a mainnet URL merely CONTAINING 'devnet' is still mainnet", async () => {
    // Same class as the scripts-side : match on the host, not on the URL.
    for (const rpc of [
      "https://api.mainnet-beta.solana.com/?tag=devnet-mirror",
      "https://mainnet.helius-rpc.com/?api-key=7fdevnet91-aaaa",
    ]) {
      const c = await load(rpc);
      expect(c.CLUSTER, rpc).toBe("mainnet-beta");
      expect(c.SOL_TOPUP_URL, rpc).toBeNull();
    }
  });
});
