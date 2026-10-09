import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ChevronDown, LogOut, User, Building2, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "./global-search";
import { NotificationBell } from "./notification-bell";
import { WorkspaceTabs } from "./workspace-tabs";
import { ProfileDialog, type Me } from "./profile-dialog";
import { PHOTO_CHANGED_EVENT, type PhotoChanged } from "@/lib/photo-changed";
import { clearAuth, getCurrentUser } from "@/lib/auth";
import { StagingTodayControl } from "@/components/staging-today-control"; // staging-only
import { StagingApiLog } from "@/components/staging-api-log"; // staging-only, never PR into main
import { StagingViewAs } from "@/components/staging-view-as"; // staging-only, never PR into main

interface TopbarProps {
  user?: {
    name: string;
    email: string;
    role: string;
    organisationName: string;
    organisationCode: string;
  };
}

// POST /api/auth/logout, then clear local state and bounce to /login.
// We run the server call best-effort — even if it fails we still want to
// wipe the client token so a reload doesn't auto-sign-in.
async function handleSignOut(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // ignore — network hiccup shouldn't trap the user in the app
  }
  clearAuth();
  window.location.href = "/login";
}

const organisations = [
  { code: "HOOKKA", name: "HOOKKA INDUSTRIES SDN BHD" },
  { code: "OHANA", name: "OHANA MARKETING" },
];

