// Shared readers for the admin action form fields.
//
// A privileged two-sided switch has NO default: the <select> renders an empty placeholder first, and
// every reader (transaction builder AND the confirmation summary) goes through these helpers, which
// THROW when nothing was chosen. One code path, so no default can diverge between what the operator was
// shown and what gets encoded, and an unconsidered click cannot queue a live setting change.

/** Rendered as the placeholder option value. Empty means "not chosen yet". */
export const UNCHOSEN = "";

/** True when a field still needs an explicit operator choice. */
export const isUnchosen = (p: Record<string, string>, name: string): boolean =>
  (p[name] ?? UNCHOSEN) === UNCHOSEN;

/** Read a `bool` form field. Throws unless the operator chose explicitly. */
export const boolField = (
  p: Record<string, string>,
  name: string,
): boolean => {
  const v = p[name] ?? UNCHOSEN;
  if (v === UNCHOSEN) throw new Error(`Choose a value for "${name}" (on or off)`);
  return v === "true";
};

/** Read a `select` form field. Throws unless the operator chose explicitly,
 *  rather than silently passing `undefined` into an instruction argument. */
export const selectField = (
  p: Record<string, string>,
  name: string,
): string => {
  const v = p[name] ?? UNCHOSEN;
  if (v === UNCHOSEN) throw new Error(`Choose a value for "${name}"`);
  return v;
};

/** Render a field's value for the confirmation dialog, using the SAME state the
 *  builder will read, so the dialog can never disagree with what is encoded. */
export const displayField = (
  p: Record<string, string>,
  name: string,
): string => {
  const v = p[name] ?? UNCHOSEN;
  return v === UNCHOSEN ? "(not chosen)" : v;
};
