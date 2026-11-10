// MusicPlayer.tsx — the standalone audio-player window.
//
// Opened by clicking an audio file in either file tree. It plays that file
// through Tauri's asset protocol (convertFileSrc) and lists every audio file
// in the SAME directory, so clicking a row switches tracks in place. Keeping
// this in its own webview means playback survives tab switches, session
// changes and even closing the file tree in the main window.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, MouseEvent as ReactMouseEvent } from 'react';
import { commands, isTauri } from '../../tauri';
import type { DirEntryInfo } from '../../tauri';
import {
  AUDIO_REQUEST_KEY,
  AUDIO_SYNC_EVENT,
  isAudioFile,
  readAudioRequest,
  type AudioPlayerRequest,
} from '../../lib/audio-player';
import { usePlayerT } from '../../i18n/player';
import './MusicPlayer.css';

type RepeatMode = 'off' | 'all' | 'one';
type MediaError = '' | 'play' | 'format';

const fileName = (path: string) => path.replace(/\\/g, '/').split('/').pop() || path;
const dirName = (path: string) => {
  const parts = path.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const byName = (a: DirEntryInfo, b: DirEntryInfo) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Small inline icon set — keeps the window dependency-free. */
function Icon({ name }: { name: 'play' | 'pause' | 'prev' | 'next' | 'shuffle' | 'repeat' | 'volume' | 'muted' | 'refresh' | 'music' }) {
  const common = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'play': return <svg {...common}><path d="M8 5v14l11-7z" fill="currentColor" stroke="none" /></svg>;
    case 'pause': return <svg {...common}><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" /></svg>;
    case 'prev': return <svg {...common}><path d="M6 5v14M19 5 8 12l11 7z" fill="currentColor" stroke="none" /></svg>;
    case 'next': return <svg {...common}><path d="M18 5v14M5 5l11 7-11 7z" fill="currentColor" stroke="none" /></svg>;
    case 'shuffle': return <svg {...common}><path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" /></svg>;
    case 'repeat': return <svg {...common}><path d="m17 2 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3" /></svg>;
    case 'volume': return <svg {...common}><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></svg>;
    case 'muted': return <svg {...common}><path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6" /></svg>;
    case 'refresh': return <svg {...common}><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" /></svg>;
    case 'music': return <svg {...common} strokeWidth={1.4}><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>;
  }
}

