"use client";

import { useEffect, useState } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import * as engine from "@/lib/engine";
import { RefreshCw } from "lucide-react";

const SAMPLE_RATES = [44100, 48000, 88200, 96000];
const BUFFER_SIZES = [32, 64, 128, 256, 512, 1024];
const MAX_INPUT_CHANNELS = 32;

export function DeviceSelector() {
  const {
    inputs, outputs, currentInput, currentOutput, sampleRate, bufferSize,
    setDeviceInfo,
  } = useAppStore();

  const [pendingInput, setPendingInput] = useState(currentInput);
  const [pendingOutput, setPendingOutput] = useState(currentOutput);
  const [pendingSr, setPendingSr] = useState(sampleRate);
  const [pendingBs, setPendingBs] = useState(bufferSize);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setPendingInput(currentInput); }, [currentInput]);
  useEffect(() => { setPendingOutput(currentOutput); }, [currentOutput]);
  useEffect(() => { setPendingSr(sampleRate); }, [sampleRate]);
  useEffect(() => { setPendingBs(bufferSize); }, [bufferSize]);

  const refresh = async () => {
    const info = await engine.listDevices();
    setDeviceInfo({
      inputs: info.inputs, outputs: info.outputs,
      currentInput: info.currentInput, currentOutput: info.currentOutput,
      sampleRate: info.sampleRate || 48000, bufferSize: info.bufferSize || 128,
      numActiveInputs: info.numActiveInputs, numActiveOutputs: info.numActiveOutputs,
    });
  };

  const apply = async () => {
    setBusy(true);
    try {
      const r = await engine.setDevice(pendingInput, pendingOutput || pendingInput, pendingSr, pendingBs, MAX_INPUT_CHANNELS);
      setDeviceInfo({
        currentInput: pendingInput, currentOutput: pendingOutput || pendingInput,
        sampleRate: r.sampleRate, bufferSize: r.bufferSize,
        numActiveInputs: r.numActiveInputs, numActiveOutputs: r.numActiveOutputs,
      });
      try {
        await engine.savePrefs({
          input: pendingInput,
          output: pendingOutput || pendingInput,
          sampleRate: r.sampleRate,
          bufferSize: r.bufferSize,
        });
      } catch (e) {
        console.warn("savePrefs failed:", e);
      }
    } catch (e) {
      alert(`Could not set device: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3">
      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-muted-foreground">Input device</label>
        <Select value={pendingInput} onValueChange={setPendingInput}>
          <SelectTrigger className="w-64"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {inputs.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-muted-foreground">Output device</label>
        <Select value={pendingOutput} onValueChange={setPendingOutput}>
          <SelectTrigger className="w-64"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            {outputs.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-muted-foreground">Sample rate</label>
        <Select value={String(pendingSr)} onValueChange={(v) => setPendingSr(Number(v))}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            {SAMPLE_RATES.map((r) => <SelectItem key={r} value={String(r)}>{r}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[10px] uppercase text-muted-foreground">Buffer size</label>
        <Select value={String(pendingBs)} onValueChange={(v) => setPendingBs(Number(v))}>
          <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {BUFFER_SIZES.map((b) => <SelectItem key={b} value={String(b)}>{b}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <Button onClick={apply} disabled={busy || !pendingInput} size="sm">
        {busy ? "Applying…" : "Apply"}
      </Button>
      <Button onClick={refresh} size="icon" variant="ghost" title="Rescan devices">
        <RefreshCw className="h-4 w-4" />
      </Button>

      <div className="ml-auto text-[11px] text-muted-foreground">
        Active: {sampleRate} Hz · {bufferSize} samples · {(bufferSize / sampleRate * 1000).toFixed(2)} ms/buffer
      </div>
    </div>
  );
}
