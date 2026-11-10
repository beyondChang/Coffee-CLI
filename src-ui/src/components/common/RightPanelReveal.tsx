// RightPanelReveal.tsx — hover strip that reopens the right panel.
//
// The titlebar keeps only the left-panel and Gambit toggles; the right panel
// is reopened from a slim handle pinned to the top-right corner of the centre
// pane. It stays invisible until the pointer (or keyboard focus) reaches the
// corner, so it never competes with the content underneath.

import { useAppState, useAppDispatch } from '../../store/app-state';
import { schemeLabels } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import './RightPanelReveal.css';

export function RightPanelReveal() {
  const { state } = useAppState();
  const dispatch = useAppDispatch();
  const t = useT();
  // Only an affordance to OPEN the panel: once it is on screen the panel's own
  // chrome (and the hotkey) close it again.
  if (!state.rightPanelHidden) return null;
  return (
    <button
      type="button"
      className="right-panel-reveal"
      aria-label={`${t('panel.open_right')} (${schemeLabels(state.hotkeyScheme).right})`}
      title={`${t('panel.open_right')} (${schemeLabels(state.hotkeyScheme).right})`}
      onClick={() => dispatch({ type: 'TOGGLE_RIGHT_PANEL' })}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" />
        <line x1="15" y1="4" x2="15" y2="20" />
      </svg>
    </button>
  );
}
