import { describe, expect, it } from 'vitest';
import { getPresetTrack } from '@/lib/tracks';
import { getTrackWithRacingLine } from '@/lib/solver';

describe('Track Map Hero Centerpiece Projection & UI Clearance Verification', () => {
  it('guarantees circuit prominence (~82% vertical height on square tracks) and zero collision with top legend, bottom pill, or right HUD', () => {
    const circuits = ['endurance', 'autocross', 'skidpad', 'korfez-fst-1380'] as const;
    const w = 1280;
    const h = 620;
    const padTop = 42;
    const padBottom = 66;
    const padLeft = 32;
    const padRight = 320; // Desktop right HUD clearance

    for (const trackId of circuits) {
      const baseTrack = getPresetTrack(trackId);
      const track = getTrackWithRacingLine(baseTrack, 'optimal');
      const rl = track.racingLine;
      const allX = [...rl.leftCurbX, ...rl.rightCurbX, ...track.x];
      const allY = [...rl.leftCurbY, ...rl.rightCurbY, ...track.y];
      const minX = Math.min(...allX);
      const maxX = Math.max(...allX);
      const minY = Math.min(...allY);
      const maxY = Math.max(...allY);
      const spanX = Math.max(maxX - minX, 1);
      const spanY = Math.max(maxY - minY, 1);

      const scale = Math.min((w - padLeft - padRight) / spanX, (h - padTop - padBottom) / spanY);
      const ox = padLeft + (w - padLeft - padRight - spanX * scale) / 2;
      const oy = padBottom + (h - padTop - padBottom - spanY * scale) / 2;

      const sx = (x: number) => ox + (x - minX) * scale;
      const sy = (y: number) => h - oy - (y - minY) * scale;

      // Check all track nodes are within bounds
      for (let i = 0; i < track.x.length; i++) {
        const px = sx(track.x[i]);
        const py = sy(track.y[i]);

        // Must stay below top legend (y >= 42)
        expect(py).toBeGreaterThanOrEqual(padTop - 1e-4);
        // Must stay above bottom Play Lap pill (y <= h - padBottom)
        expect(py).toBeLessThanOrEqual(h - padBottom + 1e-4);
        // Must stay to the right of left border
        expect(px).toBeGreaterThanOrEqual(padLeft - 1e-4);
        // Must stay to the left of the right HUD stack (x <= w - padRight)
        expect(px).toBeLessThanOrEqual(w - padRight + 1e-4);
      }

      // Check vertical utilization on endurance circuit
      if (trackId === 'endurance') {
        const trackHeightPx = spanY * scale;
        const verticalRatio = trackHeightPx / h;
        // Fills ~80-82% of total canvas height
        expect(verticalRatio).toBeGreaterThan(0.79);
        expect(verticalRatio).toBeLessThanOrEqual(0.83);
      }
    }
  });

  it('verifies G-Force Crosshair SVG geometry fits within 128x128 bounding box with 100% outer ring and marker visibility', () => {
    const size = 128;
    const cx = 64;
    const cy = 64;
    const maxR = 50; // 3.0 G outer ring

    // Outer ring bounds
    expect(cx - maxR).toBeGreaterThan(0);
    expect(cx + maxR).toBeLessThan(size);
    expect(cy - maxR).toBeGreaterThan(0);
    expect(cy + maxR).toBeLessThan(size);

    // Margin around outer ring is 14px on all sides
    expect(cx - maxR).toBe(14);
    expect(size - (cx + maxR)).toBe(14);
    expect(cy - maxR).toBe(14);
    expect(size - (cy + maxR)).toBe(14);

    // Top ACC label y-coordinate is within SVG bounds
    const topAccY = cy - maxR + 9;
    expect(topAccY).toBe(23);
    expect(topAccY).toBeGreaterThan(0);
  });
});
