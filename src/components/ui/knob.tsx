"use client";

import { useCallback, useRef } from "react";
import { cn } from "@/lib/utils";

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

// Knob with an arc indicator on the top: as the value moves away from the
// default it fills a rounded arc from 12 o'clock toward the side it's been
// turned. Used for pan; works for any knob whose default sits between min
// and max (the arc is normalized to the distance from default to each edge).
export function Knob({ value, min, max, defaultValue = 0, size = 36, onChange, className, label }: KnobProps) {
  const dragging = useRef(false);
  const startY = useRef(0);
  const startValue = useRef(0);

  const range = max - min;

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

  // Arc geometry — full deflection covers MAX_ANGLE° on either side of 12 o'clock.
  const MAX_ANGLE = 135;
  const arcAngle = Math.abs(offsetFromDefault) * MAX_ANGLE;

  const strokeWidth = Math.max(2, Math.round(size / 11));
  // Inset by half the stroke + a hair so the rounded caps don't get clipped.
  const r  = (size - strokeWidth) / 2 - 1;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const arcLength = (arcAngle / 360) * circumference;

  // SVG circle paths start at 3 o'clock and sweep clockwise. Rotating by -90°
  // moves the start to 12 o'clock; for negative offsets we rotate further so
  // the arc *ends* at 12 o'clock (fills toward the left).
  const rotation = offsetFromDefault < 0 ? -90 - arcAngle : -90;

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
        {/* Knob body */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="hsl(var(--secondary))"
          stroke="hsl(var(--border))"
          strokeWidth={1}
        />
        {/* Pan arc — uses stroke-dasharray to draw a partial ring, rotated so
            the arc starts (or ends, for negative offsets) at 12 o'clock. */}
        {showArc && (
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
        )}
      </svg>
      {/* Center label rendered as HTML overlay so we can rely on ordinary text
          shaping. Sized small relative to the knob diameter so 4-character
          readouts like "L100" / "R100" sit comfortably inside the ring without
          dominating the knob visually. */}
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
