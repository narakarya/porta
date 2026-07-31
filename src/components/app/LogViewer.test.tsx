import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import LogViewer from "./LogViewer";

// The viewer reads its history over IPC. jsdom has no Tauri, so the real
// wrapper resolves `[]` and every test would render an empty pane — hand it a
// buffer instead. `isTauri` stays false, so no event subscription is attempted.
const history = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../../lib/commands", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/commands")>();
  return {
    ...actual,
    isTauri: false,
    getAppLogs: vi.fn(async () => history.lines),
    clearAppLogFile: vi.fn(async () => {}),
  };
});

// virtua only mounts rows near the viewport, and jsdom reports every element as
// zero-height — so the real virtualizer renders a single row and the assertions
// below would be measuring jsdom, not the filter. Render every child instead.
vi.mock("virtua", () => ({
  Virtualizer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const LOGS = [
  "10:00:01 [info] GET /api/users 200",
  "10:00:02 [error] Postgrex.Error during query",
  "10:00:02     SELECT * FROM users WHERE id = $1",
  "10:00:02     ↳ MyApp.Repo.get/2, at: lib/my_app/repo.ex:14",
  "10:00:03 [info] GET /health 200",
  "10:00:04 [warn] request timeout after 30s",
];

function setup(lines = LOGS) {
  history.lines = lines;
  return render(
    <LogViewer
      appId="app-1"
      appName="demo"
      logs={[]}
      isRunning
      onClose={() => {}}
      onClear={() => {}}
      embedded
    />,
  );
}

/** Visible log rows, by their gutter line number. */
function visibleSeqs(): number[] {
  return screen
    .getAllByTestId("log-row")
    .map((el) => Number(el.getAttribute("data-seq")));
}

// Opening focuses (and selects) the input from a rAF callback. Typing before
// that lands loses the leading keystrokes to the select-all, so wait for focus.
async function openWidget(
  user: ReturnType<typeof userEvent.setup>,
  mode: "filter" | "find",
) {
  const [label, placeholder] =
    mode === "filter"
      ? (["Filter lines by text", "Filter lines…"] as const)
      : (["Find in logs", "Find in logs…"] as const);
  await user.click(screen.getByLabelText(label));
  const input = screen.getByPlaceholderText(placeholder);
  await vi.waitFor(() => expect(input).toHaveFocus());
  return input;
}

const openFilter = (user: ReturnType<typeof userEvent.setup>) => openWidget(user, "filter");

describe("LogViewer text filter", () => {
  beforeEach(() => {
    history.lines = LOGS;
  });

  it("shows every line before a filter is typed", async () => {
    setup();
    expect(await screen.findAllByTestId("log-row")).toHaveLength(LOGS.length);
  });

  it("hides lines that do not match", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, "health");

    await vi.waitFor(() => expect(visibleSeqs()).toEqual([4]));
  });

  it("keeps a matched entry's continuation lines with it", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    // Matches the `[error]` header only — its SQL body and `↳ caller` must ride
    // along or the stacktrace is stranded under nothing.
    await user.type(input, "postgrex");

    await vi.waitFor(() => expect(visibleSeqs()).toEqual([1, 2, 3]));
  });

  it("matches terms found on a continuation line, not just the header", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    // "error" is on the header, "repo.ex" only on the third line of the entry.
    await user.type(input, "error repo.ex");

    await vi.waitFor(() => expect(visibleSeqs()).toEqual([1, 2, 3]));
  });

  it("drops entries containing an excluded term", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    // Without the exclusion this is [0, 4] — the exclusion is what drops the
    // /health line.
    await user.type(input, "200 -health");

    await vi.waitFor(() => expect(visibleSeqs()).toEqual([0]));
  });

  it("treats a quoted phrase as one term", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, '"request timeout"');

    await vi.waitFor(() => expect(visibleSeqs()).toEqual([5]));
  });

  it("reports how many lines survived, and says so when none did", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, "users");
    await vi.waitFor(() => expect(screen.getByText("4 lines")).toBeInTheDocument());

    await user.clear(input);
    await user.type(input, "nothingmatchesthis");
    await vi.waitFor(() =>
      expect(screen.getByText(/No lines match “nothingmatchesthis”/)).toBeInTheDocument(),
    );
    expect(screen.queryAllByTestId("log-row")).toHaveLength(0);
  });

  it("highlights the matched terms in the surviving lines", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, "health");

    await vi.waitFor(() => {
      const marks = screen.getAllByTestId("log-row")[0].querySelectorAll("mark");
      expect([...marks].map((m) => m.textContent)).toEqual(["health"]);
    });
  });

  it("restores every line when the filter is closed", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, "health");
    await vi.waitFor(() => expect(visibleSeqs()).toEqual([4]));

    // A filter that outlives its visible input would keep hiding lines with
    // nothing on screen to explain why.
    await user.click(screen.getByLabelText("Filter lines by text"));
    await vi.waitFor(() => expect(screen.getAllByTestId("log-row")).toHaveLength(LOGS.length));
  });

  it("leaves every line on screen in Find mode", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    await user.type(await openWidget(user, "find"), "health");

    // Find highlights and counts; it does not narrow.
    await vi.waitFor(() => expect(screen.getByText("1/1")).toBeInTheDocument());
    expect(screen.getAllByTestId("log-row")).toHaveLength(LOGS.length);
  });

  it("combines with the level filter", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findAllByTestId("log-row");

    const input = await openFilter(user);
    await user.type(input, "10:00:0");
    await vi.waitFor(() => expect(screen.getAllByTestId("log-row")).toHaveLength(LOGS.length));

    await user.click(screen.getByRole("button", { name: "Info" }));
    await vi.waitFor(() => expect(visibleSeqs()).toEqual([0, 4]));
  });
});
