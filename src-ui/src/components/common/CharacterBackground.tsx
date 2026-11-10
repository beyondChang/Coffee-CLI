import { useEffect, useRef, useState } from 'react';
import { createCharacterRenderer, type CharacterRenderer } from '../../lib/character-renderer';

// The character flow only mounts when the user explicitly picked that shape, so
// it is an opt-in to an animated backdrop. Honouring `prefers-reduced-motion`
// here made the choice silently do nothing (Windows "Animation effects" off is
// enough to trigger it), which reads as a broken option. Contrast / forced-colors
// stay gated: those protect legibility, not motion.
const blockedPreferences = [
  '(prefers-contrast: more)',
  '(forced-colors: active)',
];

export function CharacterBackground({ selectedId }: { selectedId: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<CharacterRenderer | null>(null);
  const [blocked, setBlocked] = useState(() =>
    blockedPreferences.some(query => window.matchMedia(query).matches),
  );

  useEffect(() => {
    const preferences = blockedPreferences.map(query => window.matchMedia(query));
    const update = () => setBlocked(preferences.some(preference => preference.matches));
    preferences.forEach(preference => preference.addEventListener('change', update));
    return () => preferences.forEach(preference => preference.removeEventListener('change', update));
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (blocked || !host) return;
    // StrictMode must get a fresh canvas after cleanup loses the old context.
    const canvas = document.createElement('canvas');
    host.appendChild(canvas);
    const renderer = createCharacterRenderer(canvas);
    rendererRef.current = renderer;
    if (!renderer) canvas.remove();
    return () => {
      canvas.remove();
      renderer?.dispose();
      rendererRef.current = null;
    };
  }, [blocked]);

  useEffect(() => {
    const host = hostRef.current;
    if (blocked || !selectedId || !host) return;
    const bounds = host.getBoundingClientRect();
    const tab = document.querySelector<HTMLElement>('.chrome-tab.active');
    const rect = tab?.getClientRects().length ? tab.getBoundingClientRect() : undefined;
    rendererRef.current?.select(selectedId, {
      x: rect && bounds.width ? Math.max(0, Math.min(1, (rect.left + rect.width / 2 - bounds.left) / bounds.width)) : 0.5,
      y: rect && bounds.height ? Math.max(0, Math.min(1, (rect.top + rect.height / 2 - bounds.top) / bounds.height)) : 0.5,
    });
  }, [blocked, selectedId]);

  return <div ref={hostRef} aria-hidden="true" className="character-background" />;
}
