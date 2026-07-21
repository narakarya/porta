import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useEffect, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MermaidControls from "./MermaidControls";

/**
 * Stands in for MarkdownPreview: a node React declares no children for, whose
 * contents arrive imperatively — exactly how `renderPreview` and
 * `hydrateMermaid` deliver a hydrated diagram. Driving the controls through
 * this (rather than through JSX children) is the point: the controls have to
 * notice DOM they did not render.
 */
function Preview({ html }: { html: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = html;
  }, [html]);
  return (
    <MermaidControls>
      <div ref={hostRef} className="md-body" />
    </MermaidControls>
  );
}

// What `hydrateMermaid` leaves behind: the placeholder <pre> with Mermaid's
// SVG inside it. The viewBox is the intrinsic size the controls scale from —
// Mermaid always emits one, and unlike a measured box it survives our own
// resizing, so it stays a stable base across repeated zooms.
const DIAGRAM_HTML =
  '<h1>Diagram</h1><pre class="md-mermaid">' +
  '<svg id="md-mermaid-0" viewBox="0 0 400 200" width="100%" style="max-width: 400px;">' +
  "<g></g></svg></pre>";

const PLAIN_HTML = "<h1>Release notes</h1><p>No diagram here.</p>";

/** jsdom implements no Fullscreen API at all. This is the whole of it that the
 *  component touches, and it is restored after every test so nothing leaks. */
let fullscreenElement: Element | null = null;
const realRequest = Element.prototype.requestFullscreen;
const realExit = document.exitFullscreen;

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Element.prototype.requestFullscreen = function requestFullscreen(this: Element) {
    fullscreenElement = this;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
  document.exitFullscreen = function exitFullscreen() {
    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    return Promise.resolve();
  };
});

afterEach(() => {
  Element.prototype.requestFullscreen = realRequest;
  document.exitFullscreen = realExit;
  // Removes the own-property installed above, uncovering Document.prototype's
  // real (jsdom-absent) definition again.
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

async function diagram() {
  const view = render(<Preview html={DIAGRAM_HTML} />);
  await screen.findByRole("button", { name: "Zoom in" });
  const svg = view.container.querySelector<SVGSVGElement>(".md-mermaid svg")!;
  return { ...view, svg };
}

describe("MermaidControls", () => {
  it("stays out of the way when the preview holds no diagram", async () => {
    render(<Preview html={PLAIN_HTML} />);

    await screen.findByText("No diagram here.");
    // The controls arrive on a MutationObserver tick, so absence has to be
    // asserted after the DOM the observer would have reacted to is on screen.
    await waitFor(() => expect(screen.getByRole("heading")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom out" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Enter fullscreen" })).toBeNull();
  });

  it("resizes the svg to zoom, and reset returns it to its original size", async () => {
    const { svg } = await diagram();

    // The baseline the controls normalise a freshly hydrated diagram to: its
    // intrinsic viewBox size.
    expect(svg.style.width).toBe("400px");
    expect(svg.style.height).toBe("200px");

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(parseFloat(svg.style.width)).toBeGreaterThan(400);
    expect(parseFloat(svg.style.height)).toBeGreaterThan(200);
    // Aspect ratio is preserved — this is a resize, not a stretch.
    expect(parseFloat(svg.style.width) / parseFloat(svg.style.height)).toBeCloseTo(2, 5);

    await userEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(svg.style.width).toBe("400px");
    expect(svg.style.height).toBe("200px");
  });

  it("never scales with a transform — the extension's 0.7.49 lesson, which blurred diagram text", async () => {
    const { svg } = await diagram();

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));

    expect(svg.style.transform).toBe("");
    expect(svg.style.zoom).toBe("");
    expect(svg.getAttribute("transform")).toBeNull();
    expect(parseFloat(svg.style.width)).toBeGreaterThan(400);
  });

  it("zooms out below the diagram's intrinsic size and back", async () => {
    const { svg } = await diagram();

    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(parseFloat(svg.style.width)).toBeLessThan(400);

    await userEvent.click(screen.getByRole("button", { name: "Reset zoom" }));
    expect(svg.style.width).toBe("400px");
  });

  it("takes the preview surface fullscreen, and Escape leaves it", async () => {
    const { container } = await diagram();
    const surface = container.firstElementChild!;

    await userEvent.click(screen.getByRole("button", { name: "Enter fullscreen" }));

    // Rooted on the surface, not on the bare <svg>: the controls and the rest
    // of the document have to come along, otherwise fullscreen is a one-way
    // trip with no zoom and nothing else to read.
    await waitFor(() => expect(document.fullscreenElement).toBe(surface));
    expect(surface.querySelector(".md-body")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Exit fullscreen" })).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(document.fullscreenElement).toBeNull());
    expect(screen.getByRole("button", { name: "Enter fullscreen" })).toBeInTheDocument();
  });

  it("drops its controls when the preview switches to a document without a diagram", async () => {
    const { rerender } = await diagram();

    rerender(<Preview html={PLAIN_HTML} />);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull());
  });
});
