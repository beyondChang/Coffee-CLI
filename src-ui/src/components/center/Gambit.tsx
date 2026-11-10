// Gambit.tsx — docked compose panel anchored at the bottom of the center panel.
//
// Named for the chess "gambit": a calculated opening move after careful thought.
// Users compose long messages (and paste screenshots) in a real HTML textarea
// where native Ctrl+A/X/Z/Y all work, then send via Ctrl+Enter. The full text
// is forwarded to the tab's xterm as a single bracketed paste + Enter — no
// keystroke-by-keystroke simulation, so IME, newlines, and unicode all round-
// trip correctly.
//
// Image paste behavior: pasted images are saved to a temp file via Rust, and
// the absolute path is inserted directly into the textarea as plain text at
// the cursor position. The attachment row above the input derives from those
// editable path strings. AI CLI agents that support local image paths (e.g.
// Claude Code) will read the file; agents that don't just see the raw path.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { isWorktreePending } from '../../lib/worktree-pending';
import { createPortal } from 'react-dom';
import { clipboardRead, clipboardWrite } from '../../lib/clipboard';
import { subscribeGambitHistory, getGambitHistorySnapshot, pushGambitHistory } from '../../lib/gambit-history';
import { commands, invoke } from '../../tauri';
import { useT } from '../../i18n/useT';
import { useAppState } from '../../store/app-state';
import { registerFileDropTarget, formatPathsForInsert } from '../../lib/file-drop';
import { bindAutoHideScrollbar } from '../../lib/auto-hide-scrollbar';
import { ClaudeComposerControls, AttachIcon } from './ClaudeComposerControls';
import { CodexComposerControls } from './CodexComposerControls';
import { OpenCodeComposerControls } from './OpenCodeComposerControls';
import { PiComposerControls } from './PiComposerControls';
import { DshComposerControls } from './DshComposerControls';
import { UsageMeter } from './UsageMeter';
import { useUsageQuota } from '../../lib/usage-quota';
import { gambitAttachments, removeGambitAttachment } from '../../lib/gambit-attachments';
import './Gambit.css';
import { fileToBase64 } from '../../lib/answer-image-paste';

interface GambitProps {
  sessionId: string;
  draft: string;
  onDraftChange: (text: string) => void;
  onClose: () => void;
  /** Returns true when the text was accepted by the target xterm, false
   *  when the send couldn't complete (no active session, pane not focused
   *  in multi-agent mode, xterm not yet mounted, etc.). Gambit uses this
   *  signal to decide whether to clear the draft — failed sends preserve
   *  the text so the user never loses what they typed. */
  onSend: (text: string) => boolean | Promise<boolean>;
  running?: boolean;
  claude?: boolean;
  /** The agent's guess at the next prompt, offered while the composer is empty; Tab takes it. */
  suggestion?: string;
  codex?: boolean;
  /** DeepSeek Harness desktop conversation (always desktop in Coffee CLI). */
  dsh?: boolean;
  /** OpenCode desktop conversation. */
  opencode?: boolean;
  /** Pi desktop conversation. */
  pi?: boolean;
  /** Local file paths are meaningful to this target (false for SSH tabs). */
  attachable?: boolean;
  onCancel?: () => void;
  sendFailedHint?: string;
  /** Whether the left/right side panels are currently hidden. When Gambit
   *  is docked at the bottom it spans the center panel only, so we need
   *  to know which sides are absent to compute the inset offsets. */
  leftPanelHidden: boolean;
  rightPanelHidden: boolean;
  /** The active tab's Send target label: working-folder basename for local
   *  sessions, connection host for SSH/WebSocket. Rendered in the footer;
   *  switching tabs updates it. '' hides the label. */
  workspaceName: string;
  /** The active tab's tool glyph — same icon its chrome-tab shows. Rendered
   *  left of the target name so the chip reads as "tool + target",
   *  mirroring the tab's icon+name pairing. undefined hides the icon. */
  toolIcon?: React.ReactNode;
  /** Active tab's tool id and folder; the plan-usage meter reads the tool's own configuration. */
  tool?: string;
  cwd?: string;
  orchestration?: boolean;
  computer?: boolean;
  browser?: boolean;
  /** Controls beside the target label: the worktree switch for desktop conversations, New chat for Super Assistant. */
  worktreeControl?: React.ReactNode;
  /** Optional channel-connection badge rendered immediately after the target
   *  label (Super Assistant uses it for the WeChat link status). */
  channelBadge?: React.ReactNode;
}

// Matches any absolute image path inside the compose draft — both our
// own temp-dir clip images AND user-typed paths like
//   说看看图片"C:\Users\eben\Desktop\hermes.png"
//   cat /home/me/screenshot.jpg
// Requires a drive letter (Win) or leading slash (POSIX) so we don't
// false-positive on bare filenames mentioned in prose like ".png 格式".
// Excludes quotes and whitespace from the match body so surrounding
// `"..."` wrappers self-strip; if a path has spaces in a directory
// name, it won't match — edge case we accept.
const IMAGE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

// Wrap every bare image path with `" ... "` (leading / trailing space
// inside the quotes) on the way out to the PTY. Why: when a path sits at
// the end of a paste, Claude/Codex async-attach the image from disk while
// Gambit schedules the trailing CR 150 ms later — the attach frequently
// takes longer than 150 ms, so by the time `\r` lands the visible path has
// been replaced by a placeholder but the attachment isn't ready, and the
// path silently drops out of the submission. Wrapping inserts buffer
// characters after the path and a clean delimiter the upstream CLI can
// use, defeating the race deterministically. We do NOT mutate the draft —
// the wrap is applied only at send time so the textarea stays clean and
// undo/edit feels natural. IMAGE_PATH_RE excludes quotes from its match
// body, so even paths the user typed already inside quotes match (and we
// skip them via the adjacency check below to avoid double-wrapping).
function wrapImagePathsForSend(text: string): string {
  return text.replace(IMAGE_PATH_RE, (match, offset: number, full: string) => {
    const prev = offset > 0 ? full[offset - 1] : '';
    const next = full[offset + match.length] || '';
    if (prev === '"' || next === '"') return match;
    return `" ${match} "`;
  });
}

// Read a Blob as a bare base64 string (no data: prefix).
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read audio'));
    reader.readAsDataURL(blob);
  });
}

// Thrown when a recording contains no voice-level audio, so transcription is
// skipped entirely and the UI shows a localized "no voice detected" message.
class VoiceNoInputError extends Error {
  constructor() { super('NO_VOICE_INPUT'); this.name = 'VoiceNoInputError'; }
}

