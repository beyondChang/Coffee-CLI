// RightPanelReveal.tsx — the handle that opens / closes the right panel.
//
// The titlebar keeps only the left-panel and Gambit toggles; this slim handle
// pinned to the centre pane's top-right corner replaces the old right-panel
// toggle. A left chevron pulls the panel in; once it is open the same handle
// points right and closes it again.

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
        // Left chevron: pulls the panel in from the right edge.
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m15 6-6 6 6 6" />
        </svg>
      )}
    </button>
  );
}
