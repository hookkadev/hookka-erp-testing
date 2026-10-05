// ---------------------------------------------------------------------------
// profile-dialog.tsx — the "Profile" item in the header's user menu.
//
// Owner 2026-10-05: the menu item did nothing, and the header avatar was a
// letter even for people who have a photo on the Org Chart. This shows the
// signed-in person's own details and lets them change their OWN photo. The
// photo is the same users.photo_file_id the Org Chart and User Management
// read, set through the same two steps (upload to /api/files, then
// PUT /api/org-chart/photo), which lets anyone set their own.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from "react";
import { X, Camera, Loader2 } from "lucide-react";
import { uploadFileAsset } from "@/lib/upload-file";
import { announcePhotoChange } from "@/lib/photo-changed";

// Same image list as org-chart.tsx / user-detail-drawer.tsx.
const PHOTO_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif";

export type Me = {
  id: string;
  email: string;
  role: string;
  displayName: string;
  department?: string;
  position?: string;
  photoFileId?: string | null;
};

export function ProfileDialog({
  me,
  roleLabel,
  onClose,
}: {
  me: Me;
  roleLabel: string;
  onClose: () => void;
}) {
  const [photoFileId, setPhotoFileId] = useState(me.photoFileId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const name = me.displayName || me.email;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // fileId "" clears the photo.
  async function setPhoto(fileId: string) {
    const res = await fetch("/api/org-chart/photo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personKey: `user:${me.id}`, fileId }),
    });
    const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (!res.ok || j.success === false) {
      setError(j.error || `Could not save the photo (HTTP ${res.status})`);
      return;
    }
    setPhotoFileId(fileId || null);
    announcePhotoChange(`user:${me.id}`, fileId || null);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  function upload(file: File) {
    void run(async () => {
      const uploaded = await uploadFileAsset({
        file,
        resourceType: "org-photo",
        resourceId: `user:${me.id}`,
      });
      if (!uploaded.ok) {
        setError(uploaded.error);
        return;
      }
      await setPhoto(uploaded.id);
    });
  }

  const rows: [string, string][] = [
    ["Email", me.email],
    ["Role", roleLabel],
    ["Department", me.department || "—"],
    ["Position", me.position || "—"],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="My profile"
        className="w-full max-w-sm rounded-lg border border-[#E2DDD8] bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-5 py-3">
          <h2 className="text-base font-semibold text-[#1F1D1B]">My profile</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-[#6B7280] hover:bg-[#F0ECE9]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <div className="rounded-md border border-[#E8AFA4] bg-[#FBE9E5] px-3 py-2 text-[12px] text-[#7E251A]">
              {error}
            </div>
          )}

          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E2DDD8] bg-[#F5F3EF] text-lg font-semibold text-[#6B5C32]">
              {busy ? (
                <Loader2 className="h-5 w-5 animate-spin text-[#8A8577]" />
              ) : photoFileId ? (
                <img
                  src={`/api/files/${photoFileId}/stream`}
                  alt={name}
                  className="h-full w-full object-cover"
                />
              ) : (
                name.slice(0, 1).toUpperCase()
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#1F1D1B]">{name}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => inputRef.current?.click()}
                  className="flex h-8 items-center gap-1.5 rounded-md border border-[#E2DDD8] px-2.5 text-[12px] text-[#6B7280] hover:text-[#1F1D1B] disabled:opacity-50"
                >
                  <Camera className="h-3.5 w-3.5" />
                  {photoFileId ? "Change photo" : "Add photo"}
                </button>
                {photoFileId && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => setPhoto(""))}
                    className="h-8 rounded-md border border-[#E2DDD8] px-2.5 text-[12px] text-[#6B7280] hover:text-[#1F1D1B] disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
                <input
                  ref={inputRef}
                  type="file"
                  accept={PHOTO_ACCEPT}
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) upload(file);
                  }}
                />
              </div>
            </div>
          </div>

          <dl className="divide-y divide-[#F0ECE9] text-sm">
            {rows.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-2">
                <dt className="w-24 shrink-0 text-[#9CA3AF]">{k}</dt>
                <dd className="min-w-0 break-words text-[#1F1D1B]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
