/**
 * ROUND 8 A-06. The rule that decides whether a two-phase run may destroy its own record.
 *
 * It lives here, apart from the devnet runner, for one reason: the runner needs a cluster and a
 * funded admin, so the only way to exercise its teardown was to actually perform a timelocked change
 * on a live chain. That is exactly why the defect survived. The runner ended both branches with an
 * unconditional `fs.rmSync(STATE_PATH)` and a success line, while the read-back checks it had just
 * performed went through a soft `ok()` that records a failure and continues. A stale or unavailable
 * read-back therefore printed a red line, the word DONE, and deleted the only file that could resume
 * or investigate the run.
 *
 * A decision this small should not need a devnet. Separated, it is a pure function of the failure
 * count and the two fixtures below cost nothing to run.
 */
export type StateDisposition = {
  /** Delete the run record. Only ever true when nothing failed. */
  remove: boolean;
  /** What the operator reads. Must never say DONE while a check is red. */
  lines: string[];
};

export function decideStateDisposition(
  failures: number,
  statePath: string,
  resumeHint: string,
): StateDisposition {
  if (failures === 0) {
    // Removing on green matters too: a stale record left behind makes `assertResumable` compare the
    // NEXT run against a finished one, which is the other way this goes wrong.
    return { remove: true, lines: ["DONE."] };
  }
  return {
    remove: false,
    lines: [
      `NOT DONE. ${failures} check(s) failed after the transaction confirmed.`,
      `The run record is KEPT at ${statePath} so this can be resumed or investigated.`,
      resumeHint,
    ],
  };
}

/**
 * ROUND 8 FINAL-05. WHAT A RESUMED RUN IS LOOKING AT.
 *
 * Keeping the file on red was only half the fix. The line printed next promised `--execute` would
 * resume, and it could not: if the transaction actually LANDED but the first read-back was stale,
 * the file still says `from = A` while the chain says B, so `assertResumable` refuses immediately
 * and the run can never be finalised. The operator holds a record nothing can consume.
 *
 * Classifying the three real situations is what makes the printed command truthful.
 */
export type ResumeVerdict =
  | { kind: "execute"; message: string }
  | { kind: "already-landed"; message: string }
  | { kind: "investigate"; message: string };

export function classifyResume(
  state: { from: string; to: string; nonce: number | string },
  onChain: { inventoryWallet: string; pendingNonce: number | string | null },
): ResumeVerdict {
  // A + the exact proposal still armed: the timelock never executed. Resume normally.
  if (onChain.inventoryWallet === state.from && String(onChain.pendingNonce) === String(state.nonce)) {
    return {
      kind: "execute",
      message: `the change is still queued as nonce ${state.nonce}; resume with --execute`,
    };
  }
  // B + slot released: it DID land, and only the read-back was stale. Finish the proof and clear.
  if (onChain.inventoryWallet === state.to && onChain.pendingNonce === null) {
    return {
      kind: "already-landed",
      message: `the change to ${state.to} already landed and the slot is free; closing the record`,
    };
  }
  // Anything else is a state nobody predicted, and guessing here is how evidence gets destroyed.
  return {
    kind: "investigate",
    message:
      `unexpected on-chain state: wallet=${onChain.inventoryWallet}, ` +
      `pending=${onChain.pendingNonce ?? "none"}, expected A=${state.from} B=${state.to} ` +
      `nonce=${state.nonce}. The record is kept; investigate before re-running.`,
  };
}
