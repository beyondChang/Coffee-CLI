// PanelEdgeHandle.tsx — the open/close handles for the side panels.
//
// The titlebar keeps only the Gambit toggle; each side panel is opened and
// closed from a slim handle pinned to the matching top corner of the centre
// pane. The two are mirror images: a chevron pointing into the screen pulls
// the panel in, and the same handle flips outward to collapse it again.

import { useEffect } from 'react';
import { useAppState, useAppDispatch, schemeLabels } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './PanelEdgeHandle.css';

export function PanelEdgeHandle({ side }: { side: 'left' | 'right' }) {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const open = side === 'left' ? !state.leftPanelHidden : !state.rightPanelHidden;
  const label = `${t(open ? `panel.close_${side}` : `panel.open_${side}`)} (${schemeLabels(state.hotkeyScheme)[side]})`;
  // The floating scroll rail shares this edge; hide it the moment the pointer
  // reaches the handle so the two never flicker against each other.
  const hideScrollbar = (hide: boolean) => document.body.classList.toggle('cc-scrollbar-muted', hide);
  useEffect(() => () => document.body.classList.remove('cc-scrollbar-muted'), []);

  return (
    <button
      type="button"
      className={`panel-edge-handle is-${side}${open ? ' is-open' : ''}`}
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={() => dispatch({ type: side === 'left' ? 'TOGGLE_LEFT_PANEL' : 'TOGGLE_RIGHT_PANEL' })}
      onPointerEnter={() => hideScrollbar(true)}
      onPointerLeave={() => hideScrollbar(false)}
      onFocus={() => hideScrollbar(true)}
      onBlur={() => hideScrollbar(false)}
    >
      {open ? (
        // Pointing back out of the screen: collapses the panel.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={side === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
        </svg>
      ) : (
        // Pointing into the screen: pulls the panel in from that edge.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={side === 'left' ? 'm9 6 6 6-6 6' : 'm15 6-6 6 6 6'} />
        </svg>
      )}
    </button>
  );
}
