// RightPanel.tsx — Persistent task board and workspace files.
// .compiler-top wrapper styling lives in global.css (same selector,
// kept around because changing the wrapper class would touch every
// theme rule that scopes to it).

import { useId } from 'react';
import { useAppState } from '../../store/app-state';
import { useT } from '../../i18n/useT';
import { FilesBoard } from './FilesBoard';
import { TaskBoard } from './TaskBoard';
import './RightPanel.css';

export function RightPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const tabId = useId();
  const view = state.rightView;
  const tabs = [{ key: 'tasks', label: t('task.tab.tasks') }, { key: 'files', label: t('task.tab.files') }] as const;
  return (
    <div className="compiler-top changes-board right-panel-workbench">
      <div className="changes-title" role="tablist" aria-label={t('right.panel.label')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const enabled = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
        const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) % enabled.length;
        event.preventDefault(); enabled[next]?.focus(); enabled[next]?.click();
      }}>
        {tabs.map(tab => <button type="button" role="tab" key={tab.key} id={`${tabId}-${tab.key}-tab`} aria-controls={`${tabId}-${tab.key}`} aria-selected={view === tab.key} tabIndex={view === tab.key ? 0 : -1} onClick={() => dispatch({ type: 'SET_RIGHT_VIEW', view: tab.key })}><span className="right-tab-label">{tab.label}</span></button>)}
      </div>
      <div className="right-task-host" id={`${tabId}-tasks`} role="tabpanel" aria-labelledby={`${tabId}-tasks-tab`} hidden={view !== 'tasks'}><TaskBoard /></div>
      <div className="right-files-host" id={`${tabId}-files`} role="tabpanel" aria-labelledby={`${tabId}-files-tab`} hidden={view !== 'files'}><FilesBoard /></div>
    </div>
  );
}
