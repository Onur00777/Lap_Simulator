import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ApexLapSim — FS Vehicle Dynamics & Lap Time Suite',
  description:
    'Formula Student vehicle dynamics, quasi-steady-state lap time simulation, torque vectoring and VCU code generation.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
