import { useState } from "react";
import { usePortaStore } from "../../store";
import { sendTestNotification } from "../../lib/commands";

export default function NotificationsSection() {
  const { notificationsEnabled, setNotificationsEnabled, imageUpdateNotifyEnabled, setImageUpdateNotifyEnabled } = usePortaStore();
  const [testStatus, setTestStatus] = useState<"idle" | "sent" | "error">("idle");
  const [testError, setTestError] = useState<string>("");

  async function handleTest() {
    setTestError("");
    try {
      await sendTestNotification();
      setTestStatus("sent");
      setTimeout(() => setTestStatus("idle"), 4000);
    } catch (e) {
      setTestStatus("error");
      setTestError(e instanceof Error ? e.message : String(e));
    }
  }

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

        {/* Test + permission hint */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleTest}
              className="px-3 py-1.5 text-[12px] font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
            >
              Send test notification
            </button>
            {testStatus === "sent" && (
              <span className="flex items-center gap-1.5 text-[12px] text-emerald-400">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l2.5 2.5 5.5-5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                Sent — check Notification Center
              </span>
            )}
            {testStatus === "error" && (
              <span className="text-[12px] text-red-400">{testError || "Failed to send"}</span>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            Don't see anything? Open <span className="font-mono text-zinc-400">System Settings → Notifications</span> and allow notifications for{" "}
            <span className="font-mono text-zinc-400">Porta</span> (production build) or{" "}
            <span className="font-mono text-zinc-400">Terminal</span> (running via <span className="font-mono">tauri dev</span>).
            Also check that Focus / Do Not Disturb is off.
          </p>
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

          <div className={`flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.02] border border-white/[0.04] ${!notificationsEnabled ? "opacity-50 pointer-events-none" : ""}`}>
            <span className="text-[12px] font-mono w-4 shrink-0 text-amber-400">↑</span>
            <div className="flex-1 min-w-0">
              <p className="text-[12px] text-zinc-300">Image updates available</p>
              <p className="text-[11px] text-zinc-600">New version found during periodic check</p>
            </div>
            <button
              onClick={() => setImageUpdateNotifyEnabled(!imageUpdateNotifyEnabled)}
              disabled={!notificationsEnabled}
              className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
                imageUpdateNotifyEnabled && notificationsEnabled ? "bg-blue-600" : "bg-zinc-700"
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${
                imageUpdateNotifyEnabled && notificationsEnabled ? "left-[18px]" : "left-0.5"
              }`} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
