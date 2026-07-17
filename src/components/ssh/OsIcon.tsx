// Termius-style OS badges: real, recognizable, brand-colored inline SVG logos.
// Maps a detected remote-OS string (from `uname` / `/etc/os-release`) to a small
// hand-authored mark. No icon font in the app — every glyph is a clean SVG path.
//
// Matching is lowercased substring; order matters (specific distros before the
// generic "linux" → Tux fallback). Never uses opacity modifiers on token colors.

type Props = { os?: string | null; size?: number };

export function OsIcon({ os, size = 16 }: Props) {
  return (
    <span
      className="inline-flex items-center justify-center shrink-0"
      style={{ width: size, height: size }}
      aria-hidden
    >
      {mark(os, size)}
    </span>
  );
}

function mark(os: string | null | undefined, size: number) {
  const s = (os ?? "").toLowerCase();

  if (s.includes("darwin") || s.includes("mac os") || s.includes("macos")) return <Apple size={size} />;
  if (s.includes("windows")) return <Windows size={size} />;
  if (s.includes("ubuntu")) return <Ubuntu size={size} />;
  if (s.includes("debian")) return <Debian size={size} />;
  if (s.includes("fedora")) return <Fedora size={size} />;
  if (s.includes("rocky") || s.includes("alma")) return <Fedora size={size} />;
  if (s.includes("red hat") || s.includes("redhat") || s.includes("rhel") || s.includes("centos"))
    return <RedHat size={size} />;
  if (s.includes("alpine")) return <Alpine size={size} />;
  if (s.includes("arch")) return <Arch size={size} />;
  if (s.includes("suse")) return <Suse size={size} />;
  if (s.includes("bsd")) return <Bsd size={size} />;
  if (s.includes("linux")) return <Tux size={size} />;
  return <Server size={size} />;
}

// ── macOS ── Apple silhouette (24-unit viewBox), light so it reads on dark. ──
function Apple({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#e7e7ea" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.05 12.536c-.026-2.949 2.406-4.363 2.515-4.433-1.371-2.005-3.504-2.279-4.263-2.309-1.816-.184-3.544 1.069-4.464 1.069-.92 0-2.34-1.042-3.85-1.014-1.98.029-3.805 1.151-4.824 2.925-2.056 3.563-.526 8.841 1.475 11.738.977 1.417 2.142 3.007 3.671 2.95 1.472-.059 2.028-.953 3.807-.953 1.779 0 2.279.953 3.836.925 1.583-.029 2.585-1.446 3.552-2.868 1.119-1.645 1.579-3.24 1.605-3.322-.035-.015-3.083-1.183-3.113-4.694z" />
      <path d="M14.09 4.062c.813-.984 1.361-2.353 1.212-3.716-1.171.047-2.588.78-3.428 1.764-.753.87-1.412 2.264-1.235 3.6 1.305.101 2.638-.663 3.451-1.648z" />
    </svg>
  );
}

// ── Ubuntu ── circle of friends: orange ring + 3 dots joined to a hub. ──
function Ubuntu({ size }: { size: number }) {
  const c = "#E95420";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="4.7" stroke={c} strokeWidth="1.2" />
      {/* spokes from hub to each friend */}
      <path d="M8 8 8 3.4M8 8 12 10.3M8 8 4 10.3" stroke={c} strokeWidth="1.1" />
      <circle cx="8" cy="8" r="1" fill={c} />
      <circle cx="8" cy="3.4" r="1.3" fill={c} />
      <circle cx="12" cy="10.3" r="1.3" fill={c} />
      <circle cx="4" cy="10.3" r="1.3" fill={c} />
    </svg>
  );
}

// ── Debian ── red open swirl (two concentric partial arcs). ──
function Debian({ size }: { size: number }) {
  const c = "#A81D33";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.6 3.9a4.7 4.7 0 1 0 1.3 5.2" stroke={c} strokeWidth="1.3" strokeLinecap="round" />
      <path d="M9.9 6.2a2.7 2.7 0 1 0 1 3" stroke={c} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ── Fedora / Rocky / Alma ── blue disc with a white "f". ──
function Fedora({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" fill="#3C6EB4" />
      <path
        d="M9.6 4.9c-.3-.1-.6-.15-.95-.15-1.35 0-2.1.8-2.1 2.2v.55H5.4v1.45h1.15v3.95h1.7V8.95h1.35V7.5H8.2v-.5c0-.55.28-.82.78-.82.2 0 .38.02.55.08z"
        fill="#ffffff"
      />
    </svg>
  );
}

// ── Red Hat / CentOS / RHEL ── red fedora-hat silhouette. ──
function RedHat({ size }: { size: number }) {
  const c = "#EE0000";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4.6 10c-.2-2 1.3-4 3.4-4s3.6 1.8 3.4 4c-1-.5-2.2-.75-3.4-.75S5.6 9.5 4.6 10z" fill={c} />
      <path d="M2.4 10.6c0-.6 2.5-1.1 5.6-1.1s5.6.5 5.6 1.1c0 .75-2.5 1.35-5.6 1.35S2.4 11.35 2.4 10.6z" fill={c} />
    </svg>
  );
}

