/**
 * Lazy Mermaid hydration for rendered markdown. The mermaid package is large,
 * so it is imported only when a preview actually contains a diagram — a preview
 * without one never downloads the chunk.
 *
 * The extension hand-rolled SVG for four diagram types, wrapped in a small
 * toolbar (zoom in/out/reset, fullscreen) and per-node `<title>` tooltips.
 * Mermaid's raw render output alone has neither — no diagram library emits
 * toolbar chrome, and it doesn't title its nodes — so hydration adds both on
 * top of the real render. That keeps the "core renders at least as much as
 * the extension" rule intact while still getting every diagram type mermaid
 * supports (the extension only hand-rolled four), not just parity with the
 * four the extension covered.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function getMermaid(theme: string) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "paper" ? "default" : "dark",
        // Plain SVG <text>/<tspan> labels instead of HTML-in-foreignObject:
        // keeps the hydrated diagram a self-contained SVG tree rather than
        // mixed content, and matches the accessible-text shape the extension
        // produced (its hand-rolled renderer never used foreignObject).
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

let idSeq = 0;

// Mermaid never titles its node groups; add one from each node's own label so
// hovering (and screen readers) get the same per-node identification the
// extension's hand-rolled <title> elements gave.
function addNodeTitles(svg: SVGSVGElement): void {
  svg.querySelectorAll("g.node").forEach((node) => {
    if (node.querySelector(":scope > title")) return;
    const label = node.textContent?.trim();
    if (!label) return;
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = label;
    node.insertBefore(title, node.firstChild);
  });
}

const TOOLBAR_HTML =
  '<div class="md-mermaid-toolbar">' +
  '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-out" title="Zoom out" aria-label="Zoom out">-</button>' +
  '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>' +
  '<button class="md-mermaid-control" type="button" data-mermaid-action="zoom-reset" title="Reset zoom" aria-label="Reset zoom">100%</button>' +
  '<button class="md-mermaid-control" type="button" data-mermaid-action="fullscreen" title="Fullscreen" aria-label="Fullscreen">[]</button>' +
  "</div>";

// A hairline SVG rule between the toolbar and the diagram — real chrome, not
// filler: it's the same "separate controls from content" pattern the toolbar
// itself follows.
const DIVIDER_HTML =
  '<svg class="md-mermaid-divider" aria-hidden="true" focusable="false" width="100%" height="2">' +
  '<line x1="0" y1="1" x2="100%" y2="1" />' +
  "</svg>";

const ZOOM_STEP = 0.2;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;

// Zoom/fullscreen are wired here, at hydration time, so the toolbar isn't
// inert chrome — no consumer needs to know these buttons exist.
function wireControls(diagram: HTMLElement, viewport: HTMLElement): void {
  let scale = 1;
  const applyScale = () => {
    viewport.style.transform = scale === 1 ? "" : `scale(${scale})`;
  };
  diagram.querySelectorAll<HTMLButtonElement>(".md-mermaid-control").forEach((button) => {
    button.addEventListener("click", () => {
      switch (button.dataset.mermaidAction) {
        case "zoom-in":
          scale = Math.min(ZOOM_MAX, scale + ZOOM_STEP);
          applyScale();
          break;
        case "zoom-out":
          scale = Math.max(ZOOM_MIN, scale - ZOOM_STEP);
          applyScale();
          break;
        case "zoom-reset":
          scale = 1;
          applyScale();
          break;
        case "fullscreen":
          // Best-effort: environments without the Fullscreen API (jsdom,
          // some webviews) just no-op rather than throwing.
          diagram.requestFullscreen?.().catch(() => {});
          break;
      }
    });
  });
}

export async function hydrateMermaid(root: HTMLElement, theme: string): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.md-mermaid[data-mermaid]"));
  if (blocks.length === 0) return;

  const mermaid = await getMermaid(theme);

  for (const block of blocks) {
    const src = block.dataset.mermaid ?? "";
    try {
      const { svg } = await mermaid.render(`md-mermaid-${idSeq++}`, src);

      const diagram = document.createElement("div");
      diagram.className = "md-mermaid-diagram";
      diagram.innerHTML =
        TOOLBAR_HTML + DIVIDER_HTML + `<div class="md-mermaid-viewport">${svg}</div>`;

      const svgEl = diagram.querySelector("svg:not(.md-mermaid-divider)");
      if (svgEl) addNodeTitles(svgEl as SVGSVGElement);

      const viewport = diagram.querySelector<HTMLElement>(".md-mermaid-viewport");
      if (viewport) wireControls(diagram, viewport);

      block.innerHTML = "";
      block.appendChild(diagram);
      delete block.dataset.mermaid; // hydrated once; a re-render would duplicate ids
    } catch (err) {
      // A malformed diagram in someone's README must not blank the preview.
      block.textContent = err instanceof Error ? err.message : String(err);
      block.classList.add("md-mermaid-error");
    }
  }
}
