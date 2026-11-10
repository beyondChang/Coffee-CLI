// FileViewer.tsx — read-only file content in the centre pane.
//
// Opened from the right panel's 文件 tree. Syntax highlighting reuses the
// Shiki singleton (lib/shiki) so the viewer costs nothing until a file is
// actually opened, and falls back to plain text for unknown extensions.

import { useEffect, useState } from 'react';
import { commands } from '../../tauri';
import { useT } from '../../i18n/useT';
import { getShikiTheme, tokenizeFile, type LineTokens } from '../../lib/shiki';
import './FileViewer.css';

/** Above this size we skip tokenizing — a multi-megabyte grammar pass would
 *  freeze the window, and nobody reads 2 MB of source in a narrow pane. */
const HIGHLIGHT_LIMIT = 400_000;

interface Loaded { path: string; text: string | null; failed: boolean }

export function FileViewer({ path }: { path: string }) {
  const t = useT();
  // Keyed by path so a new file shows the loading state without an extra
  // effect-only reset (and never flashes the previous file's contents).
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tokenized, setTokenized] = useState<{ path: string; lines: LineTokens[] } | null>(null);
  const current = loaded && loaded.path === path ? loaded : null;

  useEffect(() => {
    let cancelled = false;
    commands.readTextFile(path)
      .then(text => { if (!cancelled) setLoaded({ path, text, failed: text === null }); })
      .catch(() => { if (!cancelled) setLoaded({ path, text: null, failed: true }); });
    return () => { cancelled = true; };
  }, [path]);

  useEffect(() => {
    const text = current?.text;
    if (typeof text !== 'string' || text.length > HIGHLIGHT_LIMIT) return;
    let cancelled = false;
    const theme = getShikiTheme(document.documentElement.dataset.mode ?? null);
    tokenizeFile(text, path, theme)
      .then(lines => { if (!cancelled && lines) setTokenized({ path, lines }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [current, path]);

  if (!current) return <div className="file-viewer-status" role="status">{t('file.loading')}</div>;
  if (current.failed || current.text === null) return <div className="file-viewer-status" role="alert">{t('file.error')}</div>;

  const tokens = tokenized?.path === path ? tokenized.lines : null;
  const rows = tokens ?? current.text.split('\n').map(line => [{ content: line, color: undefined }]);

  return (
    <div className="file-viewer" role="document" aria-label={path}>
      <div className="file-viewer-code">
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
    </div>
  );
}
