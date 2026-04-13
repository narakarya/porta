import { usePortaStore } from "../../store";

export default function NotificationsSection() {
  const { notificationsEnabled, setNotificationsEnabled } = usePortaStore();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[16px] font-semibold text-zinc-100">Notifications</h1>
        <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
          macOS notifications for app lifecycle events.
        </p>
      </div>

      <div className="flex flex-col gap-4 p-5 rounded-xl bg-white/[0.03] border border-white/[0.07]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[13px] font-medium text-zinc-200">Enable notifications</p>
            <p className="text-[11px] text-zinc-500 mt-0.5 leading-relaxed">
              Show macOS notifications when apps are ready, crash, or hit retry limits.
            </p>
          </div>
          <button
            onClick={() => setNotificationsEnabled(!notificationsEnabled)}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${
              notificationsEnabled ? "bg-blue-600" : "bg-zinc-700"
            }`}
          >
            <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
              notificationsEnabled ? "left-[18px]" : "left-0.5"
            }`} />
          </button>
        </div>

        <div className="h-px bg-white/[0.05]" />

        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-medium text-zinc-500 uppercase tracking-wider">Events</p>
          {[
            { icon: "✓", label: "App is ready", desc: "Port accepting connections" },
            { icon: "✗", label: "App crashed", desc: "Process exited with non-zero code" },
            { icon: "✗", label: "Max retries reached", desc: "App stopped after all retry attempts" },
          ].map((row) => (
            <div key={row.label} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04]">
              <span className={`text-[12px] font-mono w-4 shrink-0 ${row.icon === "✓" ? "text-emerald-400" : "text-red-400"}`}>{row.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] text-zinc-300">{row.label}</p>
                <p className="text-[11px] text-zinc-600">{row.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