// Decode recorded audio (WebM/Opus or WAV) and re-encode it as a 16 kHz mono
// 16-bit PCM WAV. Whisper-compatible services often accept the WebM container
// but decode its Opus audio to nothing (empty `text`), so WAV is the reliable
// interchange format. Resampling is a hand-written linear interpolation rather
// than OfflineAudioContext, which produced empty buffers in WebView2.
async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) throw new Error('Audio decoding is not supported');
  const ctx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('Could not decode the recording');
  } finally {
    if (ctx.state !== 'closed') void ctx.close().catch(() => {});
  }
  const targetRate = 16000;
  // Mix down to mono by averaging all channels, then linearly resample.
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const srcLength = decoded.length;
  const srcRate = decoded.sampleRate;
  const outLength = Math.max(1, Math.round(srcLength * targetRate / srcRate));
  const samples = new Float32Array(outLength);
  let peak = 0;
  let energy = 0;
  const ratio = srcRate / targetRate;
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(srcLength - 1, i0 + 1);
    const frac = pos - i0;
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      const ch = channels[c];
      sum += (ch[i0] ?? 0) * (1 - frac) + (ch[i1] ?? 0) * frac;
    }
    const v = sum / channels.length;
    samples[i] = v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    energy += v * v;
  }
  // If the clip carries no voice-level activity, don't bother the model — a
  // silent/room-noise recording would just come back as empty text. RMS is used
  // (not peak) so a single stray click doesn't pass as speech. Threshold sits
  // just above typical mic noise floor.
  const rms = Math.sqrt(energy / outLength);
  if (peak < 0.002 || rms < 0.004) {
    throw new VoiceNoInputError();
  }
  // 44-byte RIFF header + PCM16 body.
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Docked height: Gambit lives flush at the bottom of the center panel.
// Height is user-resizable via the top edge and persists across sessions,
// mirroring how VS Code's bottom panel works.
const DOCK_MIN_HEIGHT = 120;
const DOCK_MAX_HEIGHT_RATIO = 0.7; // never let the dock eat more than 70% of viewport height
const DOCK_AUTO_HEIGHT_RATIO = 0.5; // a long draft stops lifting the dock here and scrolls instead
const LS_DOCK_H = 'cc-gambit-dock-h';

