import { ChannelConnectionSummary } from '../agent/AgentPages';
// Explorer.tsx — Left panel: file tree synced from terminal CWD

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useAppState } from '../../store/app-state';
import type { IconTheme } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { isMaskTintTheme } from '../../lib/personalization';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { clipboardWrite } from '../../lib/clipboard';
import { beginExplorerDrag } from '../../lib/explorer-drag';
import { consumePendingRename, onPendingRename, requestRename } from '../../lib/pending-rename';
import { getFileIconSrc } from '../../lib/file-icons';
import { useFileStats, useDirtyDirs } from '../../lib/git-status';
import { commands, onSelfUpdateProgress } from '../../tauri';
import { IS_WINDOWS } from '../../lib/platform';
import type { DirEntryInfo } from '../../tauri';
import { HistoryBoard } from '../right/HistoryBoard';
import './Explorer.css';
import { fetchLatestManifest, isNewerVersion } from '../../lib/update-manifest';


// Snapshot lifecycle and the `+N -M` map live in lib/git-status.tsx so every
// tree consumer (the right panel's file tree) shares one poll. Explorer is a
// pure consumer.
const normPath = (p: string) => p.replace(/\\/g, '/');

// ─── Context Menu ────────────────────────────────────────────────────────────

export interface CtxMenuState {
  x: number;
  y: number;
  absolutePath: string;
  relativePath: string;
  isDir?: boolean;
  onRename?: () => void;
  // Read-only callers (diff or preview surfaces) pass compact — the audit
  // view shouldn't mutate the agent's just-edited files. Hides
  // cut/copy/paste/rename/delete + the relative-path entry.
  compact?: boolean;
  // Right-clicked empty space in the tree: only offer creating entries in
  // `absolutePath` (the root being browsed).
  blank?: boolean;
}

// Module-level clipboard: survives menu close/open cycles
let fsClipboard: { action: 'copy' | 'cut'; path: string } | null = null;

// Dispatch a custom event to refresh any BrowserDirNode that owns that directory
function dispatchFsRefresh(dirPath: string) {
  window.dispatchEvent(new CustomEvent('fs-refresh', { detail: { dirPath } }));
}