export function Topbar({ user }: TopbarProps) {
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // The signed-in person from /api/auth/me, for the avatar photo and the
  // Profile panel. Plain fetch, not useCachedJson. A photo saved anywhere in
  // the app is applied from the event, not by refetching (see photo-changed.ts).
  const [me, setMe] = useState<Me | null>(null);
  const [photoBroken, setPhotoBroken] = useState(false);
  useEffect(() => {
    const load = () =>
      fetch("/api/auth/me")
        .then((r) => (r.ok ? (r.json() as Promise<{ data?: { user?: Me } }>) : null))
        .then((j) => {
          if (j?.data?.user) {
            setMe(j.data.user);
            setPhotoBroken(false);
          }
        })
        .catch(() => {});
    load();
    const onPhoto = (e: Event) => {
      const { personKey, fileId } = (e as CustomEvent<PhotoChanged>).detail;
      setMe((cur) => (cur && personKey === `user:${cur.id}` ? { ...cur, photoFileId: fileId } : cur));
      setPhotoBroken(false);
    };
    window.addEventListener(PHOTO_CHANGED_EVENT, onPhoto);
    return () => window.removeEventListener(PHOTO_CHANGED_EVENT, onPhoto);
  }, []);
  const photoFileId = photoBroken ? null : me?.photoFileId;
  const currentOrg = user?.organisationCode || "HOOKKA";

  // Prefer the real signed-in user for the avatar label + dropdown.
  // If nobody is signed in yet (localStorage empty during boot), fall back
  // to "—" rather than inventing a name — never show a stale demo user
  // (P3.7: replaced hardcoded "Lim / Director" placeholder).
  const authUser = getCurrentUser();
  const displayName =
    authUser?.displayName || authUser?.email || user?.name || "—";
  const rawRole = authUser?.role || user?.role || "";
  const displayRole = rawRole
    ? rawRole
        .replace(/_/g, " ")
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : "—";

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-[#E2DDD8] bg-white px-4 xl:px-6 max-lg:h-auto max-lg:flex-wrap max-lg:justify-end max-lg:gap-2 max-lg:py-2">
      {/* Workspace tab strip (open pages persist as browser-style tabs).
          Renders a plain flex spacer until a 2nd tab exists. */}
      {/* Staging only (never PR'd into main): the staging tools take the tab strip's
          place, all in one row on the left. Labels drop to icons below xl instead of
          wrapping. The row never shrinks below its pills (no min-w-0): the search box
          is the one that gives, otherwise it covered the last pill. Below lg (phones
          and tablets): the tools drop to their own wrapping row under the search /
          org / bell, or the one row was wider than the screen (measured 5px over
          at 768) and the page slid sideways. */}
      {window.location.hostname.startsWith("staging.") ? (
        <div className="flex flex-1 items-center gap-2 max-lg:order-last max-lg:basis-full max-lg:flex-wrap">
          <StagingApiLog />
          <StagingViewAs />
          <StagingTodayControl />
          <Link
            to="/staging-notes"
            title="Staging patch notes"
            className="flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-amber-100 px-3 text-xs font-semibold text-amber-800 hover:bg-amber-200"
          >
            <ScrollText className="h-4 w-4" />
            <span className="hidden xl:inline">Patch notes</span>
          </Link>
        </div>
      ) : (
        <WorkspaceTabs />
      )}

      {/* Global Search (command palette) */}
      <GlobalSearch />

      {/* Organisation Switcher */}
      <div className="relative shrink-0">
        <button
          onClick={() => { setOrgDropdownOpen(!orgDropdownOpen); setUserDropdownOpen(false); }}
          className="flex h-9 items-center gap-2 rounded-md border border-[#E2DDD8] px-3 py-1.5 text-sm hover:bg-[#F0ECE9] transition-colors"
        >
          <Building2 className="h-4 w-4 text-[#6B5C32]" />
          <span className="hidden sm:inline font-medium text-[#1F1D1B]">{currentOrg}</span>
          <ChevronDown className="h-3 w-3 text-[#9CA3AF]" />
        </button>
        {orgDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-64 rounded-md border border-[#E2DDD8] bg-white shadow-lg py-1 z-50">
            {organisations.map((org) => (
              <button
                key={org.code}
                className={cn(
                  "flex w-full items-center gap-2 px-4 py-2 text-sm hover:bg-[#F0ECE9]",
                  currentOrg === org.code && "bg-[#F5F2ED] text-[#6B5C32] font-medium"
                )}
                onClick={() => setOrgDropdownOpen(false)}
              >
                <Building2 className="h-4 w-4" />
                <div className="text-left">
                  <div className="font-medium">{org.code}</div>
                  <div className="text-xs text-[#9CA3AF]">{org.name}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Notifications — real feed + real unread count (see notification-bell.tsx) */}
      <NotificationBell />

      {/* User menu */}
      <div className="relative shrink-0">
        <button
          onClick={() => { setUserDropdownOpen(!userDropdownOpen); setOrgDropdownOpen(false); }}
          className="flex items-center gap-2 rounded-md p-1.5 hover:bg-[#F0ECE9] transition-colors"
        >
          <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-[#6B5C32] flex items-center justify-center text-white text-sm font-medium">
            {photoFileId ? (
              <img
                src={`/api/files/${photoFileId}/stream`}
                alt=""
                className="h-full w-full object-cover"
                onError={() => setPhotoBroken(true)}
              />
            ) : (
              displayName.charAt(0).toUpperCase() || "U"
            )}
          </div>
          <div className="hidden xl:block whitespace-nowrap text-left">
            <p className="text-sm font-medium text-[#1F1D1B]">{displayName}</p>
            <p className="text-xs text-[#9CA3AF]">{displayRole}</p>
          </div>
          <ChevronDown className="h-3 w-3 text-[#9CA3AF] hidden xl:block" />
        </button>
        {userDropdownOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 rounded-md border border-[#E2DDD8] bg-white shadow-lg py-1 z-50">
            <button
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#4B5563] hover:bg-[#F0ECE9] disabled:opacity-50"
              disabled={!me}
              onClick={() => { setProfileOpen(true); setUserDropdownOpen(false); }}
            >
              <User className="h-4 w-4" />
              Profile
            </button>
            <hr className="my-1 border-[#E2DDD8]" />
            <button
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              onClick={() => { handleSignOut(); }}
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        )}
      </div>
      {/* Portalled: the sticky header is its own stacking context, so a
          dialog rendered inside it would sit under the sidebar. */}
      {profileOpen && me &&
        createPortal(
          <ProfileDialog me={me} roleLabel={displayRole} onClose={() => setProfileOpen(false)} />,
          document.body,
        )}
    </header>
  );
}