function GambitImpl({
  sessionId,
  draft,
  onDraftChange,
  onClose,
  onSend,
  running = false,
  suggestion: offered,
  claude = false,
  codex = false,
  dsh = false,
  opencode = false,
  pi = false,
  attachable = false,
  onCancel,
  sendFailedHint,
  leftPanelHidden,
  rightPanelHidden,
  workspaceName,
  toolIcon,
  tool,
  cwd,
  orchestration,
  computer,
  browser,
  worktreeControl,
  channelBadge,
}: GambitProps) {
  const t = useT();
  // Desktop conversations own their composer controls and send prompts verbatim.
  const desktop = claude || codex || dsh || opencode || pi;
  // Every desktop conversation accepts prompts during a running turn.
  const steerable = claude || codex || dsh || opencode || pi;
  const usage = useUsageQuota(sessionId, tool, cwd, claude ? 'claude' : codex ? 'codex' : dsh ? 'dsh' : null);
  const usageMeter = <UsageMeter quotas={usage.quotas} onRefresh={usage.refresh} />;
  const suggestion = draft ? undefined : offered;
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // When the IME composition ended, for the Enter that confirms a candidate (see onKeyDown).
  const compositionEndRef = useRef(0);
  const claudeKeyHandler = useRef<((event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean) | undefined>(undefined);
  const codexSubmitHandler = useRef<((text: string) => boolean) | undefined>(undefined);
  const sendingRef = useRef(false);
  const latestDraftRef = useRef(draft);
  latestDraftRef.current = draft;
  // The scroll container that owns the vertical scrollbar (the textarea itself
  // is overflow:hidden and auto-grows to its full content height). We need a
  // handle to it so the auto-grow effect can preserve / follow its scrollTop.
  const inputRef = useRef<HTMLDivElement>(null);
  // The draft value the auto-grow effect last sized for. Lets it tell a real
  // content edit (typing / paste) from a non-content trigger (window resize)
  // so only the former is allowed to move the scroll position.
  const lastSizedDraftRef = useRef(draft);

  // ─── Prompt history (↑/↓ recall) ──────────────────────────────────
  // Global, localStorage-persisted, shared across every tab's Gambit
  // (see lib/gambit-history.ts). The navigation cursor + the in-progress
  // draft saved on first ↑ are this instance's interaction state — they
  // reset when the user switches tabs (Gambit unmounts), which is fine:
  // nobody is mid-recall across a tab switch.
  const history = useSyncExternalStore(subscribeGambitHistory, getGambitHistorySnapshot);
  // Index into `history` while navigating, or null at the live prompt.
  // When ↓ scrolls PAST the newest entry the cursor returns to null and we
  // restore `savedDraftRef` — the text the user was typing before they
  // pressed ↑ — standard shell/REPL behavior so you never lose a half-typed
  // prompt by peeking at history.
  const historyCursorRef = useRef<number | null>(null);
  const savedDraftRef = useRef('');
  // Mutations to `draft` that come from history navigation itself set this
  // flag so the effect below knows to leave the cursor alone. Every OTHER
  // draft change (typing, paste, file-drop, cut) ends navigation mode by
  // clearing the cursor — a single, mutation-path-agnostic reset point.
  const isNavMutationRef = useRef(false);
  useEffect(() => {
    if (isNavMutationRef.current) { isNavMutationRef.current = false; return; }
    historyCursorRef.current = null;
  }, [draft]);

  // Docked height (px), user-resizable via the top-edge handle. Persists.
  const [dockedH, setDockedH] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(LS_DOCK_H);
      const n = raw ? parseInt(raw, 10) : NaN;
      if (Number.isFinite(n) && n >= DOCK_MIN_HEIGHT) return n;
    } catch { /* optional preference */ }
    return DOCK_MIN_HEIGHT;
  });
  // Height the draft needs. The dragged height stays the floor, so clearing the draft returns to it.
  const [contentH, setContentH] = useState(0);
  const effectiveH = Math.max(dockedH, contentH);
  // Caches the latest height written to the DOM during a resize drag, so
  // onUp commits it back to React state once without thrashing intermediate
  // renders. Null when no resize is in progress.
  const dockResizeRef = useRef<{ startY: number; origH: number; lastH?: number; handle?: HTMLElement } | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // A mouse click on a footer control or its menu leaves the caret in the draft, so Enter still sends instead of
  // pressing that control again. Only the mouse: tabbing to a control still focuses it.
  useEffect(() => {
    const keepCaret = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.('button')?.closest('.gambit-footer, .claude-control-menu')) return;
      e.preventDefault();
      if (!document.querySelector('.claude-control-menu')) textareaRef.current?.focus();
    };
    document.addEventListener('mousedown', keepCaret, true);
    return () => document.removeEventListener('mousedown', keepCaret, true);
  }, []);

  // Floating scrollbar for the input box. A long draft's scroll owner is
  // .gambit-input (the textarea auto-grows and stays overflow:hidden), and
  // native scrollbars are hidden globally (global.css) — WebView2 can't drop
  // its up/down arrow buttons via CSS (same fix as the note panel). Bind the
  // same floating DOM slider here so the overflow scrolls with a visible,
  // auto-fading, draggable accent bar and no arrows. slim matches the note
  // body's slider; no inset needed — the input box already sits between the
  // top resize strip and the footer, so its rect excludes both.
  useEffect(() => {
    const scroller = inputRef.current;
    if (!scroller) return;
    return bindAutoHideScrollbar(scroller, { slim: true });
  }, []);

  // ─── Docked layout side effect ───────────────────────────────
  // Set a body class + CSS var so .panel-center reserves padding-bottom
  // equal to the dock height. The xterm container's ResizeObserver picks
  // up the shrink and refits. Cleared on unmount.
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    body.classList.add('gambit-docked');
    root.style.setProperty('--gambit-dock-h', `${effectiveH}px`);
    return () => {
      body.classList.remove('gambit-docked');
      root.style.removeProperty('--gambit-dock-h');
    };
  }, [effectiveH]);

  // Persist dock height. Cheap to write — runs only on settle.
  useEffect(() => {
    try { localStorage.setItem(LS_DOCK_H, String(dockedH)); } catch { /* optional preference */ }
  }, [dockedH]);

  // Top-edge vertical drag to resize dock height (constrained to the Y axis).
  const onDockResizeStart = (e: React.MouseEvent) => {
    const handle = e.currentTarget as HTMLElement;
    // Toggle a `resizing` class directly on the DOM node (NOT React state):
    // the drag writes `el.style.height` live on every mousemove, and a React
    // re-render would reset it from the stale `dockedH` prop mid-drag. The
    // class only drives the grip bar's grow/deepen animation.
    handle.classList.add('resizing');
    dockResizeRef.current = {
      startY: e.clientY,
      origH: effectiveH,
      handle,
    };
    e.preventDefault();
    e.stopPropagation();
  };
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dockResizeRef.current) return;
      const r = dockResizeRef.current;
      // Drag UP increases height (dock grows upward), drag DOWN shrinks.
      const dy = r.startY - e.clientY;
      const maxH = Math.floor(window.innerHeight * DOCK_MAX_HEIGHT_RATIO);
      const next = Math.max(DOCK_MIN_HEIGHT, Math.min(r.origH + dy, maxH));
      r.lastH = next;
      const el = rootRef.current;
      if (el) el.style.height = `${next}px`;
      // Update CSS var live so xterm refits during drag, not just on release.
      document.documentElement.style.setProperty('--gambit-dock-h', `${next}px`);
    };
    const onUp = () => {
      if (dockResizeRef.current?.lastH !== undefined) {
        setDockedH(dockResizeRef.current.lastH);
      }
      dockResizeRef.current?.handle?.classList.remove('resizing');
      dockResizeRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // Thumbnails are a pure derived view of the draft text — no separate
  // attachment state. User edits/deletes the path string → thumbnails
  // update automatically. Paths remain the only source of truth; they
  // travel with the text through copy/paste/send.
  const attachments = useMemo(() => Array.from(new Map(gambitAttachments(draft).map(item => [item.path, item])).values()), [draft]);
  const pastedImagePaths = useMemo(() => attachments.filter(item => item.image).map(item => item.path), [attachments]);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});
  // Use a stable key so the effect only re-fires when the set of paths
  // actually changes, not on every keystroke that leaves paths intact.
  const pastedImagePathsKey = pastedImagePaths.join('\n');
  useEffect(() => {
    if (pastedImagePaths.length === 0) {
      setThumbUrls({});
      return;
    }
    let cancelled = false;
    import('@tauri-apps/api/core').then(({ convertFileSrc }) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const p of pastedImagePaths) next[p] = convertFileSrc(p);
      setThumbUrls(next);
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pastedImagePathsKey]);

  // ── File-drop target ────────────────────────────────────────────────────
  // OS file drops over the Gambit window insert the absolute path(s) at the
  // textarea cursor — same model as image-paste (see header comment): paths
  // are the only source of truth, thumbnails derive from IMAGE_PATH_RE.
  // Priority outranks the terminal so a drop over a Gambit overlapping it
  // routes here, not into the xterm behind.
  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);
  const insertPaths = useCallback((paths: string[]) => {
    const formatted = formatPathsForInsert(paths);
    const textarea = textareaRef.current;
    const cur = draftRef.current;
    const start = textarea?.selectionStart ?? cur.length;
    const end = textarea?.selectionEnd ?? cur.length;
    const next = cur.slice(0, start) + formatted + cur.slice(end);
    onDraftChangeRef.current(next);
    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      textarea.selectionStart = start + formatted.length;
      textarea.selectionEnd = start + formatted.length;
    });
  }, []);
  useEffect(() => registerFileDropTarget({ priority: 200, rect: () => rootRef.current?.getBoundingClientRect() ?? null, insert: insertPaths }), [insertPaths]);
  // Picked files insert exactly like dropped ones: at the caret, quoted only when needed.
  const attachFiles = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true, directory: false });
    if (picked) insertPaths(Array.isArray(picked) ? picked : [picked]);
  };

  // Click a thumbnail → open a full-size preview overlay AND select the
  // matching path text in the textarea (so once the overlay closes, the
  // caret is conveniently placed at the path for easy Backspace-delete).
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const removeAttachment = (path: string) => {
    onDraftChange(removeGambitAttachment(latestDraftRef.current, path));
    if (previewPath === path) setPreviewPath(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const openThumbPreview = (path: string) => {
    setPreviewPath(path);
    const textarea = textareaRef.current;
    if (!textarea) return;
    const idx = draft.indexOf(path);
    if (idx < 0) return;
    textarea.setSelectionRange(idx, idx + path.length);
  };
  // ESC or click-outside dismisses the overlay.
  useEffect(() => {
    if (!previewPath) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewPath(null); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [previewPath]);

  // sendFailed briefly flashes a subtle hint next to the Send button so
  // the user understands WHY nothing happened (most common cause in
  // multi-agent mode: no pane has been focused yet — a single click on
  // the intended pane fixes it). Auto-clears after 2.5s so it doesn't
  // linger once the user acts.
  const [sendFailed, setSendFailed] = useState(false);
  const [sendEmpty, setSendEmpty] = useState(false);
  useEffect(() => {
    if (!sendFailed) return;
    const t = setTimeout(() => setSendFailed(false), 2500);
    return () => clearTimeout(t);
  }, [sendFailed]);
  useEffect(() => {
    if (!sendEmpty) return;
    const t = setTimeout(() => setSendEmpty(false), 2500);
    return () => clearTimeout(t);
  }, [sendEmpty]);

  const { state: appState } = useAppState();

  // ─── Voice input (mic button left of Send) ─────────────────────
  // Push-to-talk: click once to start recording, click again to stop and
  // transcribe. The transcript is appended to the draft (space-separated),
  // so it behaves exactly like typed input and can be edited before sending.
  const [voiceState, setVoiceState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [voiceFailed, setVoiceFailed] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  const [voiceNoInput, setVoiceNoInput] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingActiveRef = useRef(false);
  const mimeTypeRef = useRef<string>('audio/webm');
  // Cancel flag: when the user discards a recording with ×, onstop must not
  // transcribe — it should drop the captured chunks instead.
  const voiceCancelledRef = useRef(false);
  // Live waveform: an AnalyserNode taps the mic stream while recording; a
  // requestAnimationFrame loop writes per-bar heights straight to the DOM
  // (refs, not React state) so 60fps animation never re-renders Gambit.
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const waveformBarsRef = useRef<Array<HTMLSpanElement | null>>([]);
  const rafRef = useRef<number | null>(null);
  const waveformLevelsRef = useRef<number[]>([]);
  const WAVEFORM_BARS = 28;
  // Voice-activity timing. `heardVoiceRef` flips true once speech is detected.
  // Started → if still silent after AUTO_CLOSE_SILENT_MS, cancel (never send).
  // Heard speech → after AUTO_FINISH_SILENT_MS of silence, stop and transcribe
  //                the text into the input box (the user sends it themselves).
  const heardVoiceRef = useRef(false);
  const silentMsRef = useRef(0);        // consecutive silence accumulated
  const recordedMsRef = useRef(0);      // elapsed recording time since start
  const lastTickRef = useRef(0);
  const AUTO_CLOSE_SILENT_MS = 3000;
  const AUTO_FINISH_SILENT_MS = 1000;
  const MAX_CLIP_SECONDS = 180;
  // Hooks the waveform loop calls when the silence timers fire. Assigned below
  // once cancelVoice/finishVoice exist (they need the refs above, so a ref
  // avoids a circular useCallback dependency).
  const voiceHooksRef = useRef<{ onAutoClose: () => void; onAutoFinish: () => void }>({
    onAutoClose: () => {},
    onAutoFinish: () => {},
  });
  const stopWaveform = useCallback(() => {
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    analyserRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') { void ctx.close().catch(() => {}); }
  }, []);
  useEffect(() => {
    if (!voiceFailed) return;
    const t = setTimeout(() => setVoiceFailed(false), 2500);
    return () => clearTimeout(t);
  }, [voiceFailed]);
  useEffect(() => () => {
    // Clean up any active capture on unmount so the mic is never left on.
    recordingActiveRef.current = false;
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== 'closed') { void ctx.close().catch(() => {}); }
  }, []);
  // Whether the WebView supports media capture at all (WebView2/Safari do;
  // some embedded contexts disable it). Hides the button when unavailable.
  const voiceSupported = typeof MediaRecorder !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  // Tap the mic stream and paint a live bar waveform. Each bar is smoothed
  // toward the current audio level (fast attack, slow release) for an organic
  // "voice recording" feel rather than a jittery equalizer.
  const startWaveform = useCallback((stream: MediaStream) => {
    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const levels = waveformLevelsRef.current;
      if (levels.length !== WAVEFORM_BARS) levels.length = WAVEFORM_BARS;
      heardVoiceRef.current = false;
      silentMsRef.current = 0;
      recordedMsRef.current = 0;
      lastTickRef.current = performance.now();
      const tick = () => {
        const node = analyserRef.current;
        if (!node) return;
        node.getByteTimeDomainData(data);
        // RMS of the time-domain waveform → 0..1 loudness.
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        // Noise gate: below this level we treat the mic as silent so the bars
        // rest flat instead of twitching to room noise. Above it, map the
        // loudness to 0..1 so real speech drives the animation.
        const GATE = 0.012;
        const raw = Math.max(0, (rms - GATE) / (1 - GATE));
        const level = Math.min(1, Math.pow(raw, 0.8) * 1.6);
        const bars = waveformBarsRef.current;
        const now = performance.now();
        // Voice-activity bookkeeping, independent of the decorative bars.
        // Speech counts as heard at level ≥ 0.06; otherwise we accumulate
        // silence and fire the auto-close / auto-finish timers.
        const dt = now - lastTickRef.current;
        lastTickRef.current = now;
        recordedMsRef.current += dt;
        // Long-audio limit of the async adapter: unisound itself allows 5 h,
        // but polling only waits MAX_CLIP_SECONDS (180 s). Finish and transcribe
        // at that point rather than recording audio that will time out.
        if (recordingActiveRef.current && heardVoiceRef.current && recordedMsRef.current >= MAX_CLIP_SECONDS * 1000) {
          voiceHooksRef.current.onAutoFinish();
          return;
        }
        if (level >= 0.06) {
          heardVoiceRef.current = true;
          silentMsRef.current = 0;
        } else {
          silentMsRef.current += dt;
        }
        if (heardVoiceRef.current) {
          if (silentMsRef.current >= AUTO_FINISH_SILENT_MS) { void voiceHooksRef.current.onAutoFinish(); return; }
        } else if (silentMsRef.current >= AUTO_CLOSE_SILENT_MS) {
          void voiceHooksRef.current.onAutoClose();
          return;
        }
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          let target: number;
          if (level < 0.02) {
            // Silent: everything settles to a flat line.
            target = 0;
          } else {
            // Speech: vary bar heights per index so the shape ripples with the
            // amplitude, biased toward the centre like the reference.
            const center = 1 - Math.abs(i - (WAVEFORM_BARS - 1) / 2) / ((WAVEFORM_BARS - 1) / 2);
            const wobble = 0.5 + 0.5 * Math.sin(now / 70 + i * 0.9);
            target = Math.max(0, Math.min(1, level * (0.35 + center * 0.4) * (0.55 + wobble * 0.45)));
          }
          const prev = levels[i] ?? 0;
          // Fast attack, slow release; snap to rest when silent.
          levels[i] = target > prev ? prev + (target - prev) * 0.6 : prev + (target - prev) * (level < 0.02 ? 0.35 : 0.2);
          const bar = bars[i];
          if (bar) bar.style.transform = `scaleY(${(0.06 + levels[i] * 0.94).toFixed(3)})`;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Waveform is decorative only — recording still works without it.
      stopWaveform();
    }
  }, [stopWaveform]);
  const transcribeChunks = useCallback(async (chunks: Blob[], mimeType: string) => {
    if (chunks.length === 0) { setVoiceState('idle'); setVoiceError('No audio was recorded'); setVoiceFailed(true); return; }
    setVoiceState('transcribing');
    try {
      // Decode the recorder's WebM/Opus and re-encode as 16 kHz mono WAV.
      // Many whisper-compatible services read the WebM container duration but
      // fail to decode its Opus audio (they return `text: ""`), so WAV is the
      // reliable interchange format. Decoding + resampling is done manually so
      // it doesn't depend on OfflineAudioContext quirks in WebView2.
      const source = new Blob(chunks, { type: mimeType });
      const wav = await blobToWav(source);
      const audioBase64 = await blobToBase64(wav);
      const text = await invoke<string>('agent_transcribe', { audioBase64, mimeType: 'audio/wav' });
      const trimmed = text.trim();
      // Append to whatever the user already drafted (space-separated). The
      // user reviews and sends it themselves — voice input never auto-sends.
      if (trimmed) {
        const current = draftRef.current;
        onDraftChangeRef.current(current.trim() ? `${current.trim()} ${trimmed}` : trimmed);
      }
    } catch (err) {
      // A silent clip never reaches the model — show a clear "no voice" message.
      if (err instanceof VoiceNoInputError) {
        setVoiceError('');
        setVoiceNoInput(true);
        setVoiceFailed(true);
        return;
      }
      console.error('[Gambit] voice transcription failed', err);
      setVoiceError(err instanceof Error ? err.message : String(err));
      setVoiceFailed(true);
    } finally {
      setVoiceState('idle');
    }
  }, []);
  const toggleVoice = useCallback(async () => {
    if (recordingActiveRef.current) {
      // Stop recording -> the recorder's onstop handler transcribes.
      recordingActiveRef.current = false;
      stopWaveform();
      try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
      return;
    }
    // Start recording.
    setVoiceFailed(false);
    setVoiceError('');
    setVoiceNoInput(false);
    const recorderType = (() => {
      if (typeof MediaRecorder === 'undefined') return null;
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/wav', 'audio/mp4'];
      return candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? null;
    })();
    if (!recorderType) { setVoiceFailed(true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      mimeTypeRef.current = recorderType.split(';')[0];
      audioChunksRef.current = [];
      voiceCancelledRef.current = false;
      const recorder = new MediaRecorder(stream, { mimeType: recorderType });
      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };
      recorder.onstop = () => {
        // Release the mic regardless of transcription outcome.
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        stopWaveform();
        const chunks = audioChunksRef.current;
        audioChunksRef.current = [];
        const cancelled = voiceCancelledRef.current;
        voiceCancelledRef.current = false;
        recordingActiveRef.current = false;
        // Always return the UI to idle — this is what makes × actually close.
        if (cancelled) { setVoiceState('idle'); return; }
        void transcribeChunks(chunks, mimeTypeRef.current);
      };
      recordingActiveRef.current = true;
      setVoiceState('recording');
      startWaveform(stream);
      // Emit a chunk every 250 ms so audio is captured incrementally even if
      // the final flush is missed (WebView2 occasionally drops the single
      // on-stop blob, which surfaced as an empty recording).
      recorder.start(250);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      stopWaveform();
      setVoiceState('idle');
      setVoiceFailed(true);
    }
  }, [transcribeChunks, startWaveform, stopWaveform]);
  // Discard the current recording without transcribing (the × button, and the
  // "3 s of silence after start" auto-close).
  const cancelVoice = useCallback(() => {
    if (!recordingActiveRef.current) return;
    voiceCancelledRef.current = true;
    recordingActiveRef.current = false;
    audioChunksRef.current = [];
    stopWaveform();
    setVoiceState('idle');
    try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
  }, [stopWaveform]);
  // Finish the current recording and transcribe it into the input box (auto-
  // finish after 1 s of silence once speech was heard). The text is written
  // into the draft; sending stays a deliberate user action.
  const finishVoice = useCallback(() => {
    if (!recordingActiveRef.current) return;
    voiceCancelledRef.current = false;
    recordingActiveRef.current = false;
    stopWaveform();
    try { mediaRecorderRef.current?.stop(); } catch { /* already stopped */ }
  }, [stopWaveform]);
  useEffect(() => {
    voiceHooksRef.current = { onAutoClose: cancelVoice, onAutoFinish: finishVoice };
  }, [cancelVoice, finishVoice]);
  // Alt key toggles voice input: start recording when idle, cancel when recording.
  // Ignore Alt held together with other modifiers (Alt+Tab, Alt+F4, AltGr text
  // entry) and auto-repeat. Only the composer's own window reacts.
  useEffect(() => {
    if (!voiceSupported) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || e.repeat || e.ctrlKey || e.metaKey || e.shiftKey) return;
      // AltGr reports as Alt+Ctrl on Windows; guarded above. Skip when typing
      // in a different field or a modal/menu is open.
      const target = e.target as HTMLElement | null;
      if (target && target !== textareaRef.current && (target.closest('input, textarea, [contenteditable="true"]'))) return;
      if (document.querySelector('.claude-control-menu')) return;
      if (voiceState === 'transcribing') return;
      e.preventDefault();
      if (voiceState === 'recording') cancelVoice();
      else void toggleVoice();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [voiceSupported, voiceState, cancelVoice, toggleVoice]);

  // Auto-grow the textarea to fit its content as the user types.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const scroller = inputRef.current;
    // Did this run come from an actual content edit (typing / paste), or from
    // a window resize? Only a content edit may move the scroll position; a
    // resize must hold the view exactly where the user left it (even if the
    // caret happens to be parked at the very end).
    const contentChanged = lastSizedDraftRef.current !== draft;
    lastSizedDraftRef.current = draft;
    const prevScrollTop = scroller?.scrollTop ?? 0;
    // Auto-grow: collapse to remeasure, then fit the box to its content.
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    if (!scroller) return;
    const dock = rootRef.current;
    if (dock) setContentH(Math.min(dock.offsetHeight - scroller.clientHeight + ta.scrollHeight, Math.floor(window.innerHeight * DOCK_AUTO_HEIGHT_RATIO)));
    // Remeasuring via height:'auto' momentarily collapses the (rows=1) textarea
    // for the synchronous reflow that reading scrollHeight forces; while
    // collapsed the scroll container has almost no content, so the browser
    // clamps its scrollTop to 0 and the clamp sticks once the real height is
    // restored. Re-applying the captured scrollTop undoes that — it's the cure
    // for the "every keystroke jumps the view back to the top" bug. When the
    // user is actively typing at
    // the very end of the draft, follow the caret to the bottom instead so the
    // newest line stays visible.
    //   Known gap: an edit that pushes a MID-text caret below the fold is not
    //   chased (we just hold position) - doing so would need caret-pixel
    //   measurement, which is out of scope here. Still strictly better than
    //   the old jump-to-top, so accepted.
    const followCaretToBottom =
      contentChanged &&
      document.activeElement === ta &&
      ta.selectionStart === ta.value.length &&
      ta.selectionEnd === ta.value.length;
    scroller.scrollTop = followCaretToBottom ? scroller.scrollHeight : prevScrollTop;
  }, [draft]);


  // ─── Context menu ─────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  const ctxMod = isMac ? '⌘' : 'Ctrl';
  // Send/newline key labels for the placeholder hint — track the user's
  // configured send mode (settings → 妙手) so the hint never lies.
  const sendCombo = appState.gambitEnterToSend ? 'Enter' : `${ctxMod}+Enter`;
  const newlineCombo = appState.gambitEnterToSend ? 'Shift+Enter' : 'Enter';

  // Windows-style dismiss: ANY interaction outside the menu closes it.
  //   - mousedown anywhere outside  → close (click inside runs the button's onClick)
  //   - Escape key                  → close
  //   - wheel scroll                → close (native OS behavior)
  //   - window blur / resize        → close
  //
  // All listeners are registered in CAPTURE phase so we still fire even
  // though the Gambit root has onMouseDown={e=>e.stopPropagation()} up the
  // React tree (it's synthetic-only, but capture-phase native listeners
  // are immune to any propagation shenanigans either way).
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onDocMouseDown = (e: MouseEvent) => {
      // Click inside the menu → let the button's onClick handler run and
      // close the menu itself. Only dismiss for clicks OUTSIDE.
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    const onWheel = () => close();
    document.addEventListener('mousedown', onDocMouseDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('wheel', onWheel, { capture: true, passive: true });
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('wheel', onWheel, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [ctxMenu]);

  // Bound to the whole .gambit-input box, not just the textarea. Docked
  // Gambit stretches the box (flex:1) while the textarea is only as tall as
  // its content, so right-clicking the empty area below line 1 used to land
  // on the container — no handler, no menu, just the root's preventDefault.
  // Left-click already routed anywhere-in-the-box to the textarea (see the
  // container's onMouseDown); right-click now matches.
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const ta = textareaRef.current;
    const hasSelection = !!ta && (ta.selectionStart ?? 0) !== (ta.selectionEnd ?? 0);
    setCtxMenu({ x: e.clientX, y: e.clientY, hasSelection });
  };

  const ctxCopy = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = draft.slice(start, end);
    if (selected) clipboardWrite(selected);
    setCtxMenu(null);
  };

  const ctxCut = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const selected = draft.slice(start, end);
    if (selected) {
      clipboardWrite(selected);
      const newDraft = draft.slice(0, start) + draft.slice(end);
      onDraftChange(newDraft);
      requestAnimationFrame(() => {
        textarea.selectionStart = start;
        textarea.selectionEnd = start;
      });
    }
    setCtxMenu(null);
  };

  const ctxPaste = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    setCtxMenu(null);
    clipboardRead().then((text) => {
      if (!text) return;
      const start = textarea.selectionStart ?? draft.length;
      const end = textarea.selectionEnd ?? draft.length;
      const newDraft = draft.slice(0, start) + text + draft.slice(end);
      onDraftChange(newDraft);
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = start + text.length;
        textarea.selectionEnd = start + text.length;
      });
    });
  };

  const ctxSelectAll = () => {
    const textarea = textareaRef.current;
    if (!textarea) { setCtxMenu(null); return; }
    textarea.focus();
    textarea.select();
    setCtxMenu(null);
  };

  // ─── History navigation ──────────────────────────────────────────
  // Walk the global prompt history (lib/gambit-history.ts) with ↑/↓.
  //   • First ↑ from the live prompt: save the in-progress draft and jump
  //     to the newest entry. Subsequent ↑ moves toward older entries.
  //   • ↓ moves toward newer entries; scrolling past the newest restores
  //     the saved in-progress draft (so peeking at history never costs
  //     you the half-typed prompt you were working on).
  //   • ↑ at the oldest / ↓ at the newest is a no-op (cursor clamps).
  // Returns false for no-ops so onKeyDown can leave native caret movement
  // untouched when there's nothing to recall.
  const navigateHistory = useCallback((direction: -1 | 1): boolean => {
    const hist = history;
    const cur = historyCursorRef.current;
    let next: number | null;
    let text: string;
    if (cur === null) {
      // Entering history mode from the live prompt.
      if (direction === 1) return false;     // already at newest — ↓ no-op
      if (hist.length === 0) return false;    // nothing to recall
      next = hist.length - 1;                 // newest entry
      savedDraftRef.current = draft;          // stash what the user was typing
      text = hist[next];
    } else {
      const cand = cur + direction;
      if (cand < 0) return false;             // already at oldest — ↑ clamps
      if (cand >= hist.length) {              // scrolled past newest
        next = null;
        text = savedDraftRef.current;         // restore the in-progress draft
      } else {
        next = cand;
        text = hist[cand];
      }
    }
    historyCursorRef.current = next;
    // Flag this onDraftChange as navigation-driven so the [draft] effect
    // doesn't immediately exit history mode (which would reset the cursor
    // we just set).
    isNavMutationRef.current = true;
    onDraftChange(text);
    // Park the caret at the end of the recalled text so typing continues
    // from the tail — matches shell recall UX. Runs after React commits
    // the controlled value (same rAF pattern as ctxPaste).
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = text.length;
      ta.selectionEnd = text.length;
    });
    return true;
  }, [history, draft, onDraftChange]);

  const handleSend = useCallback(async () => {
    if (running && !steerable) return;
    // A worktree on its way would move the conversation; the message waits in the box until it is ready.
    if (isWorktreePending(sessionId)) return;
    // CRITICAL: the draft text is the ONLY thing that gets sent.
    // Thumbnails rendered from pastedImagePaths are a pure derived view
    // with zero data-side responsibility. DO NOT re-append paths or
    // attach image bytes here — the path already sits inside `draft` and
    // would be sent twice, making the AI see the same image reference
    // duplicated in its prompt.
    const text = draft.trim();
    if (!text) {
      setSendEmpty(true);
      return;
    }
    if ((codex || dsh || opencode || pi) && codexSubmitHandler.current?.(text)) return;
    const body = desktop ? text : wrapImagePathsForSend(text);
    if (sendingRef.current) return;
    sendingRef.current = true;
    let ok = false;
    try { ok = await onSend(body); } finally { sendingRef.current = false; }
    if (!ok) {
      // Preserve draft so the user does not lose what they typed. They
      // likely just need to click the target pane first, then Send again.
      setSendFailed(true);
      return;
    }
    // Record the user prompt so recall shows what they actually typed.
    pushGambitHistory(text);
    // Sent -> leave history navigation mode so the next recall starts from
    // the newest entry (which is the one we just pushed).
    historyCursorRef.current = null;
    if (latestDraftRef.current === draft) onDraftChange('');
  }, [draft, onSend, onDraftChange, running, steerable, codex, dsh, opencode, pi, desktop, sessionId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition in progress — let the IME keep Enter for confirming
    // candidates. nativeEvent.isComposing is the canonical flag.
    if (e.nativeEvent.isComposing) return;
    // macOS WebKit ends the composition before the confirming Enter's keydown, so isComposing is already false there.
    // That keydown still carries keyCode 229, and it lands right after compositionend.
    if (e.key === 'Enter' && (e.nativeEvent.keyCode === 229 || performance.now() - compositionEndRef.current < 50)) return;
    if (desktop && claudeKeyHandler.current?.(e)) return;
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && suggestion) {
      e.preventDefault();
      onDraftChange(suggestion);
      return;
    }
    // History recall is gated behind Alt+↑/↓. Bare ↑/↓ stays native caret
    // movement — users complained that hijacking them stole vertical caret
    // positioning inside a multi-line draft. Alt+arrow has no native
    // behavior in a textarea, so it's a conflict-free dedicated gesture
    // (Shift+arrow is off-limits — that's the browser's vertical text
    // selection). The placeholder advertises "Alt+↑↓ 翻历史".
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey) {
      if (navigateHistory(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
      return;
    }
    // Send key is user-configurable (settings modal → Keyboard), because the
    // muscle-memory split (chat-app Enter-to-send vs editor Ctrl+Enter) differs
    // per person and per OS.
    //   • enterToSend (default): plain Enter sends; Shift/Ctrl/Cmd+Enter = newline.
    //   • else:                  Ctrl/Cmd+Enter sends; plain Enter = newline.
    if (e.key === 'Enter') {
      const hasMod = e.ctrlKey || e.metaKey;
      if (appState.gambitEnterToSend) {
        if (e.shiftKey || hasMod) return; // newline
        e.preventDefault();
        handleSend();
      } else if (hasMod) {
        e.preventDefault();
        handleSend();
      }
    }
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    // Collect all image files first (rare — clipboard normally has ≤1 image).
    // Validate BEFORE preventing default: if getAsFile() returns null
    // (some Windows clipboard sources do this), we must NOT block the
    // native paste or the user loses their clipboard content.
    const imageFiles: { file: File; ext: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      imageFiles.push({ file, ext: (item.type.split('/')[1] || 'png').toLowerCase() });
    }
    if (imageFiles.length === 0) return;

    e.preventDefault();

    const textarea = textareaRef.current;
    const selStart = textarea?.selectionStart ?? draft.length;
    const selEnd = textarea?.selectionEnd ?? draft.length;

    const paths: string[] = [];
    for (const { file, ext } of imageFiles) {
      try {
        const base64 = await fileToBase64(file);
        paths.push(await commands.saveClipboardImage(base64, ext));
      } catch (err) {
        console.error('[Gambit] save image failed', err);
      }
    }
    if (paths.length === 0) return;

    // Insert paths at the cursor as plain text. If there's adjacent
    // non-whitespace text on either side, pad with spaces so AI CLI
    // path detection doesn't glue the path onto surrounding prose.
    const before = draft.slice(0, selStart);
    const after = draft.slice(selEnd);
    const leftPad = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    const rightPad = after.length > 0 && !/^\s/.test(after) ? ' ' : '';
    const inserted = leftPad + paths.map(path => desktop && /\s/.test(path) ? `"${path}"` : path).join(' ') + rightPad;
    const newDraft = before + inserted + after;
    onDraftChange(newDraft);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      const caret = selStart + inserted.length;
      ta.selectionStart = caret;
      ta.selectionEnd = caret;
    });
  };

  // Suppress onClose usage warning — true close is driven by parent (Explorer
  // toggle). The component still accepts onClose in props for API symmetry
  // and future use but doesn't expose it in the UI.
  void onClose;

  // Docked panel: anchored at the bottom of the center panel with 8px of
  // breathing room on left/right/bottom — sits between, never under, the
  // Explorer / right pane. Native chrome (rounded corners, soft glow,
  // backdrop-filter) is preserved.
  const dockStyle: React.CSSProperties = {
    transform: 'none',
    left: leftPanelHidden ? 8 : 'calc(var(--w-left) + 8px)',
    right: rightPanelHidden ? 8 : 'calc(var(--w-right) + 8px)',
    bottom: 8,
    top: 'auto',
    width: 'auto',
    height: effectiveH,
  };

  const capabilitiesStatus = (orchestration || computer || browser) && <div className="gambit-capabilities" role="status">
    {orchestration && <span className="gambit-capability is-orchestration">{t('tools.tab.orchestration')}</span>}
    {computer && <span className="gambit-capability is-computer">{t('control.computer_label')}</span>}
    {browser && <span className="gambit-capability is-browser">{t('control.browser_label')}</span>}
  </div>;

  return (
    <div
      ref={rootRef}
      className="gambit gambit--docked"
      style={dockStyle}
      onMouseDown={(e) => e.stopPropagation() /* don't let global focus enforcer steal focus back to xterm */}
      // Block native WebView context menu across the whole Gambit panel.
      // The textarea's onContextMenu opens our custom cut/copy/paste menu;
      // other areas (dock-resize strip, padding) just get no menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Top-edge handle for vertical height resize (VS Code bottom-panel style). */}
      <div className="gambit-dock-resize" onMouseDown={onDockResizeStart} />

      {attachments.length > 0 && <div className="gambit-attachments">
        {attachments.map(({ path, image }) => <div className="gambit-attachment" key={path}>
          <button className="gambit-attachment-content" aria-label={t(image ? 'gambit.preview_attachment' : 'gambit.attachment', { path })} onClick={() => { if (image) openThumbPreview(path); }}>
            {image && thumbUrls[path] ? <img src={thumbUrls[path]} alt="" draggable={false} onError={e => { e.currentTarget.style.display = 'none'; }} /> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 2H6v20h12V6zM14 2v5h5M8 12h8M8 16h8" /></svg>}
            <span>{path.split(/[\\/]/).pop()}</span>
          </button>
          <button className="gambit-attachment-remove close-button" aria-label={t('gambit.remove_attachment', { path })} onClick={() => removeAttachment(path)}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="m3 3 6 6m0-6-6 6" /></svg></button>
        </div>)}
      </div>}

      {/* Input box: the textarea auto-grows to fit its content. */}
      <div
        className="gambit-input"
        ref={inputRef}
        onContextMenu={onContextMenu}
        onMouseDown={(e) => {
          // Click anywhere in the box (padding) -> focus the textarea.
          // preventDefault stops focus from landing on a non-input element,
          // which would let the global focus enforcer (CenterPanel) yank it
          // back to the active terminal.
          const tgt = e.target as HTMLElement;
          if (tgt !== textareaRef.current) {
            e.preventDefault();
            textareaRef.current?.focus();
          }
        }}
      >
        <textarea
          ref={textareaRef}
          className="gambit-textarea"
          value={draft}
          placeholder={suggestion ? undefined : t('gambit.placeholder', { send: sendCombo, newline: newlineCombo })}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionEnd={() => { compositionEndRef.current = performance.now(); }}
          onPaste={onPaste}
          spellCheck={false}
          rows={1}
          aria-description={suggestion}
        />
        {/* Not the placeholder: that cannot end in an ellipsis, and a long guess would be silently cut. */}
        {suggestion && <div className="gambit-suggestion" aria-hidden="true">{suggestion}</div>}
      </div>

      <div className={`gambit-footer${desktop ? ' gambit-footer--claude' : ''}${!desktop && attachable ? ' gambit-footer--attach' : ''}${capabilitiesStatus ? ' gambit-footer--capabilities' : ''}`}>

        {/* Target label — leftmost footer item, symmetric to the send button.
            Shows the active tab's folder or remote host so a prompt can't be
            sent to the wrong target; updates as tabs switch.
            Deliberately no hover tooltip — the visible name is the info.
            No folder icon: every directory would get the same glyph, so it's
            pure noise (and read as a different brightness than the text). */}
        {workspaceName && (
          <span className="gambit-workspace">
            {toolIcon != null && <span className="gambit-workspace-icon">{toolIcon}</span>}
            <span className="gambit-workspace-name">{workspaceName}</span>
          </span>
        )}
        {channelBadge}
        {worktreeControl}
        {claude && <ClaudeComposerControls sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} quota={usageMeter}>{capabilitiesStatus}</ClaudeComposerControls>}
        {codex && <CodexComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</CodexComposerControls>}

        {opencode && <OpenCodeComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</OpenCodeComposerControls>}
        {pi && <PiComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</PiComposerControls>}
        {dsh && <DshComposerControls key={sessionId} sessionId={sessionId} draft={draft} onDraftChange={onDraftChange} keyHandler={claudeKeyHandler} submitHandler={codexSubmitHandler} quota={usageMeter}>{capabilitiesStatus}</DshComposerControls>}
        {!desktop && attachable && <button type="button" className="gambit-attach" aria-label={t('claude.attach')} onClick={() => { void attachFiles(); }}><AttachIcon /></button>}
        {!desktop && capabilitiesStatus}
        {!desktop && usageMeter}

        {sendFailed && (
          <span className="gambit-send-hint" role="status">
            {sendFailedHint ?? t('gambit.send_failed_hint')}
          </span>
        )}
        {sendEmpty && (
          <span className="gambit-send-hint gambit-send-hint--empty" role="status">
            {t('gambit.send_empty_hint')}
          </span>
        )}

        {voiceFailed && (
          <span className="gambit-send-hint gambit-send-hint--voice" role="status" title={voiceError || undefined}>
            {voiceNoInput ? t('gambit.voice_no_input') : voiceError ? t('gambit.voice_failed_reason', { error: voiceError }) : t('gambit.voice_failed_hint')}
          </span>
        )}

        {voiceSupported && voiceState === 'recording' && (
          <div className="gambit-voice-bar" role="group" aria-label={t('gambit.voice_listening_hint')}>
            <button type="button" className="gambit-voice-bar-cancel" aria-label={t('gambit.voice_cancel')} onClick={cancelVoice}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>
            </button>
            <div className="gambit-voice-wave" aria-hidden="true">
              {Array.from({ length: WAVEFORM_BARS }, (_, i) => (
                <span key={i} ref={(el) => { waveformBarsRef.current[i] = el; }} className="gambit-voice-wave-bar" />
              ))}
            </div>
            <button type="button" className="gambit-voice-bar-confirm" aria-label={t('gambit.voice_stop')} onClick={() => { void toggleVoice(); }}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 14 V3 M3 8 L8 3 L13 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        )}

        {voiceSupported && voiceState !== 'recording' && (
          <button
            type="button"
            className="gambit-voice"
            aria-label={t('gambit.voice')}
            aria-pressed={false}
            disabled={voiceState === 'transcribing'}
            onClick={() => { void toggleVoice(); }}
          >
            {voiceState === 'transcribing'
              ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="2.4"/><path d="M12 2v3.6M12 18.4V22M2 12h3.6M18.4 12H22M4.9 4.9l2.5 2.5M16.6 16.6l2.5 2.5M19.1 4.9l-2.5 2.5M7.4 16.6l-2.5 2.5" strokeLinecap="round"/></svg>
              : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/></svg>}
          </button>
        )}

        <button
          className={`gambit-send${sendFailed ? ' gambit-send--failed' : ''}${!running && !draft.trim() ? ' gambit-send--empty' : ''}`}
          aria-label={t(running && (!steerable || !draft.trim()) ? 'gambit.stop' : 'gambit.send')}
          disabled={running && !onCancel}
          onClick={running && (!steerable || !draft.trim()) ? onCancel : handleSend}
        >
          {running && (!steerable || !draft.trim()) ? <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1" /></svg> : <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 14 V3 M3 8 L8 3 L13 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>}
        </button>
      </div>

      {/* Full-size preview overlay. Renders into document.body to escape
          .gambit's transform containing block (otherwise position:fixed
          anchors to the transformed ancestor and clips to overflow:hidden). */}
      {previewPath && thumbUrls[previewPath] && createPortal(
        <div
          className="gambit-preview-overlay"
          onClick={() => setPreviewPath(null)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <img
            src={thumbUrls[previewPath]}
            alt=""
            draggable={false}
            onClick={(e) => e.stopPropagation() /* clicking the image itself should NOT close — only blank space does */}
          />
        </div>,
        document.body,
      )}

      {ctxMenu && createPortal(
        <div
          ref={ctxMenuRef}
          className="term-ctx-menu"
          style={{
            // Clamp so the menu never overflows off-screen; flips upward when
            // the trigger sits near the bottom edge (matches terminal & Explorer
            // behavior). Width ~164, height ~152 (4 items + separator + padding).
            left: Math.min(ctxMenu.x, window.innerWidth  - 168),
            top:  Math.min(ctxMenu.y, window.innerHeight - 156),
          }}
        >
          <button
            className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
            onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCut(); }}
          >
            <span>{t('menu.cut')}</span><kbd>{ctxMod}+X</kbd>
          </button>
          <button
            className={`term-ctx-item${ctxMenu.hasSelection ? '' : ' disabled'}`}
            onMouseDown={(e) => { e.preventDefault(); if (ctxMenu.hasSelection) ctxCopy(); }}
          >
            <span>{t('menu.copy')}</span><kbd>{ctxMod}+C</kbd>
          </button>
          <button
            className="term-ctx-item"
            onMouseDown={(e) => { e.preventDefault(); ctxPaste(); }}
          >
            <span>{t('menu.paste')}</span><kbd>{ctxMod}+V</kbd>
          </button>
          <div className="term-ctx-sep" />
          <button
            className="term-ctx-item"
            onMouseDown={(e) => { e.preventDefault(); ctxSelectAll(); }}
          >
            <span>{t('menu.select_all')}</span><kbd>{ctxMod}+A</kbd>
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// React.memo is CRITICAL here — TierTerminal (our parent) is intentionally
// not memoized (an earlier regression), so it re-renders on every app-wide
// state change, including terminal focus shifts. Without
// this memo wrapper, every parent re-render during a dock-resize drag would
// reset the inline height from React, clobbering the direct DOM writes we
// use for smooth resizing and making the panel visibly snap back.
export const Gambit = memo(GambitImpl);


