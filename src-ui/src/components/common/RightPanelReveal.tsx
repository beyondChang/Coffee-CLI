// RightPanelReveal.tsx — the handle that opens / closes the right panel.
//
// The titlebar keeps only the left-panel and Gambit toggles; this slim handle
// pinned to the centre pane's top-right corner replaces the old right-panel
// toggle. It floats over the content edge, reads as "open" with a panel glyph
// and flips to a collapse chevron once the panel is on screen.

import { useAppState, useAppDispatch, schemeLabels } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './RightPanelReveal.css';

export function RightPanelReveal() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  const open = !state.rightPanelHidden;
  const label = `${t(open ? 'panel.close_right' : 'panel.open_right')} (${schemeLabels(state.hotkeyScheme).right})`;
  return (
    <button
      type="button"
      className={`right-panel-reveal${open ? ' is-open' : ''}`}
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
    >
      {open ? (
        // Chevron pointing at the panel: collapses it again.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" />
          <line x1="15" y1="4" x2="15" y2="20" />
        </svg>
      )}
    </button>
  );
}
