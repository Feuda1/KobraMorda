import { Download, X } from "lucide-react";
import { Portal } from "./Portal";

/** Full-screen video player used for timelapse playback wherever a "watch this" action can be triggered. */
export function VideoLightbox({ src, filename, onClose }: { src: string; filename: string; onClose: () => void }) {
  return (
    <Portal>
      <div
        className="fade-in fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: "rgba(0,0,0,0.8)" }}
        onClick={onClose}
      >
        <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="truncate font-medium">{filename}</span>
            <div className="flex shrink-0 items-center gap-3">
              <a
                href={src}
                download={`${filename.replace(/\.[^.]+$/, "")}.mp4`}
                className="flex h-8 w-8 items-center justify-center rounded-full"
                style={{ background: "var(--border)" }}
              >
                <Download size={15} />
              </a>
              <button onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: "var(--border)" }}>
                <X size={15} />
              </button>
            </div>
          </div>
          <video
            src={src}
            controls
            autoPlay
            loop
            className="w-full rounded-xl"
            style={{ background: "#000", maxHeight: "80vh" }}
          />
        </div>
      </div>
    </Portal>
  );
}
