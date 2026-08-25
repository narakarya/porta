import { usePortaStore } from "../../store";
import { useShallow } from "zustand/react/shallow";
import { THEMES, ACCENTS, getTheme, resolveAccent, type Theme } from "../../lib/theme";

/** Miniature of the app chrome, painted from the theme's own values rather
 *  than the live CSS vars — that's the whole point: every card shows what it
 *  would look like without having to apply it first. */
function ThemePreview({ theme, accent }: { theme: Theme; accent: string }) {
  return (
    <div
      className="h-[62px] w-full rounded-[7px] overflow-hidden flex border"
      style={{ background: theme.surface0, borderColor: theme.borderSubtle }}
    >
      {/* rail */}
      <div className="w-[22%] flex flex-col gap-1 p-1.5" style={{ background: theme.surface1 }}>
        <div className="h-1 w-3/4 rounded-full" style={{ background: accent }} />
        <div className="h-1 w-full rounded-full" style={{ background: theme.ink3 }} />
        <div className="h-1 w-2/3 rounded-full" style={{ background: theme.ink3, opacity: 0.6 }} />
      </div>
      {/* content */}
      <div className="flex-1 p-1.5 flex flex-col gap-1.5">
        <div
          className="rounded-[3px] p-1.5 flex items-center gap-1"
          style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}` }}
        >
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: theme.success }} />
          <span className="h-1 flex-1 rounded-full" style={{ background: theme.ink1, opacity: 0.75 }} />
        </div>
        <div className="flex items-center gap-1">
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: theme.warning }} />
          <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: theme.danger }} />
          <span className="h-1 flex-1 rounded-full" style={{ background: theme.ink2, opacity: 0.5 }} />
        </div>
      </div>
    </div>
  );
}

export default function AppearanceSection() {
  const { theme, accent, setTheme, setAccent, copyOnSelect, setCopyOnSelect } = usePortaStore(
    useShallow((s) => ({
      theme: s.theme,
      accent: s.accent,
      setTheme: s.setTheme,
      setAccent: s.setAccent,
      copyOnSelect: s.terminalCopyOnSelect,
      setCopyOnSelect: s.setTerminalCopyOnSelect,
    })),
  );

  const activeTheme = getTheme(theme);

  return (
    <div className="flex flex-col gap-8 max-w-[720px]">
      <div>
        <h2 className="text-[15px] font-semibold text-ink mb-1">Appearance</h2>
        <p className="text-[12px] text-ink-3 leading-relaxed">
          Applies instantly and sticks between launches. Terminals repaint too.
          All themes are dark for now — a light one needs work that hasn't
          landed yet.
        </p>
      </div>

      {/* ── Theme ───────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-medium text-ink-2">Theme</h3>
        <div className="grid grid-cols-3 gap-3">
          {THEMES.map((t) => {
            const selected = t.id === theme;
            // Preview each card with the accent that card would actually get.
            const previewAccent = resolveAccent(t, ACCENTS.find((a) => a.id === accent) ?? ACCENTS[0]).color;
            return (
              <button
                key={t.id}
                onClick={() => setTheme(t.id)}
                aria-pressed={selected}
                title={t.blurb}
                className={`text-left p-2 rounded-card border transition-colors ${
                  selected
                    ? "border-[var(--accent)] bg-accent-bg"
                    : "border-subtle bg-surface-1 hover:bg-white/[0.04]"
                }`}
              >
                <ThemePreview theme={t} accent={previewAccent} />
                <div className="flex items-center gap-1.5 mt-2 px-0.5">
                  <span className={`text-[12px] truncate ${selected ? "text-ink" : "text-ink-2"}`}>
                    {t.name}
                  </span>
                  {selected && (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0 text-accent ml-auto">
                      <path d="M2.5 6.5l2.5 2.5 4.5-5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
                <p className="px-0.5 mt-0.5 text-[10px] text-ink-3 leading-snug line-clamp-2">{t.blurb}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Accent ──────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-[13px] font-medium text-ink-2">Accent</h3>
          <p className="text-[11px] text-ink-3 mt-0.5">
            Drives selection, links, focus rings and primary buttons. “Theme
            default” follows whatever the theme ships with.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {ACCENTS.map((a) => {
            const selected = a.id === accent;
            const swatch = a.color ?? activeTheme.accent;
            return (
              <button
                key={a.id}
                onClick={() => setAccent(a.id)}
                aria-pressed={selected}
                className={`flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-control border text-[12px] transition-colors ${
                  selected
                    ? "border-[var(--accent)] bg-accent-bg text-ink"
                    : "border-subtle bg-surface-1 text-ink-2 hover:bg-white/[0.05] hover:text-ink"
                }`}
              >
                <span
                  className="h-3.5 w-3.5 rounded-full shrink-0 border border-white/20"
                  style={{ background: swatch }}
                />
                {a.name}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Terminal ────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-medium text-ink-2">Terminal</h3>
        <label className="flex items-start gap-2.5 cursor-pointer">
          <input
            type="checkbox"
            checked={copyOnSelect}
            onChange={(e) => setCopyOnSelect(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="text-[12px] text-ink">Copy on select</span>
            <span className="block text-[11px] text-ink-3 mt-0.5">
              Selecting output puts it on the clipboard straight away, the way a
              log viewer does. ⌘C still works either way; turn this off if you
              would rather keep whatever is already on the clipboard.
            </span>
          </span>
        </label>
      </section>

      {/* ── Live sample ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-[13px] font-medium text-ink-2">Preview</h3>
        <div className="rounded-card border border-subtle bg-surface-1 p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="px-2 py-1 rounded-control text-[11px] bg-accent text-white">Primary</span>
            <span className="px-2 py-1 rounded-control text-[11px] bg-accent-bg border border-[var(--accent-border)] text-accent-ink">
              Secondary
            </span>
            <span className="px-2 py-1 rounded-control text-[11px] bg-white/[0.05] border border-subtle text-ink-2">
              Neutral
            </span>
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-2 py-1 rounded-control bg-ok-bg border border-[var(--success-border)] text-ok">running</span>
            <span className="px-2 py-1 rounded-control bg-warn-bg border border-[var(--warning-border)] text-warn">restarting</span>
            <span className="px-2 py-1 rounded-control bg-bad-bg border border-[var(--danger-border)] text-bad">crashed</span>
          </div>
          <div className="rounded-control bg-surface-code border border-subtle p-2.5 font-mono text-[11px] leading-relaxed">
            <div className="text-ink-3"># terminal colours follow the theme</div>
            <div>
              <span style={{ color: activeTheme.ansi.green }}>➜</span>{" "}
              <span style={{ color: activeTheme.ansi.cyan }}>porta</span>{" "}
              <span style={{ color: activeTheme.ansi.magenta }}>git:(</span>
              <span style={{ color: activeTheme.ansi.red }}>next</span>
              <span style={{ color: activeTheme.ansi.magenta }}>)</span>{" "}
              <span style={{ color: activeTheme.ink1 }}>npm run dev</span>
            </div>
            <div style={{ color: activeTheme.ansi.yellow }}>ready in 412 ms</div>
          </div>
          <input className="input-base" placeholder="Focus me to see the accent ring" spellCheck={false} />
        </div>
      </section>
    </div>
  );
}
