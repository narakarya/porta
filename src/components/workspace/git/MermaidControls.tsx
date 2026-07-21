import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Zoom and fullscreen for rendered Mermaid diagrams, wrapped around the
 * preview surface.
 *
 * These deliberately do not live in src/lib/preview: that module hydrates and
 * owns no UI, so it stays reusable outside the git tab. The controls belong to
 * the surface that shows the result, which is this one.
 *
 * The children are React's, but their *contents* are not — `MarkdownPreview`
 * hands `renderPreview` a node React declares no children for and the diagram
 * appears inside it asynchronously, well after this component's first render.
 * So diagrams are discovered with a MutationObserver rather than from props,
 * and the toolbar is absent until one actually exists.
 */

/** Discrete steps rather than a continuous factor: every click lands on a
 *  predictable size, and reset is exactly `ZOOM_STEPS[BASE_INDEX]` again. */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
const BASE_INDEX = ZOOM_STEPS.indexOf(1);

/**
 * The diagram's intrinsic size, taken from the viewBox Mermaid emits.
 *
 * The viewBox is the right source precisely because it is the one dimension we
 * never write to: reading back a width we set last click would compound
 * rounding on every zoom, and reading a measured box would return zeroes in a
 * pane that is scrolled out of view. Falls back to numeric width/height
 * attributes, then gives up — a diagram of unknown size is left alone rather
 * than resized to a guess.
 */
function baseSize(svg: SVGSVGElement): { width: number; height: number } | null {
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
      return { width: parts[2], height: parts[3] };
    }
  }
  const width = Number.parseFloat(svg.getAttribute("width") ?? "");
  const height = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return null;
}

/**
 * Resizes the SVG. Not a CSS transform on purpose: the extension shipped zoom
 * as `transform: scale()` in 0.7.48 and replaced it in 0.7.49 because scaling
 * a rasterised layer blurs the diagram's text. Giving the SVG a larger box
 * makes the renderer lay the vectors out at that size, so text stays crisp at
 * every step.
 *
 * Mermaid's own inline `max-width: Npx` would clamp anything above 100%, so it
 * is lifted while zoomed in; at or below the intrinsic size it goes back to
 * fitting the pane, which is what git-preview.css expects.
 */
function applyZoom(svg: SVGSVGElement, zoom: number): void {
  const base = baseSize(svg);
  if (!base) return;
  svg.style.width = `${Math.round(base.width * zoom)}px`;
  svg.style.height = `${Math.round(base.height * zoom)}px`;
  svg.style.maxWidth = zoom > 1 ? "none" : "100%";
}

const BUTTON_CLASS =
  "px-1.5 py-0.5 text-ink-2 hover:bg-[var(--hover)] hover:text-ink " +
  "disabled:opacity-40 disabled:pointer-events-none transition-colors duration-fast";

export default function MermaidControls({ children }: { children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [diagramCount, setDiagramCount] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(BASE_INDEX);
  const [fullscreen, setFullscreen] = useState(false);

  // Diagram discovery. `childList`/`subtree` only — the attribute writes
  // applyZoom makes below are deliberately not observed, so resizing a diagram
  // can never feed back into the scan that resized it.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const scan = () => {
      const found = surface.querySelectorAll(".md-mermaid svg").length;
      setDiagramCount((previous) => (previous === found ? previous : found));
      // A preview with no diagram at all is also a new document: start the
      // next one that does have one back at 100% rather than at whatever the
      // last file was left on.
      if (found === 0) setZoomIndex(BASE_INDEX);
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(surface, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // Normalises every diagram to the current zoom — on a zoom change, and on
  // discovery, so a diagram that hydrates while zoomed in matches the rest.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface
      .querySelectorAll<SVGSVGElement>(".md-mermaid svg")
      .forEach((svg) => applyZoom(svg, ZOOM_STEPS[zoomIndex]));
  }, [zoomIndex, diagramCount]);

  // The browser owns fullscreen state; this only mirrors it. Exits triggered
  // outside the toolbar — the UA's own Escape handling, an F11, another
  // element taking over — arrive here and nowhere else.
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === surfaceRef.current);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const exitFullscreen = useCallback(() => {
    // Only ever leaves *our* fullscreen. The UA may already have left on its
    // own by the time this runs (its own Escape handling got there first), and
    // exitFullscreen() rejects when nothing is fullscreen; more importantly, a
    // blind call would yank some unrelated element out of fullscreen.
    if (document.fullscreenElement !== surfaceRef.current) return;
    void document.exitFullscreen().catch(() => {});
  }, []);

  // Escape while fullscreen. Browsers exit on Escape themselves, but a Tauri
  // WebView is not a browser chrome and the key can be swallowed before the UA
  // sees it; handling it here makes the way out explicit. Double-exit is
  // harmless — the guard above turns the second call into a no-op.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      exitFullscreen();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, exitFullscreen]);

  // Unmounting while still fullscreen — the user switches file or tab from a
  // fullscreen diagram — would strand the window in fullscreen over a detached
  // node. The element is captured up front because React has already nulled
  // the ref by the time this cleanup runs.
  useEffect(() => {
    const surface = surfaceRef.current;
    return () => {
      if (surface && document.fullscreenElement === surface) {
        void document.exitFullscreen().catch(() => {});
      }
    };
  }, []);

  function toggleFullscreen() {
    const surface = surfaceRef.current;
    if (!surface) return;
    if (document.fullscreenElement === surface) {
      exitFullscreen();
      return;
    }
    if (typeof surface.requestFullscreen !== "function") return;
    // Rejects when the UA declines (no user activation, a policy block); the
    // pane simply stays as it was, and `fullscreenchange` never fires.
    void surface.requestFullscreen().catch(() => {});
  }

  const zoom = ZOOM_STEPS[zoomIndex];

  return (
    <div
      ref={surfaceRef}
      className={`relative ${fullscreen ? "h-full w-full overflow-auto bg-surface-0" : ""}`}
    >
      {diagramCount > 0 && (
        <div className="sticky top-0 z-10 flex justify-end px-2 pt-2">
          <div className="flex items-center overflow-hidden rounded-control border border-strong bg-surface-1 font-sans text-[11px]">
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
              disabled={zoomIndex === 0}
              className={`${BUTTON_CLASS} border-r border-strong`}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Reset zoom"
              title="Reset zoom"
              onClick={() => setZoomIndex(BASE_INDEX)}
              className={`${BUTTON_CLASS} border-r border-strong tabular-nums`}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              className={`${BUTTON_CLASS} border-r border-strong`}
            >
              +
            </button>
            <button
              type="button"
              aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              onClick={toggleFullscreen}
              className={BUTTON_CLASS}
            >
              {fullscreen ? "Exit" : "Fullscreen"}
            </button>
          </div>
        </div>
      )}
      {children}
    </div>
  );
}
