import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePortaStore } from "../../store";
import type { App } from "../../types";
import { Button } from "../ui";

/**
 * Start, split into "run" + "run as which env".
 *
 * Env profiles were only reachable through the card's right-click menu, so
 * "start this under prod" meant hunting for a context menu on a surface you
 * might not be looking at. The chevron half puts every profile one click from
 * the primary action, and picking one both switches the app's active profile
 * and starts it — the two things you always wanted together.
 *
 * With no profiles configured this renders exactly the plain Start button it
 * replaced, chevron included nowhere.
 */
export default function ProfileStartButton({
  app,
  loading,
  label,
  onStart,
  profilesEnabled = true,
}: {
  app: App;
  loading: boolean;
  /** "Start" / "Starting" / "Restart" — the caller owns the wording. */
  label: string;
  onStart: () => void;
  /** Off for worktree instances: they inherit the parent app's profile, so
   *  offering the switcher here would silently retarget the parent. */
  profilesEnabled?: boolean;
}) {
  const setActiveProfile = usePortaStore((s) => s.setAppActiveProfile);
  const profiles = profilesEnabled ? (app.env_profiles ?? []) : [];
  const activeId = app.active_profile_id ?? null;

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Portal + fixed positioning: the header this sits in clips overflow, so an
  // in-flow dropdown would be cut off at the first row of the tab strip.
  useEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setCoords({ top: r.bottom + 4, right: window.innerWidth - r.right });
    }
    function onDown(e: MouseEvent) {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const startIcon = (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 2.2l6 3.8-6 3.8z" /></svg>
  );

  if (profiles.length === 0) {
    return (
      <Button variant="accent" loading={loading} icon={startIcon} onClick={onStart}>
        {label}
      </Button>
    );
  }

  const activeName = profiles.find((p) => p.id === activeId)?.name ?? "Default";

  async function runAs(profileId: string | null) {
    setOpen(false);
    // Already the active profile — nothing to persist, just start.
    if (profileId !== activeId) {
      // `false`: the app isn't running (this button only shows when stopped),
      // so a restart would be a no-op at best.
      await setActiveProfile(app.id, profileId, false);
    }
    onStart();
  }

  return (
    <div ref={anchorRef} className="inline-flex">
      <Button
        variant="accent"
        loading={loading}
        icon={startIcon}
        onClick={onStart}
        title={`${label} as ${activeName}`}
        className="rounded-r-none border-r-0"
      >
        {label}
      </Button>
      <Button
        variant="accent"
        disabled={loading}
        onClick={() => setOpen((v) => !v)}
        title="Choose a run profile"
        aria-label="Choose a run profile"
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-l-none px-1.5"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M2 3.5L5 6.5l3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>

      {open && coords && createPortal(
        <div
          role="menu"
          className="fixed z-[70] min-w-[180px] rounded-lg border border-strong bg-surface-2 py-1 shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
          style={{ top: coords.top, right: coords.right }}
        >
          <div className="px-2.5 pb-1 text-[10px] uppercase tracking-[0.09em] text-ink-3 select-none">
            Run as
          </div>
          {[{ id: null as string | null, name: "Default" }, ...profiles].map((p) => {
            const isActive = p.id === activeId;
            return (
              <button
                key={p.id ?? "__default"}
                role="menuitem"
                onClick={() => { void runAs(p.id); }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] text-left text-ink-2 hover:bg-white/[0.06] hover:text-ink transition-colors"
              >
                <span className="w-3 shrink-0 text-accent-ink">
                  {isActive && (
                    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                      <path d="M2.5 5.5l2 2 4-4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </span>
                <span className="truncate">{p.name}</span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
