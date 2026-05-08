"use client";

// Skeleton mirrors the real TrackStripView shape so swapping in tracks after a
// preset load doesn't visibly reflow. Importantly: h-full and a flex-1 plugin
// section so the skeleton fills whatever vertical space the parent provides.
export function TrackStripSkeleton() {
  return (
    <div className="flex h-full w-32 shrink-0 flex-col items-stretch gap-1.5 rounded-md border bg-card p-1.5 animate-pulse">
      {/* Header row */}
      <div className="flex items-center gap-0.5">
        <div className="h-6 w-3 rounded bg-muted/60" />
        <div className="h-6 flex-1 rounded bg-muted" />
        <div className="h-5 w-5 rounded bg-muted" />
      </div>
      {/* Input + Route dropdowns */}
      <div className="h-6 rounded bg-muted" />
      <div className="h-6 rounded bg-muted" />
      {/* Plugin chain — grows to consume remaining vertical room */}
      <div className="flex flex-1 min-h-[80px] flex-col gap-1">
        <div className="flex items-center justify-between">
          <div className="h-2 w-10 rounded bg-muted/70" />
          <div className="h-2 w-6 rounded bg-muted/70" />
        </div>
        <div className="flex-1 min-h-0 rounded border border-border/50 bg-background/30 p-1">
          <div className="space-y-1">
            <div className="h-4 rounded bg-muted/70" />
            <div className="h-4 rounded bg-muted/70" />
          </div>
        </div>
        <div className="h-6 rounded bg-muted" />
      </div>
      {/* Meters + pan/fader column (fixed 120px) */}
      <div className="flex justify-center gap-1.5">
        <div className="h-[120px] w-[5px] rounded bg-muted" />
        <div className="flex gap-px">
          <div className="h-[120px] w-[5px] rounded bg-muted" />
          <div className="h-[120px] w-[5px] rounded bg-muted" />
        </div>
        <div className="flex h-[120px] flex-col items-center gap-1.5">
          <div className="h-[22px] w-[22px] rounded-full bg-muted" />
          <div className="flex-1 w-1.5 rounded-full bg-muted" />
        </div>
      </div>
      {/* Readout */}
      <div className="h-3 rounded bg-muted/60" />
      {/* Mute/Solo */}
      <div className="flex items-center justify-center gap-1">
        <div className="h-6 w-6 rounded bg-muted" />
        <div className="h-6 w-6 rounded bg-muted" />
      </div>
    </div>
  );
}
