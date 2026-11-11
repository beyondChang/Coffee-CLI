// GambitPromptOptimize — the composer footer's prompt-optimization button,
// sitting beside the send button. The draft in the input box
// is the source text and the optimized prompt is written back into the same
// box; the flow itself lives in lib/prompt-optimize (shared with the note
// cards). The notice reads as one of the footer's send-hint lines.

import { useLayoutEffect, useRef } from 'react';
import { useT } from '../../i18n/useT';
import { usePromptOptimize } from '../../lib/prompt-optimize';
import './Gambit.css';

export function GambitPromptOptimize({ draft, onDraftChange }: { draft: string; onDraftChange: (text: string) => void }) {
  const t = useT();
  const { activeId, notice, optimize } = usePromptOptimize();
  const busy = activeId !== null;
  // Live draft mirror: the result lands against THIS value, so typing during
  // the request keeps the newer text and drops the stale result. Updated in a
  // layout effect so only committed renders feed it.
  const latestRef = useRef(draft);
  useLayoutEffect(() => { latestRef.current = draft; }, [draft]);

  return <>
    {notice && (
      <span className="gambit-send-hint gambit-send-hint--optimize" role="status">
        {t(notice.kind === 'stale' ? 'prompt.optimize_stale' : 'prompt.optimize_failed')}
      </span>
    )}
    <button
      type="button"
      className={`gambit-optimize${busy ? ' is-busy' : ''}`}
      aria-label={t('prompt.optimize')}
      title={busy ? t('prompt.optimize_busy') : t('prompt.optimize')}
      disabled={busy || !draft.trim()}
      onClick={() => {
        const snapshot = draft;
        void optimize('composer', snapshot, onDraftChange, () => latestRef.current === snapshot);
      }}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
        <path d="M19 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
      </svg>
    </button>
  </>;
}