export function MusicPlayer() {
  const t = usePlayerT();

  const [request, setRequest] = useState<AudioPlayerRequest | null>(() => readAudioRequest());
  const [tracks, setTracks] = useState<DirEntryInfo[]>([]);
  const [listError, setListError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [currentPath, setCurrentPath] = useState(request?.path ?? '');
  const [src, setSrc] = useState('');
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('all');
  const [shuffle, setShuffle] = useState(false);
  const [mediaError, setMediaError] = useState<MediaError>('');
  const audioRef = useRef<HTMLAudioElement>(null);

  const dir = request?.dir ?? '';

  // Two independent channels carry a new request from the main window:
  // localStorage `storage` events (always available, same origin) and Tauri's
  // global sync event (covers the case where storage events are coalesced).
  useEffect(() => {
    const apply = () => {
      const next = readAudioRequest();
      if (next) setRequest(next);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUDIO_REQUEST_KEY) apply();
    };
    window.addEventListener('storage', onStorage);

    let disposed = false;
    let unlisten: (() => void) | null = null;
    if (isTauri) {
      void import('@tauri-apps/api/event')
        .then(async ({ listen }) => {
          const off = await listen(AUDIO_SYNC_EVENT, apply);
          if (disposed) off(); else unlisten = off;
        })
        .catch(() => { /* non-Tauri preview */ });
    }
    return () => {
      disposed = true;
      window.removeEventListener('storage', onStorage);
      unlisten?.();
    };
  }, []);

  // A click on another audio file replaces the current track. `request` is a
  // fresh object every time (seq), so re-clicking the same file also restarts.
  useEffect(() => {
    if (!request) return;
    setCurrentPath(request.path);
    setCurrentTime(0);
    setDuration(0);
    setMediaError('');
  }, [request]);

  // Playlist = all audio files in the clicked file's directory.
  useEffect(() => {
    if (!dir) { setTracks([]); return; }
    let cancelled = false;
    void commands.listDirectory(dir)
      .then(entries => {
        if (cancelled) return;
        setTracks(entries.filter(entry => !entry.is_dir && isAudioFile(entry.name)).sort(byName));
        setListError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setTracks([]);
        setListError(true);
      });
    return () => { cancelled = true; };
  }, [dir, reloadToken]);

  // A file opened from a link (not the tree) may not be in the listing — keep
  // it visible so the playlist always contains what is actually playing.
  const list = useMemo<DirEntryInfo[]>(() => {
    if (!currentPath || tracks.some(track => track.path === currentPath)) return tracks;
    const fallback: DirEntryInfo = { name: fileName(currentPath), path: currentPath, is_dir: false, size: 0 };
    return [...tracks, fallback].sort(byName);
  }, [tracks, currentPath]);

  // assetProtocol scope is `**` in tauri.conf.json, so WebView can stream the
  // local file directly — no read-onto-JS-heap or temp copy needed.
  useEffect(() => {
    if (!currentPath) { setSrc(''); return; }
    let cancelled = false;
    void import('@tauri-apps/api/core')
      .then(({ convertFileSrc }) => { if (!cancelled) setSrc(convertFileSrc(currentPath)); })
      .catch(() => { if (!cancelled) setSrc('file:///' + currentPath.replace(/\\/g, '/')); });
    return () => { cancelled = true; };
  }, [currentPath]);

  // Auto-play whenever the source changes (first open + playlist switches).
  // WebView autoplay policy may block this in a freshly-created window; the
  // rejected promise leaves the UI in a paused state with a hint to press play.
  useEffect(() => {
    if (!src) return;
    const el = audioRef.current;
    if (!el) return;
    const tryPlay = () => { void el.play().catch(() => setMediaError('play')); };
    if (el.readyState >= 2) tryPlay();
    else el.addEventListener('canplay', tryPlay, { once: true });
    return () => el.removeEventListener('canplay', tryPlay);
  }, [src]);

  useEffect(() => {
    const el = audioRef.current;
    if (el) { el.volume = volume; el.muted = muted; }
  }, [volume, muted]);

  const selectTrack = useCallback((path: string) => {
    const el = audioRef.current;
    if (path === currentPath) {
      if (el?.paused) void el.play().catch(() => setMediaError('play'));
      else el?.pause();
      return;
    }
    setCurrentPath(path);
    setCurrentTime(0);
    setDuration(0);
    setMediaError('');
  }, [currentPath]);

  const playNext = useCallback((step: 1 | -1, fromEnded = false) => {
    if (list.length === 0) return;
    if (fromEnded && repeat === 'one') {
      const el = audioRef.current;
      if (el) { el.currentTime = 0; void el.play().catch(() => {}); }
      return;
    }
    const index = list.findIndex(track => track.path === currentPath);
    let next: number;
    if (shuffle && list.length > 1) {
      next = Math.floor(Math.random() * list.length);
      if (next === index) next = (next + 1) % list.length;
    } else {
      next = index + step;
      if (next < 0 || next >= list.length) {
        if (fromEnded && step === 1 && repeat === 'off') { setPlaying(false); return; }
        next = (next + list.length) % list.length;
      }
    }
    setCurrentPath(list[next].path);
    setCurrentTime(0);
    setDuration(0);
    setMediaError('');
  }, [list, currentPath, shuffle, repeat]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el || !src) return;
    if (el.paused) void el.play().catch(() => setMediaError('play'));
    else el.pause();
  }, [src]);

  const seekBy = useCallback((delta: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(el.duration)) return;
    el.currentTime = Math.min(el.duration, Math.max(0, el.currentTime + delta));
  }, []);

  const runWindowAction = useCallback((action: 'drag' | 'minimize' | 'close') => {
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        if (action === 'drag') void win.startDragging();
        else if (action === 'minimize') void win.minimize();
        else void win.close();
      })
      .catch(() => { /* browser preview: no native window */ });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      switch (event.key) {
        case ' ': event.preventDefault(); togglePlay(); break;
        case 'ArrowRight': event.preventDefault(); seekBy(5); break;
        case 'ArrowLeft': event.preventDefault(); seekBy(-5); break;
        case 'ArrowDown': event.preventDefault(); playNext(1); break;
        case 'ArrowUp': event.preventDefault(); playNext(-1); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [togglePlay, seekBy, playNext]);

  const onSeek = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    const el = audioRef.current;
    if (el && Number.isFinite(el.duration)) { el.currentTime = value; setCurrentTime(value); }
  };

  const onDragStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button === 0) runWindowAction('drag');
  };

  const repeatLabel = repeat === 'off' ? t('player.repeat_off') : repeat === 'all' ? t('player.repeat_all') : t('player.repeat_one');
  const currentName = currentPath ? fileName(currentPath) : t('player.unknown');
  const seekStyle = { '--mp-fill': `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%` } as CSSProperties;
  const volumeStyle = { '--mp-fill': `${(muted ? 0 : volume) * 100}%` } as CSSProperties;

  return (
    <div className="mp-root">
      <div className="mp-titlebar">
        <div className="mp-drag" onMouseDown={onDragStart}>
          <span className="mp-brand-icon"><Icon name="music" /></span>
          <span className="mp-brand">{t('player.title')}</span>
        </div>
        <div className="mp-window-actions">
          <button type="button" className="mp-window-btn" aria-label={t('player.minimize')} title={t('player.minimize')} onClick={() => runWindowAction('minimize')}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
          <button type="button" className="mp-window-btn is-close" aria-label={t('player.close')} title={t('player.close')} onClick={() => runWindowAction('close')}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" strokeWidth="1.3" /></svg>
          </button>
        </div>
      </div>

      <div className="mp-body">
        <section className="mp-now">
          <div className={`mp-art${playing ? ' is-playing' : ''}`}><Icon name="music" /></div>
          <div className="mp-now-text">
            <div className="mp-track-name mp-now-title" title={currentPath || currentName}>{currentName}</div>
            <div className="mp-folder" title={dir}>
              <span className="mp-folder-label">{t('player.folder')}</span>
              <span className="mp-folder-value">{dir ? dirName(dir) : '—'}</span>
            </div>
          </div>
        </section>

        <div className="mp-progress">
          <input className="mp-range mp-seek" type="range" min={0} max={duration || 0} step={0.1}
            value={Math.min(currentTime, duration || 0)} onChange={onSeek} style={seekStyle} />
          <div className="mp-times"><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
        </div>

        <div className="mp-controls">
          <button type="button" className={`mp-btn${shuffle ? ' is-on' : ''}`} aria-label={t('player.shuffle')} title={t('player.shuffle')} onClick={() => setShuffle(value => !value)}><Icon name="shuffle" /></button>
          <button type="button" className="mp-btn" aria-label={t('player.prev')} title={t('player.prev')} onClick={() => playNext(-1)}><Icon name="prev" /></button>
          <button type="button" className="mp-btn mp-btn-play" aria-label={playing ? t('player.pause') : t('player.play')} title={playing ? t('player.pause') : t('player.play')} onClick={togglePlay}>
            <Icon name={playing ? 'pause' : 'play'} />
          </button>
          <button type="button" className="mp-btn" aria-label={t('player.next')} title={t('player.next')} onClick={() => playNext(1)}><Icon name="next" /></button>
          <button type="button" className={`mp-btn${repeat !== 'off' ? ' is-on' : ''}`} aria-label={repeatLabel} title={repeatLabel} onClick={() => setRepeat(prev => prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off')}>
            <Icon name="repeat" />
            {repeat === 'one' && <span className="mp-repeat-one">1</span>}
          </button>
        </div>

        <div className="mp-volume">
          <button type="button" className="mp-btn mp-btn-small" aria-label={muted ? t('player.unmute') : t('player.mute')} title={muted ? t('player.unmute') : t('player.mute')} onClick={() => setMuted(value => !value)}>
            <Icon name={muted || volume === 0 ? 'muted' : 'volume'} />
          </button>
          <input className="mp-range mp-volume-range" type="range" min={0} max={1} step={0.01}
            value={muted ? 0 : volume} aria-label={t('player.volume')}
            onChange={event => { setVolume(Number(event.target.value)); setMuted(false); }} style={volumeStyle} />
          <span className="mp-volume-value">{Math.round((muted ? 0 : volume) * 100)}%</span>
        </div>

        {mediaError && <div className="mp-error" role="alert">{mediaError === 'play' ? t('player.error.play') : t('player.error.format')}</div>}

        <div className="mp-list-head">
          <span className="mp-list-title">{t('player.playlist')}</span>
          <span className="mp-list-count">{t('player.tracks', { count: list.length })}</span>
          <button type="button" className="mp-btn mp-btn-small mp-refresh" aria-label={t('player.refresh')} title={t('player.refresh')} onClick={() => setReloadToken(value => value + 1)}><Icon name="refresh" /></button>
        </div>

        <div className="mp-list">
          {listError ? (
            <div className="mp-list-empty">{t('player.error.dir')}</div>
          ) : list.length === 0 ? (
            <div className="mp-list-empty">
              <span>{t('player.empty')}</span>
              <small>{t('player.empty_hint')}</small>
            </div>
          ) : list.map((track, index) => {
            const active = track.path === currentPath;
            return (
              <button type="button" key={track.path} className={`mp-track${active ? ' is-current' : ''}`}
                title={track.path} onClick={() => selectTrack(track.path)}>
                <span className="mp-track-index">
                  {active ? <span className={`mp-equalizer${playing ? ' is-active' : ''}`}><i /><i /><i /></span> : index + 1}
                </span>
                <span className="mp-track-name">{track.name}</span>
                {track.size > 0 && <span className="mp-track-size">{formatSize(track.size)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <audio
        ref={audioRef}
        src={src || undefined}
        onPlay={() => { setPlaying(true); setMediaError(''); }}
        onPause={() => setPlaying(false)}
        onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onEnded={() => playNext(1, true)}
        onError={() => { setMediaError('format'); setPlaying(false); }}
      />
    </div>
  );
}
