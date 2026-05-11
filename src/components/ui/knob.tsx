"use client";

import { useCallback, useId, useRef } from "react";
import { cn } from "@/lib/utils";
import { useActiveTheme } from "@/lib/theme-store";

interface KnobProps {
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  size?: number;
  onChange: (v: number) => void;
  className?: string;
  // Optional text rendered in the center of the knob (e.g. a pan readout).
  label?: string;
}

// Top-level dispatcher. The flat themes use a minimal arc-and-dot indicator
// (FlatKnob); the console theme renders a top-down Neve "marshmallow" knob
// with a cream cap and a red indicator line (NeveKnob). Both share the
// pointer/drag input behavior — only the visual layer differs.
export function Knob(props: KnobProps) {
  const theme = useActiveTheme();
  if (theme === "console") return <NeveKnob {...props} />;
  return <FlatKnob {...props} />;
}

// ---------------- shared input behavior ----------------
// Both knob skins use the same drag/reset semantics. Hoisted into a hook so
// each render path can stay focused on its visual layer.
function useKnobInput(props: KnobProps) {
  const { value, min, max, defaultValue = 0, onChange } = props;
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);
  const range = max - min;

  const reset = useCallback(() => onChange(defaultValue), [onChange, defaultValue]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey) {
      reset();
      e.preventDefault();
      return;
    }
    dragging.current = true;
    startY.current = e.clientY;
    startValue.current = value;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    const sensitivity = e.shiftKey ? 400 : 150; // px to traverse full range
    const v = startValue.current + (dy / sensitivity) * range;
    onChange(Math.max(min, Math.min(max, v)));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
  };

  // Normalized offset in [-1, 1]. = 0 at default; ±1 at min/max edges.
  let offsetFromDefault: number;
  if (value >= defaultValue) {
    const span = max - defaultValue;
    offsetFromDefault = span > 0 ? (value - defaultValue) / span : 0;
  } else {
    const span = defaultValue - min;
    offsetFromDefault = span > 0 ? (value - defaultValue) / span : 0;
  }
  offsetFromDefault = Math.max(-1, Math.min(1, offsetFromDefault));

  return { offsetFromDefault, reset, onPointerDown, onPointerMove, onPointerUp };
}

