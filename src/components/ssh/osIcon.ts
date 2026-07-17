// Maps a detected remote-OS string (from `uname`/`/etc/os-release`) to a small
// glyph shown on host cards / session tabs — à la Termius' OS badges.
export function osGlyph(os?: string | null): string {
  if (!os) return "🖥";
  const s = os.toLowerCase();
  if (s.includes("darwin") || s.includes("mac os") || s.includes("macos")) return "🍎";
  if (s.includes("windows")) return "🪟";
  if (s.includes("bsd")) return "😈";
  if (
    s.includes("ubuntu") ||
    s.includes("debian") ||
    s.includes("alpine") ||
    s.includes("fedora") ||
    s.includes("centos") ||
    s.includes("red hat") ||
    s.includes("rhel") ||
    s.includes("arch") ||
    s.includes("linux")
  )
    return "🐧";
  return "🖥";
}
