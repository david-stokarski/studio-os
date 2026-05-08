"use client";

import * as SliderPrimitive from "@radix-ui/react-slider";
import { cn, dbToFader, faderToDb, FADER_UNITY_POS } from "@/lib/utils";

interface FaderProps {
  valueDb: number;
  onChange: (db: number) => void;
  // Cmd/Ctrl + click resets to unity (0 dB). Set to a different value if needed.
  resetTo?: number;
  className?: string;
}

// A vertical fader styled like a real DAW level fader. Internally it uses a
// Radix Slider with [0..1000] integer steps to give the user smooth dragging,
// and converts position ↔ dB through a logarithmic curve (see lib/utils.ts):
// lots of travel around 0 dB and quickly steeper near silence.
//
// Caller is expected to wrap this in a fixed-height container — the fader
// fills its parent vertically.
export function Fader({ valueDb, onChange, resetTo = 0, className }: FaderProps) {
  const pos = Math.round(dbToFader(valueDb) * 1000);

  // Unity tick: percentage from the bottom of the track.
  const unityPct = FADER_UNITY_POS * 100;

  return (
    <div
      className={cn("flex h-full w-full items-stretch justify-center", className)}
      onPointerDownCapture={(e) => {
        // Cmd/Ctrl + click anywhere on the fader resets to unity.
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
          e.preventDefault();
          onChange(resetTo);
        }
      }}
    >
      <SliderPrimitive.Root
        orientation="vertical"
        value={[pos]}
        min={0}
        max={1000}
        step={1}
        onValueChange={(v) => onChange(faderToDb(v[0] / 1000))}
        className="relative flex h-full w-5 select-none flex-col items-center touch-none"
      >
        <SliderPrimitive.Track className="relative h-full w-1.5 grow overflow-visible rounded-full bg-secondary">
          {/* Filled portion grows from the bottom up to the current position. */}
          <SliderPrimitive.Range className="absolute w-full rounded-full bg-foreground" />
          {/* Unity (0 dB) tick — confined to the track width (not extending past
              the bar) so it reads as a notch on the bar itself. */}
          <div
            className="pointer-events-none absolute left-0 right-0 h-px bg-muted-foreground"
            style={{ bottom: `${unityPct}%` }}
            aria-hidden
          />
        </SliderPrimitive.Track>
        {/* Slim fader cap with a single grip line. */}
        <SliderPrimitive.Thumb
          className={cn(
            "relative block h-3 w-4 rounded-[3px] border border-border bg-card shadow-md",
            "ring-offset-background outline-none",
            "hover:border-primary/60 focus-visible:ring-1 focus-visible:ring-ring",
            "before:pointer-events-none before:absolute before:left-[3px] before:right-[3px] before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-foreground/60"
          )}
        />
      </SliderPrimitive.Root>
    </div>
  );
}
