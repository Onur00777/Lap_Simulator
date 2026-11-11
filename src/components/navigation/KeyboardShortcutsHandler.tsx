'use client';

import { useEffect, useRef } from 'react';

export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;

interface Shortcuts {
  togglePlayback: () => void;
  cycleRate: (direction: number) => void;
  scrub: (distanceM: number) => void;
  toggleGg: () => void;
  toggleMath: () => void;
  toggleMatrix: () => void;
}

export default function KeyboardShortcutsHandler({ enabled, shortcuts }: { enabled: boolean; shortcuts: Shortcuts }) {
  const actions = useRef(shortcuts);
  useEffect(() => { actions.current = shortcuts; }, [shortcuts]);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.isContentEditable || target?.closest('input, textarea, select, [role="textbox"], [role="slider"]')) return;
      const key = event.key.toLowerCase();
      if (key === ' ' && target?.closest('button, a, summary, [role="button"]')) return;
      if (event.repeat && key !== 'arrowleft' && key !== 'arrowright') return;
      const { togglePlayback, cycleRate, scrub, toggleGg, toggleMath, toggleMatrix } = actions.current;
      switch (key) {
        case ' ': togglePlayback(); break;
        case '[': cycleRate(-1); break;
        case ']': cycleRate(1); break;
        case 'arrowleft': scrub(-10); break;
        case 'arrowright': scrub(10); break;
        case 'g': toggleGg(); break;
        case 'm': toggleMath(); break;
        case 's': toggleMatrix(); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
  return null;
}