// ---------------- flat (default) knob ----------------
// The original visual: minimal SVG ring with an arc indicator that grows from
// 12 o'clock as the knob is turned away from default.
function FlatKnob(props: KnobProps) {
  const { min, max, value, size = 36, className, label } = props;
  const { offsetFromDefault, reset, onPointerDown, onPointerMove, onPointerUp } =
    useKnobInput(props);

  const MAX_ANGLE = 135;
  const arcAngle = Math.abs(offsetFromDefault) * MAX_ANGLE;

  const strokeWidth = Math.max(2, Math.round(size / 11));
  const r  = (size - strokeWidth) / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcLength = (arcAngle / 360) * circumference;
  const rotation = offsetFromDefault < 0 ? -90 - arcAngle : -90;
  const showArc = Math.abs(offsetFromDefault) > 0.001;

  return (
    <div
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      className={cn(
        "relative cursor-ns-resize select-none rounded-full outline-none ring-ring focus-visible:ring-1",
        className
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="block">
        <circle cx={cx} cy={cy} r={r} fill="hsl(var(--secondary))" stroke="hsl(var(--border))" strokeWidth={1} />
        {showArc ? (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="hsl(var(--foreground))"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${arcLength} ${circumference}`}
            transform={`rotate(${rotation} ${cx} ${cy})`}
          />
        ) : (
          <circle cx={cx} cy={cy - r} r={strokeWidth / 2} fill="hsl(var(--foreground))" />
        )}
      </svg>
      {label && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-medium tabular-nums text-foreground"
          style={{ fontSize: Math.max(6, Math.round(size * 0.25)) }}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// ---------------- Neve "marshmallow" knob (console theme) ----------------
// Top-down view of a vintage Neve rotary control:
//
//   - Cream cap (Marconi-style) painted with a radial gradient that fakes
//     the dome highlight (overhead light) and the side-shadow falloff
//   - A darker "rim" ring under the cap suggesting the knurled cylinder edge
//   - A red indicator line that rotates absolutely with the knob position
//     (12 o'clock at default, swinging ±135° toward the rails)
//   - A soft drop-shadow under the cap so it reads as sitting on the panel
//   - Subtle gloss highlight crescent on the upper-left of the cap
//
// Pan readouts ("C" / "L20" / "R20") sit in dark text on the cream center,
// out of the indicator's path. The indicator stops short of the center so
// it doesn't crash into the label.
function NeveKnob(props: KnobProps) {
  const { min, max, value, size = 36, className, label } = props;
  const { offsetFromDefault, reset, onPointerDown, onPointerMove, onPointerUp } =
    useKnobInput(props);

  const MAX_ANGLE = 135;
  const pointerAngle = offsetFromDefault * MAX_ANGLE;

  const id = useId();
  // Swap : characters out of useId so they're safe inside SVG url() refs.
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cx = size / 2;
  const cy = size / 2;
  // Leave a 1.5px margin so the drop shadow doesn't get clipped.
  const r = size / 2 - 1.5;

  const indicatorWidth = Math.max(1.4, size * 0.07);
  const indicatorStart = r * 0.45; // outside of the center label
  const indicatorEnd   = r * 0.86;

  return (
    <div
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={reset}
      className={cn(
        "relative cursor-ns-resize select-none rounded-full outline-none ring-ring focus-visible:ring-1",
        className
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="block overflow-visible">
        <defs>
          {/* Cream cap radial gradient. The off-center cx/cy makes the
              highlight land in the upper-left, where overhead light would
              hit a dome. The hard edge at 92% gives the cap a crisp rim. */}
          <radialGradient id={`cap-${safe}`} cx="38%" cy="30%" r="72%">
            <stop offset="0%"  stopColor="var(--console-knob-cap-light)" />
            <stop offset="55%" stopColor="var(--console-knob-cap-mid)" />
            <stop offset="92%" stopColor="var(--console-knob-cap-shadow)" />
            <stop offset="100%" stopColor="var(--console-knob-cap-rim)" />
          </radialGradient>
          {/* Subtle bottom-of-cap shadow, mimicking the cap's curvature
              falling into shadow on the lower side. */}
          <linearGradient id={`shade-${safe}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"  stopColor="rgba(0,0,0,0)" />
            <stop offset="100%" stopColor="rgba(40,30,10,0.40)" />
          </linearGradient>
          {/* Cap-to-panel drop shadow. Soft blur so it reads as cast shadow,
              not a hard outline. */}
          <filter id={`drop-${safe}`} x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation={Math.max(0.6, size * 0.04)} />
          </filter>
        </defs>

        {/* drop shadow on the panel */}
        <ellipse
          cx={cx}
          cy={cy + size * 0.06}
          rx={r * 0.95}
          ry={r * 0.92}
          fill="rgba(0,0,0,0.55)"
          filter={`url(#drop-${safe})`}
        />

        {/* cylinder rim — slightly larger than the cap, darker tan */}
        <circle cx={cx} cy={cy} r={r} fill="var(--console-knob-cap-rim)" />

        {/* cream cap */}
        <circle cx={cx} cy={cy} r={r * 0.92} fill={`url(#cap-${safe})`} />

        {/* curvature shadow on the lower half of the cap */}
        <ellipse
          cx={cx}
          cy={cy + r * 0.30}
          rx={r * 0.78}
          ry={r * 0.45}
          fill={`url(#shade-${safe})`}
          opacity="0.65"
        />

        {/* red indicator line — wider faint glow underneath, sharp line on top */}
        <g transform={`rotate(${pointerAngle} ${cx} ${cy})`}>
          <line
            x1={cx} y1={cy - indicatorStart}
            x2={cx} y2={cy - indicatorEnd}
            stroke="var(--console-knob-indicator-glow)"
            strokeWidth={indicatorWidth * 1.9}
            strokeLinecap="round"
            opacity="0.45"
          />
          <line
            x1={cx} y1={cy - indicatorStart}
            x2={cx} y2={cy - indicatorEnd}
            stroke="var(--console-knob-indicator)"
            strokeWidth={indicatorWidth}
            strokeLinecap="round"
          />
        </g>

        {/* glossy crescent on upper-left — the spec highlight */}
        <ellipse
          cx={cx - r * 0.10}
          cy={cy - r * 0.42}
          rx={r * 0.42}
          ry={r * 0.16}
          fill="rgba(255,255,255,0.55)"
        />
      </svg>

      {label && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center font-semibold tabular-nums"
          style={{
            fontSize: Math.max(6, Math.round(size * 0.22)),
            color: "var(--console-knob-label)",
            // Faint bottom highlight so the label looks engraved into the cap.
            textShadow: "0 0.5px 0 rgba(255,255,255,0.45)",
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
