// pinned-tools.ts — the launchpad's pinned tool list (the "应用配置" selection).
//
// Two surfaces toggle the same pins: the centre panel's tool dialog and the
// settings modal's 应用 section. They must not keep private copies, or the
// launchpad behind the settings dialog would still show the old grid. So both
// read and write one storage key and announce changes through one event.

import { useCallback, useSyncExternalStore } from 'react';

export const PINNED_ITEMS_KEY = 'coffee_pinned_items';
export const PINNED_ITEMS_LIMIT = 6;
const PINNED_ITEMS_EVENT = 'coffee-pinned-items';

/** Parse a stored value into ids: strings only, de-duplicated, capped. */
function parseItems(raw: string | null, cap: number): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const ids = parsed.filter((id): id is string => typeof id === 'string');
    return ids.filter((id, index) => ids.indexOf(id) === index).slice(0, cap);
  } catch { return []; }
}

// useSyncExternalStore compares snapshots by identity, so the parsed array has
// to be cached against the raw string it came from.
let cachedRaw: string | null | undefined;
let cachedItems: string[] = [];
function readRaw(): string | null {
  try { return localStorage.getItem(PINNED_ITEMS_KEY); } catch { return null; }
}
function snapshot(cap: number): string[] {
  const raw = readRaw();
  if (raw !== cachedRaw) { cachedRaw = raw; cachedItems = parseItems(raw, cap); }
  return cachedItems;
}

/** Current pins without subscribing — for one-off reads. */
export function readPinnedItems(cap: number = PINNED_ITEMS_LIMIT): string[] {
  return parseItems(readRaw(), cap);
}

/** Persist the pins and tell every other surface to re-read them. */
export function savePinnedItems(items: string[]): void {
  try { localStorage.setItem(PINNED_ITEMS_KEY, JSON.stringify(items)); } catch { /* Best-effort preference; a full quota must not break the grid. */ }
  cachedRaw = undefined;
  try { window.dispatchEvent(new Event(PINNED_ITEMS_EVENT)); } catch { /* No window (tests): nothing to notify. */ }
}

export function subscribePinnedItems(listener: () => void): () => void {
  window.addEventListener(PINNED_ITEMS_EVENT, listener);
  return () => window.removeEventListener(PINNED_ITEMS_EVENT, listener);
}

/** Pure toggle: the same list back when the cap blocks an add. */
export function togglePinnedItem(items: string[], id: string, cap: number = PINNED_ITEMS_LIMIT): string[] {
  if (items.includes(id)) return items.filter(item => item !== id);
  if (items.length >= cap) return items;
  return [...items, id];
}

/** Pins plus a toggle that persists and notifies every surface. */
export function usePinnedItems(cap: number = PINNED_ITEMS_LIMIT) {
  const items = useSyncExternalStore(subscribePinnedItems, () => snapshot(cap), () => []);
  const toggle = useCallback((id: string) => {
    savePinnedItems(togglePinnedItem(snapshot(cap), id, cap));
  }, [cap]);
  return [items, toggle] as const;
}
