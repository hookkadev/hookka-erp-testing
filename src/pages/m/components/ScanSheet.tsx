// ===========================================================================
// ScanSheet — full-screen QR scanner overlay for the /m mobile shell.
//
// Owner 2026-06-28 design v12 L1 list headers carry a scan-line icon next to
// the filter button. Tapping it opens this overlay: rear-camera live preview
// + reticle + decode loop. On a hit the parent's `onResult` callback fires
// with the decoded payload — typically a `${origin}/m/<slug>/<id>` URL the
// parent can route to, or a rack QR (`/r/<id>`) from /m/warehouse Scan Rack.
//
// DEV-09 rework (2026-09-25) — the first version was a black screen with a
// border 28px in from the edges and nothing else:
//   • a SQUARE aiming box with the rest of the preview dimmed, so it is clear
//     where to hold the code;
//   • a camera that fails (blocked / no camera / not https) now SAYS so, with
//     Retry — it used to leave a black screen forever;
//   • torch toggle when the lens supports it (dim warehouse aisles);
//   • a hit confirms itself — vibrate + a short tone (best-effort) + the box
//     turns green for a beat before the sheet closes;
//   • decoding uses the phone's native BarcodeDetector when present (Android
//     Chrome), else jsQR on a frame scaled down to ≤ 960px and throttled —
//     the old loop ran jsQR on the full-resolution frame on EVERY animation
//     frame, which crawls on a cheap phone.
// SCAN ONLY, by owner rule: there is deliberately NO "type the code" fallback
// — a rack is identified by scanning its QR, never by typing.
//
// Camera + native-detector + torch mechanics mirror src/pages/rack-scan.tsx
// (the field-tested /r/ scanner). The whole thing releases the stream when
// `open` flips false; no background camera holding.
// ===========================================================================
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Flashlight, CameraOff } from "lucide-react";
import jsQR from "jsqr";
import { M } from "../theme";
import { useTimeout } from "@/lib/scheduler";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired ONCE on a successful decode (the parent decides what to do). */
  onResult: (value: string) => void;
  /** Optional header title; default "Scan QR code". */
  title?: string;
};

// jsQR fallback cost control: longest edge of the frame handed to jsQR, and
// how often it runs. The native detector reads the <video> directly.
const JSQR_MAX_EDGE = 960;
const JSQR_EVERY_MS = 110;
const NATIVE_EVERY_MS = 70;
// How long the green "got it" box shows before the parent takes over.
const HIT_HOLD_MS = 220;

function cameraErrorText(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Camera is blocked. Allow camera access for this site (tap the lock icon in the address bar), then tap Retry.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera found on this device.";
  }
  if (name === "NotReadableError") {
    return "The camera is busy. Close any other app using it, then tap Retry.";
  }
  return "Could not open the camera. Make sure this page is on https, then tap Retry.";
}

// Best-effort confirmation: vibrate where supported (not iOS) and a short
// tone. Created inside the decode, so browsers without a recent tap may keep
// it silent — the green box is the confirmation that always shows.
function confirmHit() {
  try {
    navigator.vibrate?.(60);
  } catch {
    /* not supported */
  }
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.1);
    osc.onended = () => void ctx.close().catch(() => {});
  } catch {
    /* audio is a nicety */
  }
}

const NO_CAMERA_API =
  "This browser can’t open the camera. Open the ERP over https in Chrome or Safari.";
const hasCameraApi = () =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

export function ScanSheet({ open, onClose, onResult, title = "Scan QR code" }: Props) {
  // Retry remounts the session (fresh camera + fresh state) via its key.
  const [attempt, setAttempt] = useState(0);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <ScanSession
      key={attempt}
      title={title}
      onClose={onClose}
      onResult={onResult}
      onRetry={() => setAttempt((n) => n + 1)}
    />,
    document.body,
  );
}

