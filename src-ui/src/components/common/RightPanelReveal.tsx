// RightPanelReveal.tsx — the handle that opens / closes the right panel.
//
// The titlebar keeps only the left-panel and Gambit toggles; this slim handle
// pinned to the centre pane's top-right corner replaces the old right-panel
// toggle. A left chevron pulls the panel in; once it is open the same handle
// points right and closes it again.

import { useEffect } from 'react';
import { useAppState, useAppDispatch, schemeLabels } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './RightPanelReveal.css';

export function RightPanelReveal() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const open = !state.rightPanelHidden;
  // The floating scroll rail sits on the same edge; hide it the moment the
  // pointer reaches this handle so the two never flicker against each other.
  const hideScrollbar = (hide: boolean) => document.body.classList.toggle('cc-scrollbar-muted', hide);
  useEffect(() => () => document.body.classList.remove('cc-scrollbar-muted'), []);
  const label = `${t(open ? 'panel.close_right' : 'panel.open_right')} (${schemeLabels(state.hotkeyScheme).right})`;
  return (
    <button
      type="button"
      className={`right-panel-reveal${open ? ' is-open' : ''}`}
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
      onPointerEnter={() => hideScrollbar(true)}
      onPointerLeave={() => hideScrollbar(false)}
      onFocus={() => hideScrollbar(true)}
      onBlur={() => hideScrollbar(false)}
    >
      {open ? (
        // Chevron pointing at the panel: collapses it again.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      ) : (
        // Left chevron: pulls the panel in from the right edge.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 6-6 6 6 6" />
        </svg>
      )}
    </button>
  );
}