export function ContextMenu({ menu, onClose }: { menu: CtxMenuState; onClose: () => void }) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const closeKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', closeKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', closeKey);
    };
  }, [onClose]);

  const copyPath = (text: string) => {
    clipboardWrite(text);
    onClose();
  };

  const handleCut = () => {
    fsClipboard = { action: 'cut', path: menu.absolutePath };
    onClose();
  };

  const handleCopy = () => {
    fsClipboard = { action: 'copy', path: menu.absolutePath };
    onClose();
  };

  const handlePaste = async () => {
    if (!fsClipboard) return;
    const targetDir = menu.isDir ? menu.absolutePath : menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
    const sourcePath = fsClipboard.path;
    const action = fsClipboard.action;
    try {
      await commands.fsPaste(action, sourcePath, targetDir);
      
      // Refresh the destination directory where we just pasted
      dispatchFsRefresh(targetDir);
      
      // If we cut a file, the original source location also needs a refresh to show the file is gone!
      if (action === 'cut') {
        const sourceDir = sourcePath.replace(/[\\/][^\\/]+$/, '');
        dispatchFsRefresh(sourceDir);
        fsClipboard = null;
      }
    } catch (e) {
      console.error('[Explorer] paste failed:', e);
    }
    onClose();
  };

  const handleDelete = async () => {
    onClose();
    try {
      await commands.fsDelete(menu.absolutePath);
      const parentDir = menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
      dispatchFsRefresh(parentDir);
    } catch (e) {
      console.error('[Explorer] delete failed:', e);
    }
  };

  const handleRename = () => {
    onClose();
    menu.onRename?.();
  };

  /** Create an empty file / folder in the clicked directory (or the tree root
   *  when the click landed on blank space), picking a free default name. */
  const handleCreate = async (directory: boolean) => {
    const dir = menu.isDir || menu.blank ? menu.absolutePath : menu.absolutePath.replace(/[\\/][^\\/]+$/, '');
    const base = directory ? t('menu.new_folder_name') : 'untitled.txt';
    for (let attempt = 1; attempt <= 50; attempt++) {
      const suffix = attempt === 1 ? '' : `-${attempt}`;
      const name = base.replace(/(\.[^.]+)?$/, match => suffix + match);
      try {
        await commands.fsCreate(`${dir}/${name}`, directory);
        // The row for the new entry mounts after the refresh, so park the
        // rename request first — it opens its own input when it appears.
        requestRename(`${dir}/${name}`);
        dispatchFsRefresh(dir);
        onClose();
        return;
      } catch (e) {
        if (attempt === 50) console.error('[Explorer] create failed:', e);
      }
    }
    onClose();
  };

  const handleShowInFolder = async () => {
    onClose();
    try {
      await commands.showInFolder(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] show in folder failed:', e);
    }
  };

  // The context menu keeps the OS default opener alongside in-app preview.
  const handleOpen = async () => {
    onClose();
    try {
      await commands.openUrl(menu.absolutePath);
    } catch (e) {
      console.error('[Explorer] open failed:', e);
    }
  };

  const canPaste = !!fsClipboard;

  // Smart menu positioning to prevent off-screen clipping
  const MENU_WIDTH = 220;
  const MENU_HEIGHT = 320; // Safe upper bound for full ctx menu

  const isBottomOverflow = menu.y + MENU_HEIGHT > window.innerHeight;
  const isRightOverflow = menu.x + MENU_WIDTH > window.innerWidth;

  const style: React.CSSProperties = {
    position: 'fixed',
    ...(isBottomOverflow 
         ? { bottom: Math.max(0, window.innerHeight - menu.y) } 
         : { top: menu.y }),
    ...(isRightOverflow 
         ? { right: Math.max(0, window.innerWidth - menu.x) } 
         : { left: menu.x })
  };

  const createItems = (
    <>
      <button className="ctx-menu-item" onClick={() => handleCreate(false)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="12" x2="12" y2="18"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        {t('menu.new_file')}
      </button>
      <button className="ctx-menu-item" onClick={() => handleCreate(true)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          <line x1="12" y1="11" x2="12" y2="17"/>
          <line x1="9" y1="14" x2="15" y2="14"/>
        </svg>
        {t('menu.new_folder')}
      </button>
    </>
  );

  if (menu.blank) {
    return createPortal(
      <div className="ctx-menu" ref={menuRef} style={style} role="menu">
        {createItems}
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={style}>
      {/* Creating entries comes first: it is the action people reach for when
          they right-click a folder. */}
      {menu.isDir && !menu.compact && <>{createItems}<div className="ctx-menu-divider" /></>}
      {/* Primary action: open in OS default — most-used, sits at the top */}
      <button className="ctx-menu-item" onClick={handleOpen}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 3h6v6"/>
          <path d="M10 14 21 3"/>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        </svg>
        {t('menu.open')}
      </button>
      <div className="ctx-menu-divider" />
      {/* Path copy group */}
      <button className="ctx-menu-item" onClick={() => copyPath(menu.absolutePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        {t('menu.copy_abs')}
      </button>
      <button className="ctx-menu-item" onClick={() => copyPath(menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {t('menu.copy_rel')}
      </button>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item ctx-menu-hint" onClick={() => copyPath('@' + menu.relativePath)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4"/>
          <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>
        </svg>
        {t('menu.copy_ref')}
      </button>

      {/* File operation group — hidden in compact mode (read-only audit view) */}
      {!menu.compact && <>
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleCut}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="20" r="2"/><circle cx="18" cy="20" r="2"/>
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>
        </svg>
        {t('menu.cut')}
      </button>
      <button className="ctx-menu-item" onClick={handleCopy}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
        </svg>
        {t('menu.copy')}
      </button>
      {canPaste && (
        <button className="ctx-menu-item" onClick={handlePaste}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1"/>
          </svg>
          {t('menu.paste')}
        </button>
      )}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleRename}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>
        </svg>
        {t('menu.rename')}
      </button>
      <button className="ctx-menu-item" onClick={handleDelete}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6"/>
          <path d="m19 6-.867 13.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 6"/>
          <path d="M10 11v6"/><path d="M14 11v6"/>
          <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
        </svg>
        {t('menu.delete')}
      </button>
      </>}
      <div className="ctx-menu-divider" />
      <button className="ctx-menu-item" onClick={handleShowInFolder}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m19 20-3-3m0 0a4 4 0 1 0-5.656-5.656A4 4 0 0 0 16 17z"/>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
        {t('menu.show_in_folder')}
      </button>
    </div>,
    document.body
  );
}

function formatBytes(b: number) {
  return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
}

// ─── Icon Themes ──────────────────────────────────────────────────────────────
// Every theme ships a complete 19-SVG set under /icons/themes/<id>/.
// No root-level fallback: adding a theme = dropping a new folder + listing it
// in ICON_ART_THEMES. Non-theme UI assets (CLI tool logos, terminal icons,
// etc.) live under /icons/tools/ and are unrelated to this subsystem.

function getIconPath(theme: IconTheme, name: string): string {
  return `/icons/themes/${theme}/${name}`;
}

/** Renders a theme icon. For mask-tint themes, uses a <span> with mask-image
 *  so `background-color: var(--accent)` paints the silhouette. For color
 *  themes, falls back to a plain <img>. */
export function ThemedIcon({ src, alt, onFallback }: {
  src: string;
  alt: string;
  onFallback?: string;
}) {
  const { state: { iconTheme } } = useAppState();
  if (isMaskTintTheme(iconTheme)) {
    return (
      <span
        className="icon-svg icon-svg-mask"
        role="img"
        aria-label={alt}
        style={{ WebkitMaskImage: `url("${src}")`, maskImage: `url("${src}")` }}
      />
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      className="icon-svg"
      onError={onFallback ? (e) => (e.currentTarget.src = onFallback) : undefined}
    />
  );
}



// ─── Lazy Directory Browser Node ─────────────────────────────────────────────

/** A single expandable directory node for the "My Computer" tab.
 *  Loads children lazily from the backend on first expand. */
export function BrowserDirNode({ name, dirPath, icon, onCtxMenu }: { name: string; dirPath: string; icon?: string; onCtxMenu: (menu: CtxMenuState) => void }) {
  const { state: { iconTheme } } = useAppState();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntryInfo[] | null>(null);
  const [loading, setLoading] = useState(false);

  // True when any descendant file has uncommitted changes. Used to tint the
  // folder name as a "trail" leading to the change — folded folders still
  // signal that something inside is modified, so users don't have to expand
  // the whole tree to find the +/- badge. Icon stays untouched (icon themes
  // own their own coloring; tinting the icon would fight Material/Seti).
  // O(1) check against the precomputed dirty-dirs set (was an O(open-folders ×
  // changes) scan of the whole change list on every poll — a main-thread cost).
  const dirtyDirs = useDirtyDirs();
  const hasDirtyDescendant = useMemo(
    () => dirtyDirs.has(normPath(dirPath).replace(/\/+$/, '')),
    [dirtyDirs, dirPath],
  );

  const toggle = async () => {
    if (!open && children === null) {
      setLoading(true);
      try {
        const entries = await commands.listDirectory(dirPath);
        setChildren(entries);
      } catch (e) {
        console.warn('[Explorer] list_directory failed:', e);
        setChildren([]);
      }
      setLoading(false);
    }
    setOpen(!open);
  };

  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Listen for fs-refresh events targeting our own directory
  useEffect(() => {
    const handler = (e: Event) => {
      const ev = e as CustomEvent<{ dirPath: string }>;
      const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
      if (norm(ev.detail.dirPath) === norm(dirPath)) {
        if (open) {
          commands.listDirectory(dirPath).then(setChildren).catch(() => setChildren([]));
        } else {
          setChildren(null);
        }
      }
    };
    window.addEventListener('fs-refresh', handler);
    return () => window.removeEventListener('fs-refresh', handler);
  }, [dirPath, open]);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);
  useEffect(() => {
    // Deferred a frame so the new row is laid out before its input mounts.
    let cancelled = false;
    const check = () => { if (!cancelled && consumePendingRename(dirPath)) setRenaming(true); };
    const frame = window.requestAnimationFrame(check);
    const off = onPendingRename(check);
    return () => { cancelled = true; window.cancelAnimationFrame(frame); off(); };
  }, [dirPath]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== name) {
      const absPath = dirPath.replace(/\\/g, '/');
      try {
        await commands.fsRename(absPath, renameVal.trim());
        // Notify parent directory to refresh
        const parentDir = absPath.replace(/\/[^/]+$/, '');
        dispatchFsRefresh(parentDir);
      } catch (e) { console.error('[Explorer] rename failed:', e); }
    }
    setRenaming(false);
  };

  const handleDirCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: dirPath.replace(/\\/g, '/'),
      relativePath: dirPath.replace(/\\/g, '/'),
      isDir: true,
      onRename: () => setRenaming(true),
    });
  };

  // Pointer-based drag (HTML5 drag is captured by Tauri's WebView2 drop
  // handler on Windows — see explorer-drag.ts). Threshold-gated so a plain
  // click toggles open/close without a phantom drop.
  const onDirMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(dirPath, e);
  };

  return (
    <div className="tree-dir">
      <div
        className={`tree-dir-header ${renaming ? 'renaming' : ''}${hasDirtyDescendant ? ' has-dirty' : ''}`}
        onClick={() => !renaming && toggle()}
        onContextMenu={handleDirCtxMenu}
        onMouseDown={onDirMouseDown}
      >
        <span className={`tree-arrow ${open ? '' : 'closed'}`}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
        <span className="tree-icon">
          <ThemedIcon src={icon || getIconPath(iconTheme, open ? 'folder-open.svg' : 'folder-closed.svg')} alt="dir" />
        </span>
        <span className="tree-name" style={{ display: renaming ? 'none' : undefined }}>{name}</span>
        <input
          ref={renameInputRef}
          className="tree-rename-input"
          style={{ display: renaming ? undefined : 'none' }}
          value={renameVal}
          onChange={e => setRenameVal(e.target.value)}
          onBlur={commitRename}
          onKeyDown={e => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onClick={e => e.stopPropagation()}
        />
      </div>
      {open && (
        <div className="tree-children">
          {loading ? (
            <div style={{ padding: '6px 8px', color: 'var(--text-3)', fontSize: 12 }}>Loading...</div>
          ) : children && children.length === 0 ? (
            <div style={{ padding: '6px 8px', color: 'var(--text-3)', fontSize: 12, opacity: 0.5 }}>(empty)</div>
          ) : children?.slice().sort((a, b) => {
            if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            return a.name.localeCompare(b.name);
          }).map(entry => (
            entry.is_dir ? (
              <BrowserDirNode key={entry.path} name={entry.name} dirPath={entry.path} onCtxMenu={onCtxMenu} />
            ) : (
              <BrowserFileNode key={entry.path} entry={entry} parentDirPath={dirPath} onCtxMenu={onCtxMenu} />
            )
          ))}
        </div>
      )}
    </div>
  );
}

