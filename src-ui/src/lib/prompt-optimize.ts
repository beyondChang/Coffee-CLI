// prompt-optimize.ts — shared flow behind every "提示词优化" button.
//
// The note cards (TaskNoteView) and the composer (GambitPromptOptimize) run
// the same contract against the built-in model:
//
//   - single-flight per surface: one optimization at a time;
//   - the request carries the text as it was when clicked;
//   - the result replaces the text ONLY while it is still unchanged since
//     the click — a slow response never clobbers newer typing (kind 'stale');
//   - a failed or empty reply keeps the original text (kind 'failed');
//   - the notice auto-dismisses after a few seconds.
import { useCallback, useEffect, useRef, useState } from 'react';
import { commands } from '../tauri';

export type OptimizeNoticeKind = 'failed' | 'stale';

const NOTICE_MS = 6000;

export function usePromptOptimize() {
  // Non-null while a request is in flight; carries the caller's id so list
  // surfaces can spin only the busy card.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; kind: OptimizeNoticeKind } | null>(null);
  // Synchronous gate: two clicks landing in the same tick must not start two
  // model requests even before React re-renders the disabled buttons.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Optimize `text` and hand the result to `apply`.
   * `isUnchanged` is consulted when the result lands: return false when the
   * source text was edited (or removed) in the meantime and the result must
   * be dropped instead of applied.
   */
  const optimize = useCallback(async (
    id: string,
    text: string,
    apply: (next: string) => void,
    isUnchanged: () => boolean,
  ) => {
    setNotice(null);
    if (!text.trim() || inFlightRef.current) return;
    inFlightRef.current = true;
    setActiveId(id);
    try {
      const optimized = (await commands.optimizeTaskPrompt(text)).trim();
      if (!optimized) throw new Error('empty optimization');
      if (!isUnchanged()) setNotice({ id, kind: 'stale' });
      else apply(optimized);
    } catch {
      setNotice({ id, kind: 'failed' });
    } finally {
      inFlightRef.current = false;
      setActiveId(null);
    }
  }, []);

  return { activeId, notice, optimize };
}
