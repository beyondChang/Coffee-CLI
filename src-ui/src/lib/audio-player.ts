// audio-player.ts — shared entry point for the standalone music player window.
//
// Clicking an audio file in either file tree (left Explorer or right 文件 tab)
// opens ONE small frameless window instead of a text tab. The window is
// created from the frontend so no Rust rebuild is needed; its label matches
// the existing `detached-*` capability in capabilities/default.json, which is
// what grants the new webview IPC (drag, close, window APIs) without touching
// the compiled ACL.
//
// The initial track + directory travel through localStorage (same origin as
// the main window) rather than a URL query: Tauri resolves `WebviewUrl::App`
// as a path, and a query string on that path is easy to mangle on Windows.
// Later clicks broadcast a sync event; the player re-reads localStorage then.

import type { WebviewWindow as WebviewWindowType } from '@tauri-apps/api/webviewWindow';
import { isTauri } from '../tauri';

/** Formats the bundled WebView2/WebKit media stack can decode. Anything else
 *  stays a normal text tab — no point opening a player that can't play it. */
const AUDIO_EXTENSION = /\.(mp3|wav|wave|ogg|oga|opus|flac|m4a|m4b|mp4a|aac|webm|weba|aif|aiff|mp2|mpga|caf|amr)$/i;

export function isAudioFile(nameOrPath: string): boolean {
  return AUDIO_EXTENSION.test(nameOrPath);
}

/** MUST match a capability window pattern in capabilities/default.json. */
export const AUDIO_WINDOW_LABEL = 'detached-audio-player';
export const AUDIO_SYNC_EVENT = 'audio-player:sync';
export const AUDIO_REQUEST_KEY = 'cc-audio-player-request';

export interface AudioPlayerRequest {
  /** Absolute path of the file that was clicked. */
  path: string;
  /** Directory to build the playlist from. */
  dir: string;
  /** Monotonic stamp so two clicks on the same file still produce a new
   *  state object and re-run the player's "load this track" effect. */
  seq: number;
}

let requestSequence = 0;

/** Publish the track/dir for a window that is about to be created, or for an
 *  already-running one that is about to receive AUDIO_SYNC_EVENT. */
export function writeAudioRequest(path: string, dir: string): void {
  const request: AudioPlayerRequest = { path, dir, seq: ++requestSequence };
  try {
    localStorage.setItem(AUDIO_REQUEST_KEY, JSON.stringify(request));
  } catch {
    // Private/broken storage: the player still gets the path via the sync
    // event fallback below, so a failure here is non-fatal.
  }
}

export function readAudioRequest(): AudioPlayerRequest | null {
  try {
    const raw = localStorage.getItem(AUDIO_REQUEST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AudioPlayerRequest>;
    return typeof parsed.path === 'string' && typeof parsed.dir === 'string'
      ? { path: parsed.path, dir: parsed.dir, seq: Number(parsed.seq) || 0 }
      : null;
  } catch {
    return null;
  }
}

/** Open (or reuse) the player window for `path`, with a playlist built from
 *  `dir`. Safe to call from a non-Tauri browser preview — it becomes a no-op. */
export async function openAudioPlayer(path: string, dir: string): Promise<void> {
  writeAudioRequest(path, dir);
  if (!isTauri) return;

  try {
    const [{ WebviewWindow }, { emit }] = await Promise.all([
      import('@tauri-apps/api/webviewWindow'),
      import('@tauri-apps/api/event'),
    ]);

    // Enumerating windows needs `core:window:allow-get-all-windows` (part of
    // core:default). If that ever changes, don't let a failed lookup stop us
    // from opening the window — the localStorage request is still authoritative.
    let existing: WebviewWindowType | null = null;
    try {
      existing = await WebviewWindow.getByLabel(AUDIO_WINDOW_LABEL);
    } catch { /* treat as "no window yet" */ }

    if (existing) {
      // The window already booted. localStorage now holds the new request;
      // the sync event just tells it to re-read (and brings it forward).
      await emit(AUDIO_SYNC_EVENT);
      try { await existing.setFocus(); } catch { /* window closed in between */ }
      return;
    }

    const win = new WebviewWindow(AUDIO_WINDOW_LABEL, {
      url: 'player.html',
      title: 'Coffee Music',
      width: 420,
      // The player sizes itself from its playlist after boot (small window for
      // a short list, capped at MAX_WINDOW_HEIGHT with a scrolling list for a
      // long one). Start hidden at the minimum so there is no visible jump.
      height: 360,
      minWidth: 340,
      minHeight: 300,
      maxHeight: 640,
      resizable: true,
      decorations: false,
      transparent: true,
      center: true,
      visible: false,
    });
    // Two rapid clicks can race the async create; the second one fails on the
    // duplicate label, but the first window still reads the newest request
    // from localStorage. Log it so a real permission failure isn't silent.
    void win.once('tauri://error', event => {
      console.warn('[AudioPlayer] window creation reported an error:', event.payload);
    });
  } catch (error) {
    console.error('[AudioPlayer] could not open player window:', error);
  }
}
