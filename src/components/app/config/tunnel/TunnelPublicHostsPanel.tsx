import { type TunnelPublicHost } from "../AppConfigContext";

/** Amber host list used for both "This app will expose" (configured hosts) and
 *  "Accessible hosts" (live hosts). Renders nothing when the list is empty. */
export default function TunnelPublicHostsPanel({
  hosts,
  title = "This app will expose",
}: {
  hosts: TunnelPublicHost[];
  title?: string;
}) {
  if (hosts.length === 0) return null;

  return (
    <div className="mt-3 rounded-lg bg-warn-bg border border-[rgba(251,191,36,0.15)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[rgba(251,191,36,0.1)]">
        <p className="text-[10px] text-ink-2 font-medium">{title}</p>
        <span className="text-[9px] uppercase tracking-wider text-warn leading-none">
          {hosts.length} {hosts.length === 1 ? "host" : "hosts"}
        </span>
      </div>
      <ul className="px-3 py-2 space-y-1">
        {hosts.map(({ host, kind }) => (
          <li key={host} className="flex items-center gap-2 font-mono text-[11px] text-warn min-w-0">
            {/* Filled dot for the primary host, hollow for extras / port bindings. */}
            <span
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                kind === "primary"
                  ? "bg-warn"
                  : "border border-[rgba(251,191,36,0.5)] bg-transparent"
              }`}
              aria-label={kind === "primary" ? "primary" : kind}
            />
            <span className="truncate" title={host}>{host}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
