// pending-rename.ts — ask a freshly created tree row to open its rename input.
//
// Creating a file/folder happens from the context menu, but the inline rename
// state lives inside the row component that only mounts after the directory
// refreshes. The request is therefore parked here: whichever row matches the
// path picks it up when it mounts (or immediately, if it already exists), and
// the request is consumed exactly once.

const normalize = (path: string) => path.replace(/\\/g, '/');

let pending: string | null = null;
const EVENT = 'cc-pending-rename';

/** Park a rename request and nudge any already-mounted row to look at it. */
export function requestRename(path: string) {
  pending = normalize(path);
  window.dispatchEvent(new Event(EVENT));
}

/** True once, for the row that owns `path`. */
export function consumePendingRename(path: string): boolean {
  if (!pending || pending !== normalize(path)) return false;
  pending = null;
  return true;
}

/** Subscribe to new requests; returns the unsubscribe function. */
export function onPendingRename(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
