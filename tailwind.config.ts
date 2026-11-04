import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hud: {
          bg: '#05070b',
          panel: '#0b1017',
          panel2: '#0f1620',
          line: '#1b2633',
          dim: '#5c6b7d',
          text: '#c9d4e2',
          cyan: '#22d3ee',
          lime: '#a3e635',
          amber: '#f59e0b',
          red: '#ef4444',
          blue: '#3b82f6',
          violet: '#a78bfa',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'Consolas', 'ui-monospace', 'monospace'],
        sans: ['Inter', '"Segoe UI"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.25), 0 0 24px -8px rgba(34,211,238,0.45)',
      },
    },
  },
  plugins: [],
};

export default config;
