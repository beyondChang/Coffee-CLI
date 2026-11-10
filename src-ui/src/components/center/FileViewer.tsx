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

/** Above this size we skip tokenizing — a multi-megabyte grammar pass would
 *  freeze the window, and nobody reads 2 MB of source in a narrow pane. */
const HIGHLIGHT_LIMIT = 400_000;
/** Typing pause before an edit is written back to disk. */
const SAVE_DELAY_MS = 700;
/** Keystrokes closer together than this collapse into one undo step. */
const UNDO_GROUP_MS = 400;
const UNDO_LIMIT = 300;

interface Loaded { path: string; text: string | null; failed: boolean }
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

export function FileViewer({ path }: { path: string }) {
  const t = useT();
  // Keyed by path so a new file shows the loading state without an extra
  // effect-only reset (and never flashes the previous file's contents).
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tokenized, setTokenized] = useState<{ path: string; lines: LineTokens[] } | null>(null);
  const [mode, setMode] = useState<{ path: string; value: 'preview' | 'edit' }>({ path, value: 'preview' });
  const [buffer, setBuffer] = useState<{ path: string; text: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const history = useRef<{ path: string; entries: string[]; index: number; stamp: number }>({ path, entries: [], index: -1, stamp: 0 });
  const current = loaded && loaded.path === path ? loaded : null;
  const editing = isMarkdown(path) && mode.path === path && mode.value === 'edit';
  const text = buffer && buffer.path === path ? buffer.text : current?.text ?? '';

  useEffect(() => {
    let cancelled = false;
    commands.readTextFile(path)
      .then(value => { if (!cancelled) setLoaded({ path, text: value, failed: value === null }); })
      .catch(() => { if (!cancelled) setLoaded({ path, text: null, failed: true }); });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    const value = current?.text;
    if (typeof value !== 'string' || value.length > HIGHLIGHT_LIMIT) return;
    let cancelled = false;
    const theme = getShikiTheme(document.documentElement.dataset.mode ?? null);
    tokenizeFile(value, path, theme)
      .then(lines => { if (!cancelled && lines) setTokenized({ path, lines }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [current, path]);

  // Auto-save: one write per typing pause, skipped while the buffer still
  // matches what is on disk.
  useEffect(() => {
    if (!buffer || buffer.path !== path) return;
    if (buffer.text === current?.text) return;
    const timer = window.setTimeout(() => {
      setSaveState('saving');
      commands.fsWriteText(path, buffer.text)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'));
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [buffer, current?.text, path]);

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
  const status = saveState === 'saving' ? t('file.saving') : saveState === 'saved' ? t('file.saved') : saveState === 'error' ? t('file.save_failed') : '';

  return (
    <div className={`file-viewer${editing ? ' is-editing' : ''}`}>
      {markdown && (
        <div className="file-viewer-bar">
          <span className={`file-viewer-save${saveState === 'error' ? ' is-error' : ''}`} role="status">{status}</span>
          <span className="file-viewer-switch" role="group" aria-label={t('file.preview')}>
            <button type="button" aria-pressed={!editing} onClick={() => setMode({ path, value: 'preview' })}>{t('file.preview')}</button>
            <button type="button" aria-pressed={editing} onClick={() => setMode({ path, value: 'edit' })}>{t('file.edit')}</button>
          </span>
        </div>
      )}

      {editing ? (
        <textarea
          className="file-viewer-editor"
          value={text}
          spellCheck={false}
          aria-label={path}
          onChange={event => change(event.target.value)}
          onKeyDown={event => {
            if (!(event.ctrlKey || event.metaKey)) return;
            const key = event.key.toLowerCase();
            if (key === 'z' && !event.shiftKey) { event.preventDefault(); step(-1); }
            else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); step(1); }
          }}
        />
      ) : markdown ? (
        <div className="file-viewer-markdown" role="document" aria-label={path}>
          <MarkdownContent content={text} />
        </div>
      ) : (
        <CodeView path={path} text={text} tokens={tokenized?.path === path ? tokenized.lines : null} />
      )}
    </div>
  );
}

function CodeView({ path, text, tokens }: { path: string; text: string; tokens: LineTokens[] | null }) {
  const rows = tokens ?? text.split('\n').map(line => [{ content: line, color: undefined }]);
  return (
    <div className="file-viewer-code" role="document" aria-label={path}>
      {rows.map((line, index) => (
        <div className="file-viewer-row" key={index}>
          <span className="file-viewer-lineno" aria-hidden="true">{index + 1}</span>
          <span className="file-viewer-line">
            {line.length ? line.map((token, i) => (
              <span key={i} style={token.color ? { color: token.color } : undefined}>{token.content}</span>
            )) : '\u00a0'}
          </span>
        </div>
      ))}
    </div>
  );
}