// One camera session. Mounted only while the sheet is open, so every open and
// every Retry starts from clean state and the unmount releases the camera.
function ScanSession({
  title,
  onClose,
  onResult,
  onRetry,
}: {
  title: string;
  onClose: () => void;
  onResult: (value: string) => void;
  onRetry: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(() =>
    hasCameraApi() ? null : NO_CAMERA_API,
  );
  const [starting, setStarting] = useState(() => hasCameraApi());
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [hit, setHit] = useState<string | null>(null);

  // Hand the decoded value to the parent after the green box has shown.
  useTimeout(
    () => {
      if (hit) onResult(hit);
    },
    hit ? HIT_HOLD_MS : null,
  );

  useEffect(() => {
    if (!hasCameraApi()) return;
    let cancelled = false;
    let raf: number | null = null;

    const run = async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch (e) {
        if (!cancelled) {
          setStarting(false);
          setError(cameraErrorText(e));
        }
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      // Continuous autofocus + torch capability — best-effort, never blocks.
      try {
        const track = stream.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { focusMode?: string[]; torch?: boolean })
          | undefined;
        if (caps?.focusMode?.includes("continuous")) {
          await track.applyConstraints({
            advanced: [{ focusMode: "continuous" } as unknown as MediaTrackConstraintSet],
          });
        }
        if (!cancelled) setTorchSupported(!!caps?.torch);
      } catch {
        /* focus / torch are niceties */
      }

      const video = videoRef.current;
      if (!video || cancelled) return;
      video.srcObject = stream;
      video.play().catch(() => {});
      setStarting(false);

      let detector: BarcodeDetectorLike | null = null;
      if (window.BarcodeDetector) {
        try {
          detector = new window.BarcodeDetector({ formats: ["qr_code"] });
        } catch {
          detector = null;
        }
      }
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const every = detector ? NATIVE_EVERY_MS : JSQR_EVERY_MS;
      let last = 0;
      let busy = false;

      const found = (value: string) => {
        cancelled = true;
        confirmHit();
        setHit(value);
      };

      const tick = async (now: number) => {
        if (cancelled) return;
        if (!busy && now - last >= every && video.readyState >= 2 && video.videoWidth > 0) {
          last = now;
          busy = true;
          try {
            if (detector) {
              const codes = await detector.detect(video);
              const v = codes.find((c) => c.rawValue)?.rawValue;
              if (v && !cancelled) return found(v);
            } else if (ctx) {
              const scale = Math.min(
                1,
                JSQR_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight),
              );
              const w = Math.round(video.videoWidth * scale);
              const h = Math.round(video.videoHeight * scale);
              canvas.width = w;
              canvas.height = h;
              ctx.drawImage(video, 0, 0, w, h);
              const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, {
                inversionAttempts: "dontInvert",
              });
              if (code?.data && !cancelled) return found(code.data);
            }
          } catch {
            // A native detector that throws mid-stream → fall back to jsQR.
            detector = null;
          } finally {
            busy = false;
          }
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    void run();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, []);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      });
      setTorchOn(next);
    } catch {
      /* torch is best-effort */
    }
  };

  const boxColor = hit ? "#7FB069" : "rgba(201,169,97,.95)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        background: "#000",
        zIndex: 100,
        animation: "hkScrim .2s ease both",
        overflow: "hidden",
      }}
    >
      <video
        ref={videoRef}
        playsInline
        muted
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
        }}
      />

      {/* Aiming box. The giant spread shadow dims everything outside it. */}
      {!error ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "50%",
            top: "46%",
            width: "min(72vw, 300px)",
            aspectRatio: "1 / 1",
            transform: "translate(-50%, -50%)",
            borderRadius: 18,
            border: `3px solid ${boxColor}`,
            boxShadow: "0 0 0 100vmax rgba(0,0,0,.55)",
            transition: "border-color .12s ease",
            pointerEvents: "none",
          }}
        />
      ) : null}

      {/* Top bar: title + torch + close. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "calc(env(safe-area-inset-top, 0px) + 18px) 18px 14px",
        }}
      >
        <span style={{ flex: 1, fontSize: 16, fontWeight: 700, color: "#fff" }}>{title}</span>
        {torchSupported && !error ? (
          <RoundBtn
            label={torchOn ? "Turn torch off" : "Turn torch on"}
            active={torchOn}
            onClick={() => void toggleTorch()}
          >
            <Flashlight size={18} color="#fff" />
          </RoundBtn>
        ) : null}
        <RoundBtn label="Close scanner" onClick={onClose}>
          <X size={18} color="#fff" />
        </RoundBtn>
      </div>

      {/* Hint under the box / error panel. */}
      {error ? (
        <div
          style={{
            position: "absolute",
            left: 20,
            right: 20,
            top: "50%",
            transform: "translateY(-50%)",
            background: M.card,
            borderRadius: 18,
            padding: "22px 20px",
            textAlign: "center",
          }}
        >
          <CameraOff size={28} color={M.taupe} style={{ display: "block", margin: "0 auto 10px" }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: M.raisin, lineHeight: 1.45 }}>
            {error}
          </div>
          <button
            onClick={onRetry}
            style={{
              marginTop: 16,
              width: "100%",
              height: 46,
              border: "none",
              borderRadius: 13,
              background: M.taupe,
              color: "#fff",
              fontSize: 14.5,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            Retry
          </button>
        </div>
      ) : (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: "calc(46% + min(36vw, 150px) + 22px)",
            textAlign: "center",
            color: "#fff",
            fontSize: 13.5,
            fontWeight: 600,
            textShadow: "0 1px 3px rgba(0,0,0,.6)",
            pointerEvents: "none",
          }}
        >
          {hit ? "Got it" : starting ? "Starting camera…" : "Fit the QR code inside the box"}
        </div>
      )}
    </div>
  );
}

function RoundBtn({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      style={{
        width: 40,
        height: 40,
        borderRadius: 12,
        background: active ? M.taupe : "rgba(0,0,0,.45)",
        border: "1px solid rgba(255,255,255,.18)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        flex: "none",
      }}
    >
      {children}
    </button>
  );
}
