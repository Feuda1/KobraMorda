export interface PrinterState {
  connected: boolean;
  printerName: string;
  firmwareVersion: string;
  printState: "standby" | "printing" | "paused" | "complete" | "error";
  deviceState?: string;
  filename: string | null;
  progress: number;
  currentLayer: number;
  totalLayers: number;
  printDurationSec: number;
  remainTimeSec: number;
  estimatedTotalSec: number;
  nozzleTemp: number;
  nozzleTarget: number;
  bedTemp: number;
  bedTarget: number;
  fanPct: number;
  lightOn: boolean | null;
  rtspUrl: string | null;
  fileUploadUrl: string | null;
}
