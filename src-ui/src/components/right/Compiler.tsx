// RightPanel.tsx — Persistent task board, workspace files and review surfaces.
// .compiler-top wrapper styling lives in global.css (same selector,
// kept around because changing the wrapper class would touch every
// theme rule that scopes to it).

import { useId, useState } from 'react';
import { useAppState, resolveDiffContext, type DiffSelection } from '../../store/app-state';
import { useGitStatus } from '../../lib/git-status';
import { useT } from '../../i18n/useT';
import { ChangesBoard } from './ChangesBoard';
import { FilesBoard } from './FilesBoard';
import { TaskBoard } from './TaskBoard';

type RightView = 'tasks' | 'changes' | 'detail' | 'files';

export function RightPanel() {
  const { state, dispatch } = useAppState();
  const t = useT();
  const tabId = useId();
  const changes = useGitStatus();
  const [taskCount, setTaskCount] = useState(0);
  const selection = state.diffSelection;
  // The three stored tabs live in app state so the left sidebar can open the
  // files tab directly. 'detail' is not stored: it is pinned by clicking the
  // 文件对比 tab, or revealed automatically when a new file is selected.
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState<{ selection: DiffSelection | null; mode: 'overlay' | 'tab' }>({ selection, mode: state.diffMode });
  const fresh = !!selection && state.diffMode === 'overlay' && (selection !== dismissed.selection || state.diffMode !== dismissed.mode);
  const view: RightView = fresh ? 'detail'
    : pinned && selection && state.diffMode === 'overlay' ? 'detail'
      : state.rightView;
  const selectView = (next: RightView) => {
    setDismissed({ selection, mode: state.diffMode });
    if (next === 'detail') {
      setPinned(true);
      if (state.diffMode === 'tab') dispatch({ type: 'SET_DIFF_MODE', mode: 'overlay' });
      return;
    }
    setPinned(false);
    dispatch({ type: 'SET_RIGHT_VIEW', view: next });
  };
  const count = changes?.state === 'ok' ? changes.uncommitted.length + changes.untracked.length : 0;
  const tabs = [{ key: 'tasks', label: t('task.tab.tasks') }, { key: 'changes', label: t('task.tab.changes') }, { key: 'detail', label: t('changes.compare') }, { key: 'files', label: t('task.tab.files') }] as const;
  // Keep committed files from different commits distinct, matching ChangesBoard.
  const selectedPath = selection
    ? selection.kind === 'committed'
      ? `committed\x00${selection.commitHash ?? ''}\x00${selection.path}`
      : `${selection.kind}\x00${selection.path}`
    : null;
  return (
    <div className="compiler-top changes-board right-panel-workbench">
      <div className="changes-title" role="tablist" aria-label={t('changes.review')} onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const enabled = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
        const current = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + enabled.length) % enabled.length;
        event.preventDefault(); enabled[next]?.focus(); enabled[next]?.click();
      }}>
        {tabs.map(tab => <button type="button" role="tab" key={tab.key} id={`${tabId}-${tab.key}-tab`} aria-controls={`${tabId}-${tab.key}`} aria-selected={view === tab.key} tabIndex={view === tab.key ? 0 : -1} disabled={tab.key === 'detail' && !selection} onClick={() => selectView(tab.key)}><span className="right-tab-label">{tab.label}</span>{tab.key !== 'detail' && tab.key !== 'files' && <span className="changes-title-count">{tab.key === 'tasks' ? taskCount : count}</span>}</button>)}
      </div>
      <div className="right-task-host" id={`${tabId}-tasks`} role="tabpanel" aria-labelledby={`${tabId}-tasks-tab`} hidden={view !== 'tasks'}><TaskBoard onCountChange={setTaskCount} /></div>
      <div className="right-files-host" id={`${tabId}-files`} role="tabpanel" aria-labelledby={`${tabId}-files-tab`} hidden={view !== 'files'}><FilesBoard /></div>
      <div className="right-review-host" hidden={view === 'tasks' || view === 'files'}>
        <ChangesBoard key={resolveDiffContext(state.terminals.find(session => session.id === state.activeTerminalId))?.folderPath ?? ''} selectedPath={selectedPath} diffMode={state.diffMode} view={view === 'detail' ? 'detail' : 'changes'} active={view === 'changes' || view === 'detail'} idPrefix={tabId} />
      </div>
    </div>
  );
}
