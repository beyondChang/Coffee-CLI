// player.tsx — entry point for the standalone audio-player webview.
//
// Deliberately NOT main.tsx: the player has no AppProvider, no terminal
// sessions and no global hotkeys. Mounting the full IDE shell here would spin
// up every main-window effect twice (background throttling, notify sounds,
// show_main_window) in a small window. Only the theme stylesheet and the UI
// scale are shared.

import ReactDOM from 'react-dom/client';
import { MusicPlayer } from './components/audio/MusicPlayer';
import { initializeUiScale } from './lib/ui-scale';
import './styles/global.css';
import './components/audio/MusicPlayer.css';

// The window height is measured in CSS px but set in logical px; the WebView
// zoom bridges the two. Wait for the zoom to land before the first measurement.
const scaleReady = initializeUiScale();

ReactDOM.createRoot(document.getElementById('root')!).render(<MusicPlayer scaleReady={scaleReady} />);

// Same as main.tsx: our components own every context menu, and the WebView's
// built-in one would offer Back / Reload / Inspect in a shipped build.
window.addEventListener('contextmenu', event => event.preventDefault());
