import { type TunnelPublicHost } from "../AppConfigContext";

/**
 * The hosts a Connect/Reconnect would publish, listed under the hostname field.
 *
 * Two things changed with mockup 32. It is no longer amber — amber now means
 * "you need to act", and a list of hostnames is information, not a warning. And
 * it renders in exactly one place: this panel used to be paired with an
 * identical amber "Accessible hosts" list in the live status, and in the steady
 * state the two said the same thing while a draft edit made them silently
 * disagree. Live hosts belong to TunnelStatusStrip; this one is always the
 * staged config.
 */
export default function TunnelPublicHostsPanel({
  hosts,
  drifted = false,
}: {
  hosts: TunnelPublicHost[];
  /** Tints the list when these hosts differ from what's actually running. */
  drifted?: boolean;
}) {
  if (hosts.length === 0) return null;

  return (
    <ul className="mt-2.5 pt-2 border-t border-subtle space-y-1">
      {hosts.map(({ host, kind }) => (
        <li
          key={host}
          className={`flex items-center gap-2 font-mono text-[11.5px] min-w-0 ${
            drifted ? "text-warn" : "text-ink-2"
          }`}
        >
          {/* Filled dot for the primary host, hollow for extras / port bindings. */}
          <span
            className={`shrink-0 w-1.5 h-1.5 rounded-full ${
              kind === "primary"
                ? drifted ? "bg-warn" : "bg-accent"
                : `border ${drifted ? "border-warn/60" : "border-accent/60"} bg-transparent`
            }`}
            aria-label={kind === "primary" ? "primary" : kind}
          />
          <span className="truncate" title={host}>{host}</span>
          <span className="ml-auto shrink-0 font-sans text-[10px] text-ink-3">
            {drifted && kind === "primary"
              ? "will publish"
              : kind === "primary"
                ? "primary"
                : kind === "binding"
                  ? "port binding"
                  : "extra subdomain"}
          </span>
        </li>
      ))}
    </ul>
  );
}
