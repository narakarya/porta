import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePortaStore } from "../../store";
import { makeApp, makeWorkspace } from "../../test/fixtures";
import AppWorkbench from "./AppWorkbench";

// Heavy leaves that own their own canvases / IPC / iframes. None of them are
// what these tests are about.
vi.mock("../terminal/TerminalWorkspace", () => ({ default: () => <div data-testid="terminal" /> }));
vi.mock("./AppAccessPopover", () => ({ default: () => <div /> }));
vi.mock("../app/GitBadge", () => ({ default: () => <div /> }));
vi.mock("../app/DockerUpdateBadge", () => ({ default: () => <div /> }));
vi.mock("../extension/ExtensionActionButtons", () => ({ default: () => <div /> }));
vi.mock("./RunOnBranchPicker", () => ({ default: () => <div /> }));
vi.mock("../app/LogToast", () => ({
  default: ({ appName, crashed }: { appName: string; crashed?: boolean }) => (
    <div data-testid="log-toast" data-crashed={String(!!crashed)}>
      {appName}
    </div>
  ),
}));

const app = makeApp();

function seed(over: Record<string, unknown> = {}) {
  usePortaStore.setState({
    apps: [app],
    workspaces: [makeWorkspace()],
    appLogs: {},
    appExitCode: {},
    appRestarting: {},
    healthStatuses: {},
    instances: {},
    appGit: {},
    setupStatus: null,
    extensionSidebar: null,
    pinnedExtensions: [],
    notices: [],
    refreshInstances: vi.fn(async () => {}),
    startApp: vi.fn(async () => {}),
    stopApp: vi.fn(async () => {}),
    restartApp: vi.fn(async () => {}),
    ...over,
  });
}

describe("AppWorkbench lifecycle controls", () => {
  beforeEach(() => seed());

  it("offers a single Start button when stopped", () => {
    render(<AppWorkbench app={app} />);
    expect(screen.getByRole("button", { name: /^Start$/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Stop$/ })).not.toBeInTheDocument();
  });

  it("turns that same button into Starting rather than adding a separate pill", () => {
    render(<AppWorkbench app={makeApp({ status: "starting" })} />);

    // One control, relabelled — not "Start" plus a disabled "Starting" chip.
    expect(screen.getByRole("button", { name: /Starting/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Start$/ })).not.toBeInTheDocument();
    // Stop is appended so a hanging boot can be aborted.
    expect(screen.getByRole("button", { name: /^Stop$/ })).toBeInTheDocument();
  });

  it("keeps Stop before Restart while restarting, so Restart never changes slot", () => {
    seed({ appRestarting: { app1: true } });
    render(<AppWorkbench app={makeApp({ status: "starting" })} />);

    const buttons = screen
      .getAllByRole("button")
      .map((b) => b.textContent?.trim())
      .filter((t): t is string => !!t);
    const stop = buttons.findIndex((t) => t === "Stop");
    const restarting = buttons.findIndex((t) => t === "Restarting");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(restarting).toBeGreaterThan(stop);
    // Running shows [Stop][Restart]; restarting must keep the same order.
    expect(screen.queryByRole("button", { name: /Starting/ })).not.toBeInTheDocument();
  });

  it("reports a failed start instead of throwing into an unhandled rejection", async () => {
    seed({ startApp: vi.fn(async () => { throw new Error("bind: address already in use"); }) });
    render(<AppWorkbench app={app} />);

    await userEvent.click(screen.getByRole("button", { name: /^Start$/ }));

    const notices = usePortaStore.getState().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0].kind).toBe("error");
    expect(notices[0].detail).toContain("address already in use");
  });
});

describe("AppWorkbench crash surface", () => {
  beforeEach(() => seed());

  it("shows a crash badge and exit code, not a plain 'stopped'", () => {
    seed({ appExitCode: { app1: 137 } });
    render(<AppWorkbench app={app} />);

    expect(screen.getByText(/crashed \(137\)/)).toBeInTheDocument();
    expect(screen.getByText(/Exited with code 137/)).toBeInTheDocument();
  });

  it("labels the start button Restart after a crash", () => {
    seed({ appExitCode: { app1: 1 } });
    render(<AppWorkbench app={app} />);
    expect(screen.getByRole("button", { name: /^Restart$/ })).toBeInTheDocument();
  });

  it("stays neutral on a clean exit", () => {
    seed({ appExitCode: { app1: 0 } });
    render(<AppWorkbench app={app} />);
    expect(screen.queryByText(/crashed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Exited with code/)).not.toBeInTheDocument();
  });
});

describe("AppWorkbench log toast", () => {
  beforeEach(() => seed());

  it("opens when the app starts", async () => {
    const { rerender } = render(<AppWorkbench app={app} />);
    expect(screen.queryByTestId("log-toast")).not.toBeInTheDocument();

    rerender(<AppWorkbench app={makeApp({ status: "starting" })} />);
    expect(await screen.findByTestId("log-toast")).toBeInTheDocument();
  });

  it("stays quiet while the Logs tab is the active surface", async () => {
    const { rerender } = render(<AppWorkbench app={app} />);
    await userEvent.click(screen.getByRole("button", { name: /Logs/ }));

    rerender(<AppWorkbench app={makeApp({ status: "starting" })} />);
    expect(screen.queryByTestId("log-toast")).not.toBeInTheDocument();
  });
});

describe("AppWorkbench pinned extension tabs", () => {
  const ext = {
    id: "kamal",
    name: "Kamal",
    version: "1.0.0",
    description: "",
    author: "",
    enabled: true,
    path: "/x",
    main_path: "/x/index.html",
    contributes_app_actions: [],
    permissions: [],
    activate_on: ["*"],
  };

  beforeEach(() => seed({ pinnedExtensions: ["kamal"], appExtensionsCache: { app1: [ext] } }));

  it("does not add a tab for an extension this app has no match for", () => {
    render(<AppWorkbench app={app} />);
    // getExtensionsForApp resolves to [] outside Tauri, so no pinned tab.
    expect(screen.queryByRole("button", { name: /Kamal/ })).not.toBeInTheDocument();
  });
});

describe("AppWorkbench overview affordances", () => {
  beforeEach(() => seed());

  it("exposes the root dir as a Finder target, not inert text", async () => {
    render(<AppWorkbench app={app} />);
    expect(
      await screen.findByRole("button", { name: "Show /Users/dev/web in Finder" })
    ).toBeInTheDocument();
  });

  it("offers copy for the URL and every domain", async () => {
    render(<AppWorkbench app={app} />);
    expect(await screen.findByRole("button", { name: "Copy URL" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy web.narakarya.test" })).toBeInTheDocument();
  });
});
