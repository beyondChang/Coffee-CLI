// FilesBoard.tsx — the workspace file tree, hosted by the right panel.
//
// It used to live in the left panel next to the session list, which squeezed
// both into one narrow column. The tree now owns a right-panel tab and reads
// the active session's folder, so terminal CWD changes still drive it.

import { useCallback, useEffect, useState } from 'react';
import { useAppState } from '../../store/app-state';
import type { ToolType } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';
import type { DirEntryInfo } from '../../tauri';
import { ScrollPanel } from '../common/ScrollPanel';
import { BrowserDirNode, BrowserFileNode, ContextMenu, type CtxMenuState } from '../left/Explorer';
import { loadExpanded, saveExpanded, normFolder } from '../../lib/file-panel-state';
import '../left/Explorer.css';
import './FilesBoard.css';

const normPath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// Stable empty set so "nothing expanded yet" does not allocate a new Set on
// every render (which would invalidate the memoised isExpanded callback).
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

// OpenClaw (persona forge), Hermes Agent and Remote Terminal are
// directory-agnostic: they never bind to a local project folder, so the tree
// has nothing to show for them.
const CWD_AGNOSTIC_TOOLS: ReadonlySet<ToolType> = new Set<ToolType>(['openclaw', 'hermes', 'remote']);


