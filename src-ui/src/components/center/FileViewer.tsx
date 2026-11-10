// FileViewer.tsx — file content in the centre pane.
//
// Opened from the right panel's 文件 tree. Syntax highlighting reuses the
// Shiki singleton (lib/shiki) so the viewer costs nothing until a file is
// actually opened, and falls back to plain text for unknown extensions.
// Markdown files get a 预览 / 编辑 switch: preview by default, edits save
// automatically, and Ctrl+Z / Ctrl+Y walk the local history.

import { useEffect, useRef, useState } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { getShikiTheme, tokenizeFile, type LineTokens } from '../../lib/shiki';
import { MarkdownContent } from './MarkdownContent';
import './FileViewer.css';

/** Typing pause before an edit is written back to disk. Every keystroke
 *  restarts the wait, so a continuous burst saves 3s after it stops. */
const SAVE_DELAY_MS = 3000;
/** Keystrokes closer together than this collapse into one undo step. */
const UNDO_GROUP_MS = 400;
const UNDO_LIMIT = 300;

interface Loaded { path: string; text: string | null; failed: boolean }
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
const isHtml = (path: string) => /\.(html?|xhtml)$/i.test(path);
const isImage = (path: string) => /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(path);

/** Above this size we skip tokenizing — a multi-megabyte grammar pass would
 *  freeze the window, and nobody reads 2 MB of source in a narrow pane. */
const HIGHLIGHT_LIMIT = 400_000;
const ZOOM_MIN = 0.15;
const ZOOM_MAX = 8;

