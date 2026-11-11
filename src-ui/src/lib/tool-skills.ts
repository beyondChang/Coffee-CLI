import { commands, type SkillInventory, type CatalogSkill } from '../tauri';

const KEY = 'cc-tool-skills-v1';
const inventories = new Map<string, SkillInventory>();
const catalogues = new Map<string, CatalogSkill[]>();
const pending = new Map<string, Promise<CatalogSkill[]>>();
const listeners = new Map<string, Set<(items: CatalogSkill[]) => void>>();
const descriptions = new Map<string, string>();
const pendingDescriptions = new Map<string, Promise<string>>();
const summaries = new Map<string, string>();
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
  for (const [key, value] of saved?.inventories ?? []) if (typeof key === 'string' && Array.isArray(value?.skills) && typeof value.supported === 'boolean') inventories.set(key, value);
  for (const [key, value] of saved?.catalogues ?? []) if (typeof key === 'string' && Array.isArray(value)) catalogues.set(key, value);
  for (const [key, value] of saved?.descriptions ?? []) if (typeof key === 'string' && typeof value === 'string') descriptions.set(key, value);
  for (const [key, value] of saved?.summaries ?? []) if (typeof key === 'string' && typeof value === 'string') summaries.set(key, value);
} catch { /* Optional snapshots. */ }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ inventories:[...inventories].slice(-24), catalogues:[...catalogues].slice(-8), descriptions:[...descriptions].slice(-120), summaries:[...summaries].slice(-120) })); } catch { /* Memory remains available. */ }
}
export function readSkillInventory(tool: string) { return inventories.get(tool); }
export function saveSkillInventory(tool: string, inventory: SkillInventory) { inventories.set(tool, inventory); persist(); }
export function readSkillCatalogue(query: string) { return catalogues.get(query); }
export function readSkillDescription(source: string, name: string) { return descriptions.get(`${source}/${name}`); }
/** Chinese AI summary cached for instant re-display. Keys follow the backend:
 *  installed folders use "local:<path>" (the on-disk version is what was
 *  summarized); catalogue skills use "source/name". */
export function skillSummaryKey(item: { source?: string | null; name: string; path?: string }) {
  return item.path ? `local:${item.path}` : `${item.source}/${item.name}`;
}
export function readSkillSummary(key: string) { return summaries.get(key); }
export function saveSkillSummary(key: string, summary: string) {
  summaries.set(key, summary);
  if (summaries.size > 120) summaries.delete(summaries.keys().next().value!);
  persist();
}
export function fetchSkillDescription(source: string, name: string) {
  const key = `${source}/${name}`;
  let request = pendingDescriptions.get(key);
  if (!request) {
    request = commands.getToolSkillDescription(source, name).then(value => { descriptions.set(key, value); if (descriptions.size > 120) descriptions.delete(descriptions.keys().next().value!); persist(); return value; }).finally(() => pendingDescriptions.delete(key));
    pendingDescriptions.set(key, request);
  }
  return request;
}
export function fetchSkillCatalogue(query: string, onUpdate?: (items: CatalogSkill[]) => void) {
  if (!listeners.has(query)) listeners.set(query, new Set());
  if (onUpdate) listeners.get(query)!.add(onUpdate);
  let request = pending.get(query);
  if (!request) {
    let complete = false;
    const publish = (items: CatalogSkill[], complete = false) => {
      const current = catalogues.get(query) ?? [];
      const incoming = new Map(items.map(item => [`${item.source}/${item.name}`, item]));
      const next = current.filter(item => !complete || incoming.has(`${item.source}/${item.name}`)).map(item => {
        const key = `${item.source}/${item.name}`, value = incoming.get(key) ?? item;
        incoming.delete(key); return value;
      });
      next.push(...incoming.values());
      if (catalogues.has(query) && JSON.stringify(current) === JSON.stringify(next)) return current;
      catalogues.set(query, next);
      if (catalogues.size > 8) catalogues.delete(catalogues.keys().next().value!);
      persist(); listeners.get(query)?.forEach(listener => listener(next));
      return next;
    };
    request = commands.searchToolSkills(query, items => { if (!complete) publish(items); }).then(items => { complete = true; return publish(items, true); }).finally(() => { complete = true; pending.delete(query); listeners.delete(query); });
    pending.set(query, request);
  }
  return request;
}
