import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./api";
import type { PrinterState } from "./types";

interface DashboardMessage {
  type: "state";
  state: PrinterState;
}

/** Connects to the bridge's own /ws/dashboard channel and keeps the latest state, reconnecting on drop. */
export function useDashboardSocket(printerId: string | null) {
  const [state, setState] = useState<PrinterState | null>(null);
  const [socketOpen, setSocketOpen] = useState(false);
  const retryDelay = useRef(1000);

  useEffect(() => {
    setState(null);
    if (!printerId) return;
    let ws: WebSocket;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(wsUrl("/ws/dashboard"));

      ws.onopen = () => {
        setSocketOpen(true);
        retryDelay.current = 1000;
      };
      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data) as DashboardMessage;
        if (msg.type === "state") setState(msg.state);
      };
      ws.onclose = () => {
        setSocketOpen(false);
        if (cancelled) return;
        retryTimer = setTimeout(connect, retryDelay.current);
        retryDelay.current = Math.min(retryDelay.current * 2, 10000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      ws?.close();
    };
  }, [printerId]);

  return { state, socketOpen };
}
