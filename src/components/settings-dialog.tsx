"use client";

import { useState } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Settings, RefreshCw, Sliders, Plug, Palette, Check,
} from "lucide-react";
import { DeviceSelector } from "@/components/device-selector";
import { cn } from "@/lib/utils";
import { THEMES, type ThemeId } from "@/lib/themes";
import { useThemeStore } from "@/lib/theme-store";

type SectionId = "audio" | "plugins" | "appearance";

interface Section {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const SECTIONS: Section[] = [
  { id: "audio",      label: "Audio",      icon: Sliders },
  { id: "plugins",    label: "Plugins",    icon: Plug },
  { id: "appearance", label: "Appearance", icon: Palette },
];

export function SettingsDialog({
  scanActive, scanCurrent, scanTotal, scanName, onRescan,
}: {
  scanActive: boolean;
  scanCurrent: number;
  scanTotal: number;
  scanName: string;
  onRescan: () => void;
}) {
  const [active, setActive] = useState<SectionId>("audio");

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" title="Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      {/* Wider + taller than the default dialog so the macOS-style two-pane
          layout has room. p-0 because each pane manages its own padding. */}
      <DialogContent className="max-w-4xl gap-0 p-0">
        <DialogHeader className="border-b px-5 py-3">
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <div className="flex h-[520px]">
          {/* Sidebar */}
          <nav className="w-52 shrink-0 overflow-y-auto border-r bg-muted/30 p-2">
            <ul className="flex flex-col gap-0.5">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                const isActive = s.id === active;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActive(s.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        isActive
                          ? "bg-accent text-accent-foreground"
                          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{s.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Pane */}
          <div className="flex-1 overflow-y-auto p-5">
            {active === "audio" && <AudioSection />}
            {active === "plugins" && (
              <PluginsSection
                scanActive={scanActive}
                scanCurrent={scanCurrent}
                scanTotal={scanTotal}
                scanName={scanName}
                onRescan={onRescan}
              />
            )}
            {active === "appearance" && <AppearanceSection />}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- sections ----------------

function SectionHeader({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4 flex flex-col gap-0.5">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function AudioSection() {
  return (
    <>
      <SectionHeader
        title="Audio device"
        hint="Choose your interface, sample rate, and buffer size. Changes apply on Apply."
      />
      <DeviceSelector />
    </>
  );
}

function PluginsSection({
  scanActive, scanCurrent, scanTotal, scanName, onRescan,
}: {
  scanActive: boolean;
  scanCurrent: number;
  scanTotal: number;
  scanName: string;
  onRescan: () => void;
}) {
  return (
    <>
      <SectionHeader
        title="Audio Unit plugins"
        hint="Cached scan results are used on launch. Rescan after installing or updating plugins."
      />
      <div className="flex items-center gap-3 rounded-md border bg-card p-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <div className="text-[10px] uppercase text-muted-foreground">Scan status</div>
          <div className="text-xs text-muted-foreground">
            {scanActive
              ? `Scanning ${scanTotal > 0 ? `${scanCurrent} / ${scanTotal}` : "…"}${scanName ? ` · ${scanName}` : ""}`
              : "Idle."}
          </div>
        </div>
        <Button size="sm" variant="outline" onClick={onRescan} disabled={scanActive}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", scanActive && "animate-spin")} />
          Rescan
        </Button>
      </div>
    </>
  );
}

function AppearanceSection() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <>
      <SectionHeader
        title="Theme"
        hint="Pick a visual identity. Each one is more than a color palette — radius, type, and contrast change too."
      />
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            id={t.id}
            label={t.label}
            description={t.description}
            mode={t.mode}
            swatch={t.swatch}
            selected={t.id === theme}
            onSelect={() => setTheme(t.id)}
          />
        ))}
      </div>
    </>
  );
}

function ThemeCard({
  id, label, description, mode, swatch, selected, onSelect,
}: {
  id: ThemeId;
  label: string;
  description: string;
  mode: "dark" | "light";
  swatch: [string, string, string, string];
  selected: boolean;
  onSelect: () => void;
}) {
  // The preview is a fixed-color block, not the live theme — that way the
  // grid stays informative when the active theme is applied to its own tile.
  const [bg, surface, accent, text] = swatch;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-theme-id={id}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-lg border text-left transition-all",
        selected
          ? "border-primary ring-2 ring-ring/40"
          : "border-border hover:border-foreground/30",
      )}
    >
      {/* Mock UI preview rendered with hardcoded swatch colors */}
      <div
        className="relative h-24 w-full"
        style={{ background: bg }}
      >
        <div
          className="absolute left-3 right-10 top-3 h-3 rounded-sm"
          style={{ background: surface }}
        />
        <div
          className="absolute left-3 top-9 h-2 w-12 rounded-sm"
          style={{ background: text, opacity: 0.55 }}
        />
        <div
          className="absolute left-3 top-14 h-6 w-16 rounded-sm"
          style={{ background: accent }}
        />
        <div
          className="absolute right-3 top-3 h-[calc(100%-1.5rem)] w-6 rounded-sm"
          style={{ background: surface }}
        />
        {selected && (
          <div
            className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full"
            style={{ background: accent, color: bg }}
          >
            <Check className="h-3 w-3" strokeWidth={3} />
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {mode}
          </span>
        </div>
        <p className="text-xs leading-snug text-muted-foreground">{description}</p>
      </div>
    </button>
  );
}
