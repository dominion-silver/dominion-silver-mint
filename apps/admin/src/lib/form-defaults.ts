// Shared readers for the admin action form fields.
//
// AUDIT finding A-02 (P1, operator integrity) and its follow-up review.
//
// Original defect: the boolean <select> rendered `value={params[...] ?? "true"}`
// so it DISPLAYED "on / true", but the value was never written to state until the
// operator changed it, and the builders read `p.on === "true"`, which is FALSE
// for `undefined`. An untouched dropdown submitted the OPPOSITE of what it showed.
//
// First remediation shared a single default between the render and the read. The
// review then showed that was still wrong in two ways:
//   1. `window.confirm`'s summary read the raw params map, a THIRD default, so the
//      operator's last-chance dialog said "(empty)" while the builder encoded true.
//   2. Defaulting to "true" made an unconsidered click MORE dangerous, not less:
//      an untouched `propose_set_compliance_mode` would queue compliance ON, and
//      executing a compliance change auto-pauses the protocol. The previous bug at
//      least encoded a harmless no-op.
//
// So there is now NO default for these fields. A privileged two-sided switch must
// be chosen explicitly: the <select> renders an empty placeholder first, and every
// reader (builder AND confirmation summary) goes through these helpers, which throw
// when nothing was chosen. One code path, no default to diverge from.

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
