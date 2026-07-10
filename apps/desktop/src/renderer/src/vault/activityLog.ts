import type { ActivityEventInput } from "@renderer/env";

// Renderer-side gateway to the local activity log (main/activity.ts). Recording
// is best-effort and gated by the user's "Track my activity" setting, so it can
// be paused from Settings without threading a flag through every hook. Edit
// events are coalesced per note because autosave fires constantly — we don't
// want a log line for every keystroke pause.

let enabled = true;

/** Enable/disable recording globally (App mirrors the Settings toggle here). */
export function setActivityTracking(on: boolean): void {
  enabled = on;
}

/** Record one event, unless tracking is paused. Never throws. */
export function recordActivity(evt: ActivityEventInput): void {
  if (!enabled) return;
  void window.api.activity.record(evt).catch(() => {
    /* logging is best-effort */
  });
}

const EDIT_COALESCE_MS = 3 * 60 * 1000;
const lastEdit = new Map<string, number>();

/** Record an edit to a note, but at most once per note per few minutes so a
 *  long writing session collapses to a single "edited" event. */
export function recordEdit(path: string, title?: string): void {
  if (!enabled) return;
  const now = Date.now();
  if (now - (lastEdit.get(path) ?? 0) < EDIT_COALESCE_MS) return;
  lastEdit.set(path, now);
  recordActivity({ type: "edit", path, title });
}