/** Images have no text to tokenize, so they get their own surface. */
function ImageViewer({ path }: { path: string }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; startX: number; startY: number; ox: number; oy: number } | null>(null);
  const resetZoom = () => setZoom({ scale: 1, x: 0, y: 0 });

  useEffect(() => {
    let cancelled = false;
    setZoom({ scale: 1, x: 0, y: 0 });
    import('@tauri-apps/api/core')
      .then(({ convertFileSrc }) => { if (!cancelled) setUrl(convertFileSrc(path)); })
      .catch(() => { if (!cancelled) setUrl('file:///' + path.replace(/\\/g, '/')); });
    return () => { cancelled = true; };
  }, [path]);

  // Wheel zooms around the pointer. Native (non-passive) listener so the
  // gesture can't also scroll the pane, and the anchor keeps the pixel under
  // the cursor in place instead of drifting toward the centre.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      const px = event.clientX - (rect.left + rect.width / 2);
      const py = event.clientY - (rect.top + rect.height / 2);
      setZoom(prev => {
        const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, prev.scale * Math.exp(-event.deltaY * 0.0015)));
        const ratio = scale / prev.scale;
        return { scale, x: px - (px - prev.x) * ratio, y: py - (py - prev.y) * ratio };
      });
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  if (failed) return <div className="file-viewer-status" role="alert">{t('file.error')}</div>;
  return (
    <div className="file-viewer is-image">
      <div
        className={`file-viewer-image-stage${zoom.scale !== 1 ? ' is-zoomed' : ''}${dragging ? ' is-dragging' : ''}`}
        ref={stageRef}
        onDoubleClick={resetZoom}
        onPointerDown={event => {
          // Panning only makes sense once the image is larger than the stage.
          if (zoom.scale === 1) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, ox: zoom.x, oy: zoom.y };
          setDragging(true);
        }}
        onPointerMove={event => {
          const state = drag.current;
          if (!state || state.id !== event.pointerId) return;
          setZoom(prev => ({ ...prev, x: state.ox + (event.clientX - state.startX), y: state.oy + (event.clientY - state.startY) }));
        }}
        onPointerUp={event => {
          if (drag.current?.id !== event.pointerId) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          drag.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => { drag.current = null; setDragging(false); }}
      >
        {url && (
          <img
            className="file-viewer-image"
            src={url}
            alt={path.replace(/\\/g, '/').split('/').pop() ?? path}
            style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ path }: { path: string }) {
  return isImage(path) ? <ImageViewer path={path} /> : <TextViewer path={path} />;
}

function TextViewer({ path }: { path: string }) {
  const t = useT();
  // Keyed by path so a new file shows the loading state without an extra
  // effect-only reset (and never flashes the previous file's contents).
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tokenized, setTokenized] = useState<{ path: string; lines: LineTokens[] } | null>(null);
  const [mode, setMode] = useState<{ path: string; value: 'preview' | 'edit' }>({ path, value: 'preview' });
  const [buffer, setBuffer] = useState<{ path: string; text: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState('');
  // Latest unsaved text, so closing the tab mid-pause still flushes the edit.
  const pending = useRef<{ path: string; text: string; disk: string } | null>(null);
  const history = useRef<{ path: string; entries: string[]; index: number; stamp: number }>({ path, entries: [], index: -1, stamp: 0 });
  const current = loaded && loaded.path === path ? loaded : null;
  // Every text file offers 预览 · 编辑: markdown renders, HTML mounts a
  // sandboxed iframe, code shows its highlighted read-only layer.
  const editing = mode.path === path && mode.value === 'edit';
  const text = buffer && buffer.path === path ? buffer.text : current?.text ?? '';

  useEffect(() => {
    let cancelled = false;
    commands.readTextFile(path)
      .then(value => { if (!cancelled) setLoaded({ path, text: value, failed: value === null }); })
      .catch(() => { if (!cancelled) setLoaded({ path, text: null, failed: true }); });
    return () => { cancelled = true; };
  }, [path]);

  // Highlight the buffer (not just what is on disk) so the colouring follows
  // the caret as you type. Unknown languages resolve to null → plain text.
  useEffect(() => {
    if (typeof text !== 'string' || text.length > HIGHLIGHT_LIMIT) return;
    let cancelled = false;
    const theme = getShikiTheme(document.documentElement.dataset.mode ?? null);
    tokenizeFile(text, path, theme)
      .then(lines => { if (!cancelled) setTokenized(lines ? { path, lines } : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [text, path]);

  // Auto-save: one write per typing pause, skipped while the buffer still
  // matches what is on disk. Each keystroke re-runs this effect, which clears
  // the previous timer — so the 3s only elapse once typing has stopped.
  useEffect(() => {
    if (!buffer || buffer.path !== path) return;
    if (buffer.text === current?.text) return;
    pending.current = { path, text: buffer.text, disk: current?.text ?? '' };
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      commands.fsWriteText(path, buffer.text)
        .then(() => { pending.current = null; setSaveState('saved'); })
        .catch(error => {
          console.error('[FileViewer] save failed:', error);
          setSaveError(String(error));
          setSaveState('error');
        });
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [buffer, current?.text, path]);

  // Flush an edit that is still waiting for its pause when the tab closes.
  useEffect(() => () => {
    const job = pending.current;
    if (!job || job.text === job.disk) return;
    commands.fsWriteText(job.path, job.text).catch(error => console.error('[FileViewer] flush failed:', error));
  }, []);

  const change = (value: string) => {
    const now = Date.now();
    const h = history.current;
    if (h.path !== path) { history.current = { path, entries: [value], index: 0, stamp: now }; }
    else if (now - h.stamp > UNDO_GROUP_MS || h.index < 0) {
      h.entries = [...h.entries.slice(0, h.index + 1), value].slice(-UNDO_LIMIT);
      h.index = h.entries.length - 1;
      h.stamp = now;
    } else {
      // Same burst of typing: replace the tip so undo steps back a word-run,
      // not a single keystroke.
      h.entries[h.index] = value;
      h.stamp = now;
    }
    setSaveState('idle');
    setBuffer({ path, text: value });
  };

  const editorKeys = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) { event.preventDefault(); step(-1); }
    else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); step(1); }
  };

  const step = (delta: -1 | 1) => {
    const h = history.current;
    if (h.path !== path) return;
    const next = h.index + delta;
    if (next < 0 || next >= h.entries.length) return;
    h.index = next;
    h.stamp = 0;
    setBuffer({ path, text: h.entries[next] });
  };

  if (!current) return <div className="file-viewer-status" role="status">{t('file.loading')}</div>;
  if (current.failed || current.text === null) return <div className="file-viewer-status" role="alert">{t('file.error')}</div>;

  const markdown = isMarkdown(path);
  const html = isHtml(path);
  const status = saveState === 'saving' ? t('file.saving') : saveState === 'saved' ? t('file.saved') : saveState === 'error' ? t('file.save_failed') : '';

  return (
    <div className={`file-viewer${editing ? ' is-editing' : ''}`}>
      <div className="file-viewer-bar">
        <span className={`file-viewer-save${saveState === 'error' ? ' is-error' : ''}`} role="status" title={saveState === 'error' ? saveError : undefined}>{status}</span>
        <span className="file-viewer-switch" role="group" aria-label={t('file.preview')}>
          <button type="button" aria-pressed={!editing} onClick={() => setMode({ path, value: 'preview' })}>{t('file.preview')}</button>
          <button type="button" aria-pressed={editing} onClick={() => setMode({ path, value: 'edit' })}>{t('file.edit')}</button>
        </span>
      </div>

      {editing ? (
        markdown || html ? (
          <textarea
            className="file-viewer-editor"
            value={text}
            spellCheck={false}
            wrap="off"
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={path}
            onChange={event => change(event.target.value)}
            onKeyDown={editorKeys}
          />
        ) : (
          // Code: syntax colours underneath, an invisible textarea on top so
          // the caret, selection and IME all behave.
          <CodeEditor path={path} text={text} tokens={tokenized?.path === path ? tokenized.lines : null} onChange={change} onKeyDown={editorKeys} />
        )
      ) : markdown ? (
        <div className="file-viewer-markdown" role="document" aria-label={path}>
          <MarkdownContent content={text} />
        </div>
      ) : html ? (
        // Local HTML only: scripts stay disabled (empty sandbox), so a preview
        // can never reach into the app, while inline styles still render.
        <iframe className="file-viewer-html" sandbox="" srcDoc={text} title={path} />
      ) : (
        <CodeEditor path={path} text={text} tokens={tokenized?.path === path ? tokenized.lines : null} readOnly />
      )}
    </div>
  );
}

/** Highlighted read-only layer + transparent textarea on top. Both layers use
 *  the same font metrics and integer line-height, so the caret sits exactly on
 *  the coloured glyphs; scrolling the textarea translates the layer behind. */
function CodeEditor({ path, text, tokens, onChange, onKeyDown, readOnly = false }: {
  path: string;
  text: string;
  tokens: LineTokens[] | null;
  onChange?: (value: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  readOnly?: boolean;
}) {
  const highlight = useRef<HTMLDivElement>(null);
  const rows = tokens ?? text.split('\n').map(line => [{ content: line, color: undefined }]);
  if (readOnly) {
    // Preview: the same coloured rows, just scrollable and with no caret.
    return (
      <div className="file-viewer-edit">
        <div className="file-viewer-highlight is-static">
          <div className="file-viewer-highlight-inner">
            {rows.map((line, index) => (
              <div className="file-viewer-row" key={index}>
                <span className="file-viewer-lineno">{index + 1}</span>
                <span className="file-viewer-line">
                  {line.length ? line.map((token, i) => (
                    <span key={i} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
                  )) : '\u00a0'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="file-viewer-edit">
      <div className="file-viewer-highlight" aria-hidden="true">
        <div className="file-viewer-highlight-inner" ref={highlight}>
          {rows.map((line, index) => (
            <div className="file-viewer-row" key={index}>
              <span className="file-viewer-lineno">{index + 1}</span>
              <span className="file-viewer-line">
                {line.length ? line.map((token, i) => (
                  <span key={i} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
                )) : '\u00a0'}
              </span>
            </div>
          ))}
        </div>
      </div>
      <textarea
        className="file-viewer-input"
        value={text}
        spellCheck={false}
        wrap="off"
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={path}
        onChange={event => onChange?.(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={event => {
          const layer = highlight.current;
          if (!layer) return;
          const el = event.currentTarget;
          layer.style.transform = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`;
        }}
      />
    </div>
  );
}
