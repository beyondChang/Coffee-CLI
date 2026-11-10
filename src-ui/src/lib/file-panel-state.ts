// file-panel-state.ts — remember which folders the right-panel file tree has
// expanded, per project. The tree's open/closed state used to live only in
// each BrowserDirNode's local useState, so switching to another project
// unmounted the nodes and every folder collapsed; switching back re-mounted
// them closed. Persisting the expanded set per (normalised) folder path keeps
// the tree's shape across project switches and app restarts.
//
// Keying by folder path (not session id) is deliberate: session ids are
// regenerated on restart, but a project's root path is stable.

const PREFIX = 'cc-file-expanded:';
const MAX_PROJECTS = 40; // older projects beyond this are pruned

export const normFolder = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function key(folderPath: string): string {
  return PREFIX + normFolder(folderPath);
}

export function loadExpanded(folderPath: string): Set<string> {
  try {
    const raw = localStorage.getItem(key(folderPath));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((p): p is string => typeof p === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function saveExpanded(folderPath: string, expanded: Set<string>): void {
  try {
    localStorage.setItem(key(folderPath), JSON.stringify([...expanded]));
    pruneOldProjects(folderPath);
  } catch {
    // Best-effort UI preference; a full quota must never break the tree.
  }
}

// Keep the number of remembered projects bounded so localStorage does not grow
// forever. We have no timestamp per key, so prune by key order (best effort):
// drop the oldest-looking entries beyond the cap, always keeping the current.
function pruneOldProjects(currentFolder: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    if (keys.length <= MAX_PROJECTS) return;
    const currentKey = key(currentFolder);
    const excess = keys.length - MAX_PROJECTS;
    let removed = 0;
    for (const k of keys) {
      if (removed >= excess) break;
      if (k === currentKey) continue;
      localStorage.removeItem(k);
      removed++;
    }
  } catch {
    // ignore
  }
}
