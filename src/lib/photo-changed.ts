// The header avatar follows a photo saved anywhere in the app (Profile
// panel, Org Chart, User Management) through this one window event.
/**
 * Fired after any photo save so the header avatar can follow. It carries the
 * new file id itself: refetching /me straight after the write could be served
 * the old row from the Hyperdrive read cache.
 */
export const PHOTO_CHANGED_EVENT = "hookka:photo-changed";
export type PhotoChanged = { personKey: string; fileId: string | null };

export function announcePhotoChange(personKey: string, fileId: string | null): void {
  window.dispatchEvent(
    new CustomEvent<PhotoChanged>(PHOTO_CHANGED_EVENT, { detail: { personKey, fileId } }),
  );
}
