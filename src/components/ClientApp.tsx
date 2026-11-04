'use client';

import dynamic from 'next/dynamic';

const Workbench = dynamic(() => import('./Workbench'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-screen items-center justify-center font-mono text-xs uppercase tracking-[0.3em] text-hud-dim">
      <span className="mr-3 h-2 w-2 animate-pulse rounded-full bg-hud-cyan shadow-[0_0_10px_#22d3ee]" />
      Initialising solver…
    </div>
  ),
});

export default function ClientApp() {
  return <Workbench />;
}
