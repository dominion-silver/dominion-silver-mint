/**
 * Audit finding P-08: the cluster must DERIVE from the RPC, and everything cluster-dependent must
 * follow it.
 *
 * Four explorer links carried a literal `?cluster=devnet` and the low-SOL notice always pointed at the
 * devnet faucet. On mainnet that means the toast after a successful mint opens a transaction that does
 * not exist on the cluster it links to, which reads to the user as "my mint failed", and a user out of
 * SOL is sent to a faucet that cannot fund them.
 *
 * WHY A UNIT TEST AND NOT A BUNDLE GREP. My first check was `grep cluster=devnet` over a mainnet-env
 * build, expecting zero hits. It found two, and that proved nothing either way: both arms of
 * `CLUSTER === "devnet" ? "?cluster=devnet" : ""` are string literals in the source, so both survive
 * into the bundle whether or not the runtime ever reaches them. Presence of a literal is not evidence
 * about a value. This asserts the values.
 *
 * The env is set BEFORE the dynamic import in each case, because `CLUSTER` is computed once at module
 * evaluation from `process.env.NEXT_PUBLIC_*`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

async function load(rpc?: string) {
  vi.resetModules();
  if (rpc === undefined) {
    delete process.env.NEXT_PUBLIC_HELIUS_RPC;
    delete process.env.NEXT_PUBLIC_TRITON_RPC;
  } else {
    process.env.NEXT_PUBLIC_HELIUS_RPC = rpc;
    process.env.NEXT_PUBLIC_TRITON_RPC = rpc;
  }
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
    // unknown host to devnet would reintroduce the finding for exactly the deployments that matter.
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
