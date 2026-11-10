// player.tsx — entry point for the standalone audio-player webview.
//
// Deliberately NOT main.tsx: the player has no AppProvider, no terminal
// sessions and no global hotkeys. Mounting the full IDE shell here would spin
// up every main-window effect twice (background throttling, notify sounds,
// show_main_window) in a 420x620 window. Only the theme stylesheet is shared.

import ReactDOM from 'react-dom/client';
import { MusicPlayer } from './components/audio/MusicPlayer';
import './styles/global.css';
import './components/audio/MusicPlayer.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<MusicPlayer />);

// Same as main.tsx: our components own every context menu, and the WebView's
// built-in one would offer Back / Reload / Inspect in a shipped build.
window.addEventListener('contextmenu', event => event.preventDefault());
