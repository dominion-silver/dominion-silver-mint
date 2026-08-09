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
