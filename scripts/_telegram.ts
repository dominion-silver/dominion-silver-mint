/**
 * Post an alert to Telegram.
 * WHY A DEDICATED TRANSPORT rather than the existing generic webhook. `redeem-monitor.ts` emits
 * `{text, content, report}` so one POST satisfies Slack, Discord and anything generic. Telegram is not
 * webhook-shaped: it wants `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with a `chat_id` in
 * the body. Pointing `REDEEM_MONITOR_WEBHOOK` at Telegram would 400 on every alert, which is the worst
 * possible failure for an alerting path: configured, silent, and only discovered during an incident.
 * NO parse_mode, ON PURPOSE. Telegram's MarkdownV2 requires escaping `_ * [ ] ~ > # + - = | { } . !`
 * and an unescaped character makes the API reject the whole message. Alert text here contains
 * addresses, decimals and parentheses, so any formatting attempt turns a real alert into a 400. Plain
 * text always delivers, and delivery beats typography for something read at 3am.
 * FAILING TO ALERT MUST BE LOUD. `sendTelegram` returns a boolean and never throws: a monitor that
 * crashes while reporting a problem reports nothing. The caller decides what a delivery failure means,
 * and the callers here treat it as a reason to keep a non-zero exit code so the scheduler still pages.
 */

const API = "https://api.telegram.org";

/** Telegram rejects messages over 4096 characters. Truncating beats a 400 that delivers nothing. */
const MAX_CHARS = 3900;

export type TelegramConfig = { token: string; chatId: string };

/**
 * Read the credentials from the environment, or null when the channel is not configured.
 * Returning null rather than throwing is deliberate: every script that can alert must also be runnable
 * locally by an operator who has no bot token, and refusing to run without one would push people to
 * comment out the alerting.
 */
export function telegramFromEnv(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
}

/** Never let a token reach a log. Only the bot id before the colon is safe, and it is public anyway. */
export function redactToken(token: string): string {
  const [id] = token.split(":");
  return `${id ?? "?"}:REDACTED`;
}

export async function sendTelegram(cfg: TelegramConfig, text: string): Promise<boolean> {
  const body = {
    chat_id: cfg.chatId,
    text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n[tronque]` : text,
    // Alerts must buzz. A silenced alert is indistinguishable from no alert.
    disable_notification: false,
  };
  try {
    const res = await fetch(`${API}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (json?.ok) return true;
    // The description is the useful half: "chat not found" and "bot was kicked" are operator errors
    // with completely different fixes, and both look identical without it.
    console.error(`  telegram delivery FAILED: ${res.status} ${json?.description ?? "no description"}`);
    return false;
  } catch (e) {
    console.error(`  telegram delivery FAILED: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Ping a dead-man's-switch URL, if one is configured.
 * WHY THIS IS NOT OPTIONAL FURNITURE. A monitor that stops running looks exactly like a monitor that
 * finds nothing wrong, and this one is a GitHub Actions cron: scheduled runs are queued and get
 * skipped under load. Measured on 2026-08-13, the first scheduled run after the workflow reached the
 * default branch took over an hour and a half to fire.
 * So silence cannot be trusted, and the only thing that can detect silence is something OUTSIDE this
 * process. Set HEARTBEAT_URL to a healthchecks.io (or equivalent) ping URL: it alerts when the ping
 * stops. Without it, nothing tells anyone the monitor died.
 * Pinged only on a completed run, alert or not: the question it answers is "did the check happen",
 * which is independent of what the check found.
 */
export async function pingHeartbeat(): Promise<void> {
  const url = process.env.HEARTBEAT_URL?.trim();
  if (!url) {
    console.log("  heartbeat: HEARTBEAT_URL not set, so nothing will notice if this monitor stops.");
    return;
  }
  try {
    const res = await fetch(url, { method: "GET" });
    console.log(`  heartbeat: ${res.ok ? "sent" : `endpoint answered ${res.status}`}`);
  } catch (e) {
    console.error(`  heartbeat FAILED: ${e instanceof Error ? e.message : e}`);
  }
}