// ── Alpine ── blue mountains. ──
function Alpine({ size }: { size: number }) {
  const c = "#0D597F";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1.5 12.8 5.8 5l2.5 4.4H6.9L5.8 7.4 4 12.8z" fill={c} />
      <path d="M8.4 12.8 10.6 8.8l2.3 4z" fill={c} />
    </svg>
  );
}

// ── Arch ── blue tent/pyramid with the signature bottom notch. ──
function Arch({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 2.5 2.6 13.5c1.9-1 3.7-1.55 5.4-1.55s3.5.55 5.4 1.55L8 2.5z"
        fill="#1793D1"
      />
    </svg>
  );
}

// ── SUSE / openSUSE ── green geeko-ish head. ──
function Suse({ size }: { size: number }) {
  const c = "#73BA25";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M2.9 8.8c0-2.55 2.05-4.4 4.75-4.4 1.7 0 2.95.8 4.15.8.75 0 1.35-.25 1.75-.65-.1 1.3-.95 2.05-2.1 2.2.75.5 1.15 1.3 1.15 2.25 0 1.9-1.6 3.35-4.05 3.35C4.85 14.55 2.9 11.35 2.9 8.8z"
        fill={c}
      />
      <circle cx="6.2" cy="8.3" r="0.95" fill="#ffffff" />
      <circle cx="6.2" cy="8.3" r="0.42" fill="#0d0d0f" />
    </svg>
  );
}

// ── Linux (generic) ── Tux penguin. ──
function Tux({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* body */}
      <path
        d="M8 1.6c-1.65 0-2.95 1.35-2.95 3.05 0 .5.06.9.1 1.35-.55.9-1.65 2.45-1.65 4.45 0 1.6.75 2.75 1.6 3.5.35.3.45.6.4 1-.05.35.2.65.6.65h4.2c.4 0 .65-.3.6-.65-.05-.4.05-.7.4-1 .85-.75 1.6-1.9 1.6-3.5 0-2-1.1-3.55-1.65-4.45.04-.45.1-.85.1-1.35 0-1.7-1.3-3.05-2.95-3.05z"
        fill="#1a1a1a"
      />
      {/* belly */}
      <path
        d="M8 6.3c-1.25 0-2.15 1.5-2.15 3.45 0 1.55.9 2.7 2.15 2.7s2.15-1.15 2.15-2.7C10.15 7.8 9.25 6.3 8 6.3z"
        fill="#ffffff"
      />
      {/* eyes */}
      <ellipse cx="6.8" cy="4.4" rx="0.72" ry="0.92" fill="#ffffff" />
      <ellipse cx="9.2" cy="4.4" rx="0.72" ry="0.92" fill="#ffffff" />
      <circle cx="6.95" cy="4.6" r="0.36" fill="#111111" />
      <circle cx="9.05" cy="4.6" r="0.36" fill="#111111" />
      {/* beak */}
      <path d="M7 5.2c0 .6.45 1 1 1s1-.4 1-1c0-.35-.45-.55-1-.55S7 4.85 7 5.2z" fill="#F5B800" />
      {/* feet */}
      <path d="M5.7 13.9c-.55.7-1.5.95-2.05.8-.3-.08-.35-.4-.05-.72.55-.6 1.4-1 2.1-1.05z" fill="#F5B800" />
      <path d="M10.3 13.9c.55.7 1.5.95 2.05.8.3-.08.35-.4.05-.72-.55-.6-1.4-1-2.1-1.05z" fill="#F5B800" />
    </svg>
  );
}

// ── Windows ── four blue tiles. ──
function Windows({ size }: { size: number }) {
  const c = "#00A4EF";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={c} xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="5.2" height="5.2" rx="0.4" />
      <rect x="8.8" y="2" width="5.2" height="5.2" rx="0.4" />
      <rect x="2" y="8.8" width="5.2" height="5.2" rx="0.4" />
      <rect x="8.8" y="8.8" width="5.2" height="5.2" rx="0.4" />
    </svg>
  );
}

// ── BSD ── little red daemon (horns + face). ──
function Bsd({ size }: { size: number }) {
  const c = "#C4211E";
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* horns */}
      <path d="M4.6 5.6C4 4.2 3.9 3.1 4.1 2.5c.65.5 1.3 1.5 1.7 2.8z" fill={c} />
      <path d="M11.4 5.6C12 4.2 12.1 3.1 11.9 2.5c-.65.5-1.3 1.5-1.7 2.8z" fill={c} />
      {/* head */}
      <path d="M8 4.6c2.2 0 4 1.85 4 4.25 0 2.55-1.8 4.3-4 4.3s-4-1.75-4-4.3C4 6.45 5.8 4.6 8 4.6z" fill={c} />
      {/* eyes */}
      <circle cx="6.6" cy="8" r="0.62" fill="#ffffff" />
      <circle cx="9.4" cy="8" r="0.62" fill="#ffffff" />
      {/* smile */}
      <path d="M6.3 10.3c.5.6 1 .9 1.7.9s1.2-.3 1.7-.9" stroke="#ffffff" strokeWidth="0.7" strokeLinecap="round" />
    </svg>
  );
}

// ── Fallback ── neutral stacked-server glyph, muted (text-ink-3). ──
function Server({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className="text-ink-3"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="2.5" y="3" width="11" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <rect x="2.5" y="9" width="11" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="4.6" cy="5" r="0.6" fill="currentColor" />
      <circle cx="4.6" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}
