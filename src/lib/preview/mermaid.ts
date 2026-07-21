/**
 * Lazy Mermaid hydration for rendered markdown. The mermaid package is large,
 * so it is imported only when a preview actually contains a diagram — a preview
 * without one never downloads the chunk.
 *
 * Rendering only: no toolbar, no injected chrome. The preview surface owns any
 * controls, so this module stays reusable outside the git tab.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function getMermaid(theme: string) {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: theme === "paper" ? "default" : "dark",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

let idSeq = 0;

export async function hydrateMermaid(root: HTMLElement, theme: string): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.md-mermaid[data-mermaid]"));
  if (blocks.length === 0) return;

  const mermaid = await getMermaid(theme);

  for (const block of blocks) {
    const src = block.dataset.mermaid ?? "";
    try {
      const { svg } = await mermaid.render(`md-mermaid-${idSeq++}`, src);
      block.innerHTML = svg;
      delete block.dataset.mermaid; // hydrated once; a re-render would duplicate ids
    } catch (err) {
      // A malformed diagram in someone's README must not blank the preview.
      block.textContent = err instanceof Error ? err.message : String(err);
      block.classList.add("md-mermaid-error");
    }
  }
}
