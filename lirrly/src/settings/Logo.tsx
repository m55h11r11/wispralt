import { useId } from "react";

export function WaveMark({ size = 26 }: { size?: number }) {
  // Symmetric vertical-bar waveform mark, filled with Lirrly's voice gradient.
  const heights = [7, 13, 19, 23, 19, 13, 7];
  const barW = 2.4;
  const gap = (24 - heights.length * barW) / (heights.length - 1);
  const gradId = `wm-grad-${useId()}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffd5a4" />
          <stop offset="0.34" stopColor="#ffab9a" />
          <stop offset="0.67" stopColor="#ffc1f4" />
          <stop offset="1" stopColor="#dba0ff" />
        </linearGradient>
      </defs>
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * (barW + gap)}
          y={(24 - h) / 2}
          width={barW}
          height={h}
          rx="1.2"
          fill={`url(#${gradId})`}
        />
      ))}
    </svg>
  );
}
