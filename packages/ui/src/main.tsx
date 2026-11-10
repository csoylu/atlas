import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
// IBM Plex, bundled (no font CDN: the app works offline).
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
  }
}
// Excalidraw loads its fonts from here (served at /fonts by Vite and by the engine), not from esm.sh: works offline.
window.EXCALIDRAW_ASSET_PATH = '/';

if (/Electron/.test(navigator.userAgent) && /Mac/.test(navigator.platform))
  document.documentElement.classList.add('electron-mac');

/** A render crash shows the error instead of a blank window (CLAUDE.md rule 3). */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <h1>The interface crashed</h1>
        <pre>{error.stack ?? error.message}</pre>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Crash>
      <App />
    </Crash>
  </StrictMode>,
);
