/**
 * Lazy Mermaid hydration for rendered markdown. The mermaid package is large,
 * so it is imported only when a preview actually contains a diagram — a preview
 * without one never downloads the chunk.
 *
 * Rendering only: no toolbar, no injected chrome. The preview surface owns any
 * controls, so this module stays reusable outside the git tab — which is also
 * why the contract is `{ dark }` and not a palette id. Callers map their own
 * palette to a boolean; nothing here knows what a git-tab theme is.
 */
type Mermaid = typeof import("mermaid").default;

export interface MermaidOptions {
  /** Whether the surrounding surface is dark. Maps to Mermaid's dark/default theme. */
  dark: boolean;
}

let mermaidPromise: Promise<Mermaid> | null = null;
// The theme the cached instance was initialised with. Mermaid's config is
// global, so a palette flip has to re-run initialize() or every later diagram
// keeps the old theme.
let mermaidDark: boolean | null = null;

function getMermaid(dark: boolean): Promise<Mermaid> {
  if (mermaidPromise && mermaidDark === dark) return mermaidPromise;

  mermaidDark = dark;
  // import() is module-cached, so a flip re-initialises the one instance
  // rather than creating a second one; idSeq below never rewinds, so the ids
  // it hands out stay unique across flips too.
  const previous = mermaidPromise;
  mermaidPromise = (previous ?? import("mermaid").then((m) => m.default)).then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
    return mermaid;
  });
  return mermaidPromise;
}

let idSeq = 0;

export async function hydrateMermaid(root: HTMLElement, opts: MermaidOptions): Promise<void> {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre.md-mermaid[data-mermaid]"));
  if (blocks.length === 0) return;

  const mermaid = await getMermaid(opts.dark);

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
