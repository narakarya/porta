import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPoll, __pollCount } from "./poll-scheduler";

/** jsdom's `visibilityState` is a read-only getter — redefine it, then fire the
 * event the scheduler actually listens for. */
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("poll scheduler", () => {
  const cleanups: Array<() => void> = [];
  const track = (stop: () => void) => {
    cleanups.push(stop);
    return stop;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
  });

  afterEach(() => {
    cleanups.splice(0).forEach((stop) => stop());
    vi.useRealTimers();
    expect(__pollCount()).toBe(0);
  });

  it("runs on its interval while the window is visible", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 1000));

    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not run before the first interval elapses", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 5000));

    vi.advanceTimersByTime(4000);
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs straight away when asked to", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 5000, { immediate: true }));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("pauses a foreground poll while the window is hidden", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 1000));

    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(2);

    setVisibility("hidden");
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps a background poll running while hidden", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 1000, { background: true }));

    setVisibility("hidden");
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("catches up exactly once when the window comes back", () => {
    const fn = vi.fn();
    track(registerPoll(fn, 1000));

    setVisibility("hidden");
    vi.advanceTimersByTime(10_000); // ten intervals missed
    expect(fn).not.toHaveBeenCalled();

    setVisibility("visible");
    // One catch-up run — not one per interval that elapsed while hidden.
    expect(fn).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops the shared timer entirely when every poll is paused", () => {
    track(registerPoll(vi.fn(), 1000));
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // The point of the pause is that the process goes quiet, not merely that
    // the callbacks are skipped on each tick.
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);

    setVisibility("visible");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("keeps ticking while hidden if a background poll still needs it", () => {
    track(registerPoll(vi.fn(), 1000, { background: true }));
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });

  it("skips a slow async poll instead of stacking another run on top", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = vi.fn(() => pending);
    track(registerPoll(fn, 1000));

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    // Three more intervals pass while the first call is still in flight.
    await vi.advanceTimersByTimeAsync(3000);
    expect(fn).toHaveBeenCalledTimes(1);

    release();
    await pending;

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("lets one throwing poll keep running alongside the others", () => {
    const boom = vi.fn(() => {
      throw new Error("poll blew up");
    });
    const fine = vi.fn();
    track(registerPoll(boom, 1000));
    track(registerPoll(fine, 1000));

    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(fine).toHaveBeenCalledTimes(2);
    expect(boom).toHaveBeenCalledTimes(2);
  });

  it("stops running once unregistered", () => {
    const fn = vi.fn();
    const stop = registerPoll(fn, 1000);

    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);

    stop();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("drives several polls off the one timer at their own cadences", () => {
    const fast = vi.fn();
    const slow = vi.fn();
    track(registerPoll(fast, 1000));
    track(registerPoll(slow, 3000));

    vi.advanceTimersByTime(3000);
    expect(fast).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});
