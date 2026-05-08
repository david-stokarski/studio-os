"use client";

import { useEffect, useRef } from "react";
import { linearToDb } from "@/lib/utils";

interface Props {
  value: number; // 0..1 linear peak
  height?: number; // px
  width?: number;  // px
}

// dB scale: -60 (bottom) → 0 (top). Color zones: green < -12, yellow -12..-3, red > -3.
export function LevelMeter({ value, height = 120, width = 8 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peakHoldRef = useRef({ peak: 0, ts: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const db = value > 0 ? linearToDb(value) : -Infinity;
    // Map dB → 0..1 (bottom to top); -60 at 0, 0 at 1
    const norm = Math.max(0, Math.min(1, (db + 60) / 60));

    // Peak hold
    const now = performance.now();
    if (norm >= peakHoldRef.current.peak) {
      peakHoldRef.current = { peak: norm, ts: now };
    } else if (now - peakHoldRef.current.ts > 1000) {
      peakHoldRef.current.peak = Math.max(0, peakHoldRef.current.peak - 0.02);
    }

    ctx.clearRect(0, 0, width, height);
    // background
    ctx.fillStyle = "#1f1f23";
    ctx.fillRect(0, 0, width, height);

    // segments
    const segments = 20;
    for (let i = 0; i < segments; i++) {
      const segNorm = i / segments;
      const segDb = -60 + segNorm * 60;
      const filled = norm >= segNorm;
      let color: string;
      if (segDb > -3) color = filled ? "#ef4444" : "#3b1414";
      else if (segDb > -12) color = filled ? "#eab308" : "#3b3214";
      else color = filled ? "#22c55e" : "#143b1f";

      const segY = height - (i + 1) * (height / segments);
      const segH = (height / segments) - 1;
      ctx.fillStyle = color;
      ctx.fillRect(1, segY, width - 2, segH);
    }

    // Peak hold line.
    const peakY = height - peakHoldRef.current.peak * height;
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, peakY - 1, width, 1);
  }, [value, height, width]);

  return <canvas ref={canvasRef} style={{ width, height }} className="rounded-sm" />;
}