/** A leaf file node inside the My Computer tree with inline rename support. */
export function BrowserFileNode({ entry, parentDirPath, onCtxMenu }: {
  entry: DirEntryInfo;
  parentDirPath: string;
  onCtxMenu: (menu: CtxMenuState) => void;
}) {
  const { state: { iconTheme }, dispatch } = useAppState();
  const fileStats = useFileStats();
  const stats = fileStats?.get(normPath(entry.path));
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState(entry.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (renaming) renameInputRef.current?.select(); }, [renaming]);
  useEffect(() => {
    // Deferred a frame so the new row is laid out before its input mounts.
    let cancelled = false;
    const check = () => { if (!cancelled && consumePendingRename(entry.path)) setRenaming(true); };
    const frame = window.requestAnimationFrame(check);
    const off = onPendingRename(check);
    return () => { cancelled = true; window.cancelAnimationFrame(frame); off(); };
  }, [entry.path]);

  const commitRename = async () => {
    if (renameVal.trim() && renameVal !== entry.name) {
      try {
        await commands.fsRename(entry.path, renameVal.trim());
        const parentNorm = parentDirPath.replace(/\\/g, '/');
        dispatchFsRefresh(parentNorm);
      } catch (e) { console.error('[Explorer] rename failed:', e); }
    }
    setRenaming(false);
  };

  const handleCtxMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onCtxMenu({
      x: e.clientX,
      y: e.clientY,
      absolutePath: entry.path.replace(/\\/g, '/'),
      relativePath: entry.path.replace(/\\/g, '/'),
      isDir: false,
      onRename: () => setRenaming(true),
    });
  };

  const onFileMouseDown = (e: React.MouseEvent) => {
    if (renaming) return;
    beginExplorerDrag(entry.path, e);
  };

  return (
    <div
      className={`tree-file ${renaming ? 'renaming' : ''}`}
      onClick={() => {
        if (renaming) return;
        dispatch({ type: 'OPEN_FILE', file: { path: entry.path, name: entry.name, folderPath: parentDirPath } });
      }}
      onContextMenu={handleCtxMenu}
      onMouseDown={onFileMouseDown}
    >
      <span className="tree-icon">
        <ThemedIcon
          src={getFileIconSrc(entry.name.split('.').pop() || '', iconTheme)}
          alt="file"
          onFallback={getIconPath(iconTheme, 'file.svg')}
        />
      </span>
      <span className="tree-fname" style={{ display: renaming ? 'none' : undefined }}>{entry.name}</span>
      <input
        ref={renameInputRef}
        className="tree-rename-input"
        style={{ display: renaming ? undefined : 'none' }}
        value={renameVal}
        onChange={e => setRenameVal(e.target.value)}
        onBlur={commitRename}
        onKeyDown={e => {
          if (e.key === 'Enter') commitRename();
          if (e.key === 'Escape') setRenaming(false);
        }}
        onClick={e => e.stopPropagation()}
      />
      {stats ? (
        <span className="tree-badge tree-badge-diff">
          <span className="diff-add">+{stats.added}</span>
          <span className="diff-del">-{stats.deleted}</span>
        </span>
      ) : (
        <span className="tree-badge">{formatBytes(entry.size)}</span>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function Explorer() {
  const { state, dispatch } = useAppState();
  const t = useT();

  // Update check
  const [hasUpdate, setHasUpdate] = useState(false);
  // The brand (title + the self-update button) renders here but DISPLAYS
  // in the titlebar's left slot via portal — so it keeps all its Explorer-local
  // self-update state untouched, and hides together with the left panel (this
  // component unmounts when the panel is hidden, which is exactly what we want:
  // no need to relocate the brand to the centre). Slot resolves after mount.
  const [brandSlot, setBrandSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setBrandSlot(document.getElementById('titlebar-brand-slot')); }, []);
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        // Domestic mirrors and the website are asked together; the newest
        // version any of them reports wins (see lib/update-manifest.ts).
        const [local, remote] = await Promise.all([getVersion(), fetchLatestManifest()]);
        if (remote && isNewerVersion(remote.version, local)) setHasUpdate(true);
      } catch { /* offline or fetch failed — silent */ }
    };
    checkUpdate();
  }, []);

  // In-app self-update. Click the logo's update icon → a circular ring fills
  // as the installer downloads into the Downloads folder. Windows then runs
  // the wizard and the app exits; macOS opens the DMG and Linux opens the
  // folder, and the app keeps running. On failure fall back to the page.
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installPhase, setInstallPhase] = useState<
    'speed_test' | 'downloading' | 'launching' | 'downloaded' | 'error' | null
  >(null);
  const handleSelfUpdate = useCallback(async () => {
    if (installing) return;
    setInstalling(true);
    setInstallPhase('speed_test');
    setInstallPct(0);
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onSelfUpdateProgress((p) => {
        setInstallPhase(p.status);
        setInstallPct(p.percent);
      });
      await commands.downloadAndInstallUpdate();
      // Windows: the installer launched and the app is about to exit, so
      // leave the ring until the window goes away. macOS / Linux keep
      // running with the DMG or Downloads folder open: reset the button.
      if (!IS_WINDOWS) {
        setInstalling(false);
        setInstallPhase(null);
        setInstallPct(0);
      }
    } catch {
      commands.openUrl('https://coffeecli.com');
      setInstalling(false);
      setInstallPhase(null);
      setInstallPct(0);
    } finally {
      unlisten?.();
    }
  }, [installing]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollRef.current) return;
    return bindAutoHideScrollbar(scrollRef.current);
  }, []);

  // The update download sits in the sidebar's bottom row, left of settings, where most desktop apps keep it.
  const updateButton = hasUpdate ? (
    <button
      className={`agent-sidebar-button update-check-btn update-available${installing ? ' is-installing' : ''}`}
      onClick={handleSelfUpdate}
      disabled={installing}
      aria-label="Update Coffee CLI"
    >
      {installing ? (
        <svg
          className={`update-ring${installPhase === 'speed_test' ? ' spin' : ''}`}
          width="15"
          height="15"
          viewBox="0 0 24 24"
        >
          <circle className="update-ring-track" cx="12" cy="12" r="9" fill="none" strokeWidth="2.6" />
          <circle
            className="update-ring-progress"
            cx="12"
            cy="12"
            r="9"
            fill="none"
            strokeWidth="2.6"
            strokeLinecap="round"
            transform="rotate(-90 12 12)"
            strokeDasharray={
              installPhase === 'speed_test'
                ? `${2 * Math.PI * 9 * 0.25} ${2 * Math.PI * 9}`
                : 2 * Math.PI * 9
            }
            strokeDashoffset={
              installPhase === 'speed_test'
                ? 0
                : 2 * Math.PI * 9 * (1 - installPct / 100)
            }
          />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
      )}
    </button>
  ) : null;

  return (
    <div className="panel panel-left explorer-panel" data-icon-theme={state.iconTheme}>
      {/* Brand + theme/lang controls */}
      {brandSlot && createPortal(
        <div className="brand">
          <span>{t('app.title')}</span>
        </div>
        
        ,
        brandSlot
      )}

      {/* Sessions scroll as one sheet with the actions above them. The
          workspace tree lives in the right panel (FilesBoard) so both lists
          keep a readable width instead of sharing one narrow column. */}
      <div className="explorer-scroll" data-tab="history" ref={scrollRef}>
      <div className="explorer-tabs">
        <button className="explorer-new-session" onClick={() => window.dispatchEvent(new Event('coffee-new-session'))}>
          {/* Lucide square-pen; license in /icons/LICENSE-lucide.txt. */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" /></svg>
          <span>{t('explorer.new_session')}</span>
        </button>
      </div>

      <button type="button" className="explorer-new-session explorer-usage" aria-pressed={!!state.toolSettingsOpen} onClick={() => dispatch({ type: 'SET_TOOL_SETTINGS_OPEN', open: true })}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M14 17.5h7M17.5 14v7" /></svg><span>{t('tools.title')}</span>
      </button>
      <button type="button" className="explorer-new-session explorer-usage" aria-pressed={!!state.usageOpen} onClick={() => dispatch({ type: 'SET_USAGE_OPEN', open: true })}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 3v18h18M8 16v-5M13 16V5M18 16V9" /></svg><span>{t('usage.title')}</span>
      </button>
      <button type="button" className="explorer-new-session explorer-usage" aria-pressed={!!state.automationsOpen} onClick={() => dispatch({ type: 'SET_AUTOMATIONS_OPEN', open: true })}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M5 3 2 6" /><path d="m22 6-3-3" /></svg><span>{t('automation.title')}</span>
      </button>
      {/* Fixed header for the history list: HistoryBoard portals its search +
          layout rows here so they can never scroll or overlap the sessions. */}
      <div className="explorer-head-slot" id="explorer-head-slot" />

      {/* Session list content */}
      <div className="panel-content explorer-content">
        {/* HistoryBoard returns a fragment and was originally hosted inside
            .task-board which provided the 16px gutter. In Explorer's flex
            shell that padding doesn't exist, so we wrap to restore it. */}
        <div className="explorer-history-host"><HistoryBoard /></div>
      </div>
      </div>

      <ChannelConnectionSummary update={updateButton} />

      {/* Theme + language pickers now live in the titlebar-gear SettingsModal
          (App-level), not here. */}
    </div>
  );
}
