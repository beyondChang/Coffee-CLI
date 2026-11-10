// FileTabContextMenu.tsx — right-click menu for the centre file tabs.
//
// Reuses the workspace-tree menu's `.ctx-menu` classes (Explorer.css) so it
// inherits the theme, glass/carbon overrides and dismiss behaviour. Scope is
// deliberately narrow: close this / left / right / all.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../../i18n/useT';
import { commands } from '../../tauri';

export interface FileTabMenuState {
  path: string;
  x: number;
  y: number;
}

export function FileTabContextMenu({ menu, canCloseLeft, canCloseRight, onCloseCurrent, onCloseLeft, onCloseRight, onCloseAll, onClose }: {
  menu: FileTabMenuState;
  canCloseLeft: boolean;
  canCloseRight: boolean;
  onCloseCurrent: () => void;
  onCloseLeft: () => void;
  onCloseRight: () => void;
  onCloseAll: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  const MENU_WIDTH = 180;
  const MENU_HEIGHT = 210;
  const style: React.CSSProperties = {
    position: 'fixed',
    ...(menu.y + MENU_HEIGHT > window.innerHeight ? { bottom: Math.max(0, window.innerHeight - menu.y) } : { top: menu.y }),
    ...(menu.x + MENU_WIDTH > window.innerWidth ? { right: Math.max(0, window.innerWidth - menu.x) } : { left: menu.x }),
  };

  const item = (label: string, enabled: boolean, run: () => void) => (
    <button className="ctx-menu-item" disabled={!enabled} style={enabled ? undefined : { opacity: 0.45 }} onClick={() => { onClose(); run(); }}>{label}</button>
  );

  return createPortal(
    <div className="ctx-menu" ref={menuRef} style={style} role="menu">
      {item(t('filetab.close_right'), canCloseRight, onCloseRight)}
      {item(t('filetab.close_left'), canCloseLeft, onCloseLeft)}
      {item(t('filetab.close_current'), true, onCloseCurrent)}
      <div className="ctx-menu-divider" />
      {item(t('filetab.close_all'), true, onCloseAll)}
      <div className="ctx-menu-divider" />
      {item(t('filetab.open_folder'), true, () => {
        void commands.showInFolder(menu.path).catch(error => console.warn('[Tabs] open folder failed:', error));
      })}
    </div>,
    document.body,
  );
}
