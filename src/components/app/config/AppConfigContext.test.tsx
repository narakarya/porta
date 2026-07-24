import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { usePortaStore } from "../../../store";
import { makeApp, makeWorkspace } from "../../../test/fixtures";
import { useAppConfigDraft } from "./AppConfigContext";
import type { App } from "../../../types";

// The one invariant worth pinning: **a form nobody has touched is not dirty.**
//
// `isDirty` is ~35 comparisons of form state against the saved app, and it
// drives three things at once — the "Unsaved changes" footer, whether Save is
// enabled, and the discard-confirm on close. Any single comparison that can't
// converge poisons all three, and the symptom ("saved, still says unsaved") is
// identical no matter which one it was. Seven separate causes have been found
// this way, so the guard is written against the *class*: open the form over a
// representative app and assert nothing reads as an edit.
//
// Adding an app shape here is cheaper than the next round of bisecting a
// footer that won't go away.

function draft(app: App) {
  return renderHook(() => useAppConfigDraft(app, makeWorkspace(), () => {}));
}

beforeEach(() => {
  usePortaStore.setState({
    apps: [],
    workspaces: [makeWorkspace()],
    appTunnelErrors: {},
    setupStatus: null,
    updateApp: vi.fn(async () => {}),
    deleteApp: vi.fn(async () => {}),
    startTunnel: vi.fn(async () => {}),
    stopTunnel: vi.fn(async () => {}),
    setAppAutoSleep: vi.fn(async () => {}),
    setAppMaxUploadBytes: vi.fn(async () => {}),
  } as never);
});

describe("useAppConfigDraft — isDirty on open", () => {
  const cases: Array<[string, App]> = [
    ["a plain process app", makeApp()],
    [
      // The backend owns this path: it writes pasted YAML into Porta's managed
      // compose dir and stores the result, ignoring the null the form sends.
      // Comparing the form's null against that stored path opened every such
      // app already dirty.
      "a compose app on managed (pasted) YAML",
      makeApp({
        kind: "compose",
        compose_file: "/Users/dev/web/.porta/compose/app1.yml",
      }),
    ],
    [
      "a compose app pointed at its own file",
      makeApp({ kind: "compose", compose_file: "/Users/dev/web/docker-compose.yml" }),
    ],
    [
      // Auto-sleep never persists for these kinds — handleSave skips the call —
      // so a stored value the form disagrees with is unresolvable.
      "a static app carrying stored auto-sleep settings",
      makeApp({ kind: "static", auto_sleep_enabled: true, idle_timeout_secs: 600 }),
    ],
    [
      // Auth off + a username still on the row: save stores null regardless.
      "an app with a stored username but auth turned off",
      makeApp({ basic_auth_enabled: false, basic_auth_username: "admin" }),
    ],
    [
      "an app with per-host auth overrides",
      makeApp({
        basic_auth_enabled: true,
        basic_auth_username: "admin",
        basic_auth_password_set: true,
        host_auth_overrides: [
          { host: "web.narakarya.test", mode: "custom", username: "vip", password_set: true },
          { host: "admin.narakarya.test", mode: "off", username: null, password_set: false },
        ],
      }),
    ],
    [
      "an app running a named env profile",
      makeApp({
        env_vars: { MIX_ENV: "dev" },
        active_profile_id: "p1",
        env_profiles: [
          {
            id: "p1",
            name: "prod",
            env_file: ".env.prod",
            env_vars: { MIX_ENV: "prod", PORT: "4001" },
            start_command: "_build/prod/rel/web/bin/web start",
            build_command: "MIX_ENV=prod mix release",
          },
        ],
      }),
    ],
    [
      "an app with aliases, port bindings and a tunnel",
      makeApp({
        extra_subdomains: ["api", "admin"],
        port_bindings: [
          { id: "b1", label: "Admin", port: 4001, subdomain: "admin", custom_domain: null },
        ],
        custom_domain: "example.test",
        tunnel_name: "porta",
        tunnel_custom_hostname: "web.example.com",
        tunnel_alias_domain: "*.example.com",
        max_upload_bytes: 50 * 1024 * 1024,
      }),
    ],
  ];

  it.each(cases)("stays clean for %s", async (_label, app) => {
    const { result } = draft(app);
    // Compose apps read their YAML asynchronously; let that settle so the test
    // sees the steady state rather than the frame before the baseline lands.
    await waitFor(() => expect(result.current.isDirty).toBe(false));
  });
});

describe("useAppConfigDraft — the env editor follows the active profile", () => {
  const app = makeApp({
    env_file: ".env",
    env_vars: { MIX_ENV: "dev" },
    active_profile_id: "p1",
    env_profiles: [
      {
        id: "p1",
        name: "prod",
        env_file: ".env.prod",
        env_vars: { MIX_ENV: "prod", PORT: "4001" },
        start_command: null,
        build_command: null,
      },
    ],
  });

  // Not just a dirty-flag concern: `handleSave` writes whatever the editor is
  // showing back into the active profile, so opening on Default's values and
  // pressing Save replaced the prod profile's environment with them.
  it("opens on the profile's values, not the app's", () => {
    const { result } = draft(app);
    expect(result.current.envFile).toBe(".env.prod");
    expect(Object.fromEntries(result.current.envVars.map((v) => [v.key, v.value])))
      .toEqual({ MIX_ENV: "prod", PORT: "4001" });
  });

  it("swaps back to the app's values on Default", () => {
    const { result } = draft(app);
    act(() => result.current.selectProfile(null));
    expect(result.current.envFile).toBe(".env");
    expect(Object.fromEntries(result.current.envVars.map((v) => [v.key, v.value])))
      .toEqual({ MIX_ENV: "dev" });
  });
});

describe("useAppConfigDraft — edits that save would normalize away", () => {
  it("ignores whitespace typed around the start command", () => {
    // Save trims. Treating the untrimmed field as a diff meant the form could
    // never reach a clean state again.
    const { result } = draft(makeApp({ start_command: "mix phx.server" }));
    act(() => result.current.setStartCommand("  mix phx.server  "));
    expect(result.current.isDirty).toBe(false);
  });

  it("ignores a username typed while auth is off", () => {
    const { result } = draft(makeApp({ basic_auth_enabled: false, basic_auth_username: null }));
    act(() => result.current.setBasicAuthUsername("admin"));
    expect(result.current.isDirty).toBe(false);
  });

  it("still reports a real edit", () => {
    // The counterweight: none of the above may be achieved by making isDirty
    // lazy about actual changes.
    const { result } = draft(makeApp());
    act(() => result.current.setStartCommand("npm run dev"));
    expect(result.current.isDirty).toBe(true);
  });

  it("reports a username edit once auth is on", () => {
    const { result } = draft(makeApp({ basic_auth_enabled: true, basic_auth_username: "admin", basic_auth_password_set: true }));
    act(() => result.current.setBasicAuthUsername("root"));
    expect(result.current.isDirty).toBe(true);
  });
});