export function FilesBoard() {
  const { state } = useAppState();
  const t = useT();
  const activeSession = state.terminals.find(session => session.id === state.activeTerminalId);
  const folderPath = activeSession?.folderPath || null;
  // Launchpad (no tool yet) and directory-agnostic tools have no workspace.
  const noWorkspace = !activeSession?.tool || CWD_AGNOSTIC_TOOLS.has(activeSession.tool);

  const [query, setQuery] = useState<string | null>(null);
  const searching = query !== null;
  const filter = (query ?? '').trim().toLowerCase();

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const handleCtxMenu = useCallback((menu: CtxMenuState) => setCtxMenu(menu), []);
  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const [rootEntries, setRootEntries] = useState<DirEntryInfo[] | null>(null);

  // Per-project expanded folders. Loaded when the active folder changes and
  // persisted back on every toggle so switching projects (or restarting the
  // app) restores the same tree shape. Keyed by normalised path.
  const folderKey = folderPath ? normFolder(folderPath) : null;
  const [expandedMap, setExpandedMap] = useState<Record<string, Set<string>>>({});
  const expanded: ReadonlySet<string> = (folderKey && expandedMap[folderKey]) || EMPTY_SET;
  const isExpanded = useCallback((dirPath: string) => expanded.has(normFolder(dirPath)), [expanded]);
  const toggleExpanded = useCallback((dirPath: string, open: boolean) => {
    if (!folderKey) return;
    setExpandedMap(prev => {
      const current = new Set(prev[folderKey] ?? []);
      const norm = normFolder(dirPath);
      if (open) current.add(norm); else current.delete(norm);
      saveExpanded(folderKey, current);
      return { ...prev, [folderKey]: current };
    });
  }, [folderKey]);
  // Lazily load a project's saved set the first time it is shown.
  useEffect(() => {
    if (!folderKey || expandedMap[folderKey]) return;
    setExpandedMap(prev => (prev[folderKey] ? prev : { ...prev, [folderKey]: loadExpanded(folderKey) }));
  }, [folderKey, expandedMap]);
  useEffect(() => {
    setQuery(null);
    if (!folderPath) { setRootEntries(null); return; }
    let cancelled = false;
    let request = 0;
    const load = () => {
      const current = ++request;
      commands.listDirectory(folderPath)
        .then(entries => { if (!cancelled && current === request) setRootEntries(entries); })
        .catch(() => { if (!cancelled && current === request) setRootEntries([]); });
    };
    load();
    // Initial reads and refreshes share one sequence so an older response
    // cannot replace a newer directory listing after a tab switch or save.
    const target = normPath(folderPath);
    const handler = (event: Event) => {
      if (normPath((event as CustomEvent<{ dirPath: string }>).detail.dirPath) === target) load();
    };
    window.addEventListener('fs-refresh', handler);
    return () => { cancelled = true; window.removeEventListener('fs-refresh', handler); };
  }, [folderPath]);

  // OS-level fs watcher — register the Tauri listener BEFORE arming the
  // watcher so no event from an editor's save burst is dropped in the gap.
  useEffect(() => {
    if (!folderPath || noWorkspace) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        if (cancelled) return;
        const handle = await listen<{ dirPath: string }>('fs-refresh', event => {
          window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath: event.payload.dirPath } }));
        });
        if (cancelled) { handle(); return; }
        unlisten = handle;
        await commands.startFsWatcher(folderPath);
      } catch (err) {
        console.warn('[Files] fs watcher setup failed:', err);
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      commands.stopFsWatcher().catch(() => {});
    };
  }, [folderPath, noWorkspace]);

  const entries = rootEntries?.slice().sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name);
  }) ?? [];

  if (noWorkspace) {
    return (
      <div className="right-files-host">
        <div className="empty-state right-files-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div
      className="right-files-host"
      // Right-clicking blank space offers creating entries in the browsed root.
      onContextMenu={event => {
        if (!folderPath) return;
        event.preventDefault();
        setCtxMenu({ x: event.clientX, y: event.clientY, absolutePath: folderPath.replace(/\\/g, '/'), relativePath: '', isDir: true, blank: true });
      }}
    >
      <div className="right-files-head">
        <span className={`right-files-path${searching ? ' is-searching' : ''}`}>
          {searching ? (
            <input
              className="right-files-filter"
              role="searchbox"
              autoFocus
              aria-label={t('explorer.filter_files')}
              placeholder={t('explorer.filter_files')}
              value={query ?? ''}
              onChange={event => setQuery(event.target.value)}
              onBlur={() => { if (!query?.trim()) setQuery(null); }}
              onKeyDown={event => {
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setQuery(null); }
              }}
            />
          ) : (
            <span className="right-files-path-text" title={folderPath ?? ''}>{folderPath ?? '—'}</span>
          )}
          <button
            type="button"
            className="right-files-filter-toggle"
            aria-label={t(searching ? 'history.close_search' : 'explorer.filter_files')}
            aria-pressed={searching}
            onMouseDown={event => event.preventDefault()}
            onClick={() => setQuery(searching ? null : '')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {searching ? <path d="m6 6 12 12M6 18 18 6" /> : <><circle cx="10.5" cy="10.5" r="7.5" /><path d="m16 16 5 5" /></>}
            </svg>
          </button>
        </span>
      </div>

      {!folderPath ? (
        <div className="empty-state right-files-empty">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </div>
      ) : rootEntries === null ? (
        <ScrollPanel>
          <div className="file-tree-container right-files-tree" style={{ pointerEvents: 'none' }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', opacity: Math.max(0.1, 1 - i * 0.08) }}>
                <div className="shimmer-box" style={{ width: 14, height: 14, borderRadius: 'var(--radius-xs)', flexShrink: 0 }} />
                <div className="shimmer-box" style={{ width: `${30 + (i * 7) % 40}%`, height: 12, borderRadius: 'var(--radius-xs)' }} />
              </div>
            ))}
          </div>
        </ScrollPanel>
      ) : (
        <ScrollPanel>
          <div className="file-tree-container right-files-tree">
            {filter && !entries.some(entry => entry.name.toLowerCase().includes(filter)) && <div className="workspace-filter-empty" role="status">{t('explorer.no_matches')}</div>}
            {entries.map(entry => (
              <div key={entry.path} hidden={!!filter && !entry.name.toLowerCase().includes(filter)}>
                {entry.is_dir ? (
                  <BrowserDirNode name={entry.name} dirPath={entry.path} onCtxMenu={handleCtxMenu} isExpanded={isExpanded} onToggle={toggleExpanded} />
                ) : (
                  <BrowserFileNode entry={entry} parentDirPath={folderPath} onCtxMenu={handleCtxMenu} />
                )}
              </div>
            ))}
          </div>
        </ScrollPanel>
      )}

      {ctxMenu && <ContextMenu menu={ctxMenu} onClose={closeCtxMenu} />}
    </div>
  );
}
