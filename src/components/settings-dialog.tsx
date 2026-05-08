"use client";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Settings, RefreshCw } from "lucide-react";
import { DeviceSelector } from "@/components/device-selector";

export function SettingsDialog({
  scanActive, scanCurrent, scanTotal, scanName, onRescan,
}: {
  scanActive: boolean;
  scanCurrent: number;
  scanTotal: number;
  scanName: string;
  onRescan: () => void;
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" title="Settings">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Settings</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <DeviceSelector />

          <div className="flex items-center gap-3 rounded-md border bg-card p-3">
            <div className="flex flex-col gap-0.5">
              <div className="text-[10px] uppercase text-muted-foreground">Audio Unit plugins</div>
              <div className="text-xs text-muted-foreground">
                {scanActive
                  ? `Scanning ${scanTotal > 0 ? `${scanCurrent} / ${scanTotal}` : "…"}${scanName ? ` · ${scanName}` : ""}`
                  : "Cached scan results are used on launch."}
              </div>
            </div>
            <Button
              className="ml-auto" size="sm" variant="outline"
              onClick={onRescan} disabled={scanActive}
              title="Rescan AU plugins"
            >
              <RefreshCw className={`mr-1 h-3.5 w-3.5 ${scanActive ? "animate-spin" : ""}`} />
              Rescan
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
