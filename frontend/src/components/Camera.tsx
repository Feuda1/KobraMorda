import { Lightbulb, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { setLight, wsUrl } from "../api";

/** Live camera view fed by binary JPEG frames over WebSocket (see cameraWs.ts on the backend for why). */
export function Camera({ connected, lightOn }: { connected: boolean; lightOn: boolean | null }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  // Optimistic override until the printer's own report (dashboard state) catches up.
  const [pendingLight, setPendingLight] = useState<boolean | null>(null);
  const lightShown = pendingLight ?? lightOn;
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!connected) {
      setImgUrl(null);
      return;
    }

    let ws: WebSocket;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let retryDelay = 1000;
    let stallTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(wsUrl("/ws/camera"));
      ws.binaryType = "blob";

      ws.onopen = () => {
        retryDelay = 1000;
        stallTimer = setTimeout(() => ws.close(), 8000);
      };
      ws.onmessage = (evt) => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => ws.close(), 8000);
        const url = URL.createObjectURL(evt.data as Blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = url;
        setImgUrl(url);
      };
      ws.onclose = () => {
        clearTimeout(stallTimer);
        if (cancelled) return;
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      cancelled = true;
      clearTimeout(stallTimer);
      clearTimeout(retryTimer);
      ws?.close();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [connected]);

  useEffect(() => {
    setPendingLight(null);
  }, [lightOn]);

  const toggleLight = async () => {
    const next = !(lightShown ?? false);
    setPendingLight(next);
    // drop the optimistic value if the printer never confirms it
    setTimeout(() => setPendingLight(null), 3000);
    try {
      await setLight(next);
    } catch {
      setPendingLight(null);
    }
  };

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl" style={{ background: "#000" }}>
      {imgUrl ? (
        <img src={imgUrl} alt="" className="fade-in h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center" style={{ color: "var(--text-muted)" }}>
          <VideoOff size={28} />
        </div>
      )}

      <button
        onClick={toggleLight}
        className={`absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full backdrop-blur ${lightShown ? "glow" : ""}`}
        style={{ background: lightShown ? "var(--accent)" : "rgba(0,0,0,0.45)", color: "#fff" }}
      >
        <Lightbulb size={16} fill={lightShown ? "#fff" : "none"} />
      </button>
    </div>
  );
}
