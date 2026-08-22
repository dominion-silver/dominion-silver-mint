/**
 * Turn a LEVEL alarm into an EDGE alarm, because the level version made the channel useless.
 * WHAT WENT WRONG, measured rather than supposed. On 2026-08-21 the last 100 runs of both monitors were
 * failures, 100 out of 100, and the Telegram channel plus a GitHub "run failed" email carried the same
 * three lines every ten minutes for days:
 *     premium_bps_mint CHANGED: now 5, pinned 100      <- our own deliberate fee change
 *     treasury 6.90 USDC is below the 10.00 minimum    <- true, and true continuously since 14 Aug
 *     1 of 1 program transactions REVERTED (100%)      <- a percentage over a sample of one
 * Every one of those was CORRECT. That is the point: correctness is not the bar. A condition that stays
 * true re-sends forever, so the operator learns the channel says nothing new and stops reading it, and
 * then the one message that matters arrives into a muted channel. The treasury line above is exactly
 * that message, and it was buried under its own repetitions.
 * SO THE UNIT OF ALERTING IS A TRANSITION, not a state:
 *   - a condition that was absent and is now present    -> notify
 *   - a condition that was present and is now gone      -> notify once, as RESOLVED, then forget it
 *   - a condition that was present and still is         -> SILENT, until `renotifyHours` has passed
 * The re-notify exists so a real ongoing problem cannot be forgotten entirely. Twelve hours is chosen so
 * an incident that starts overnight is raised again in the morning, and no more often.
 * THE KEY IS THE MESSAGE WITH ITS NUMBERS REMOVED, and this is the load-bearing detail. "treasury 6.90
 * USDC is below" and "treasury 6.85 USDC is below" are the SAME condition; keying on the raw string
 * would make every run a fresh alert and rebuild the exact flood this file exists to stop. Numbers are
 * replaced by `#` for identity, while the message that gets SENT keeps its real figures.
 * STATE LIVES IN A FILE, restored by actions/cache. A cache miss degrades to "everything looks new", so
 * the worst case after an eviction is one duplicate message, never silence. Chosen over a database or a
 * committed file because branch protection forbids pushing to main and a monitor must not need a write
 * token to say something.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Where the state lives. Overridable so a local run cannot disturb the scheduler's history. */
const STATE_FILE = process.env.MONITOR_STATE_FILE ?? ".monitor-state/alerts.json";
/** How long a still-true condition stays silent before it is raised again. */
const RENOTIFY_HOURS = Number(process.env.MONITOR_RENOTIFY_HOURS ?? 12);

type Entry = { firstSeen: number; lastNotified: number; text: string };
type State = Record<string, Entry>;

/**
 * The identity of a condition, independent of the figures inside it.
 * Digits, decimals and thousands separators all collapse to `#`, so a drifting balance or a moving
 * percentage keeps one identity. Addresses survive, which is intended: a DIFFERENT address in an
 * authority-drift alert is a genuinely different event and must page.
 */
export function alertKey(text: string): string {
  return text
    .replace(/[\d][\d,._]*/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function load(): State {
  try {
    if (!existsSync(STATE_FILE)) return {};
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    // Corrupt state must not take the monitor down: an unreadable history means "notify", not "crash".
    return {};
  }
}

function save(s: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    // Losing the write means the next run re-notifies. Say so, and carry on: a state file that cannot
    // be written is a noise problem, and going quiet instead would be a safety problem.
    console.error(`  alert state NOT persisted (${e instanceof Error ? e.message : e}): the next run may repeat itself.`);
  }
}

export type Transitions = {
  /** Conditions that were not open on the previous run. These are what an alert message should carry. */
  fresh: string[];
  /** Conditions open long enough to be raised again, with how long they have been open. */
  reminders: Array<{ text: string; hoursOpen: number }>;
  /** Conditions that were open and are now gone. Worth one message, because recovery is news too. */
  resolved: string[];
  /** Everything currently true, for a digest that reports state rather than transitions. */
  open: string[];
  /** True when there is nothing to send. The caller should stay silent, NOT report success loudly. */
  quiet: boolean;
};

/**
 * Diff the current alert set against the previous run and persist the result.
 * `hadStateFile` is returned so the caller can say "first run, everything looks new" instead of
 * presenting a cache miss as a burst of incidents.
 */
export function diffAlerts(current: string[]): Transitions & { hadStateFile: boolean } {
  const hadStateFile = existsSync(STATE_FILE);
  const prev = load();
  const now = Date.now();
  const renotifyMs = RENOTIFY_HOURS * 3_600_000;

  const next: State = {};
  const fresh: string[] = [];
  const reminders: Array<{ text: string; hoursOpen: number }> = [];

  for (const text of current) {
    const key = alertKey(text);
    const was = prev[key];
    if (!was) {
      fresh.push(text);
      next[key] = { firstSeen: now, lastNotified: now, text };
    } else if (now - was.lastNotified >= renotifyMs) {
      reminders.push({ text, hoursOpen: (now - was.firstSeen) / 3_600_000 });
      next[key] = { ...was, lastNotified: now, text };
    } else {
      // Still true, still silent. firstSeen is preserved so "open for 3 days" stays accurate.
      next[key] = { ...was, text };
    }
  }

  const currentKeys = new Set(current.map(alertKey));
  const resolved = Object.entries(prev)
    .filter(([k]) => !currentKeys.has(k))
    .map(([, v]) => v.text);

  save(next);

  return {
    fresh,
    reminders,
    resolved,
    open: current,
    quiet: fresh.length === 0 && reminders.length === 0 && resolved.length === 0,
    hadStateFile,
  };
}
