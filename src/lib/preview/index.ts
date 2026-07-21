import { highlightCode, langFromFence } from "./highlight";
import { renderMarkdown } from "./markdown";
import { hydrateMermaid } from "./mermaid";

/**
 * The preview pipeline: markdown → mermaid → syntax highlighting.
 *
 * The three modules deliberately don't know about each other — markdown emits
 * inert placeholders, mermaid and Shiki fill them in — so something has to put
 * them together, and that gluing is not a one-liner:
 *
 *  - highlightCode is async, so it cannot be markdown-it's synchronous
 *    `highlight` hook. Fences are post-processed on the DOM instead, the same
 *    way mermaid placeholders are.
 *  - Shiki returns a complete <pre class="shiki">, so it *replaces*
 *    markdown-it's <pre>, it does not fill it. The language attribute is
 *    carried across so the replacement is still labelled.
 *  - Fences carry language names, files carry extensions. langFromFence maps
 *    the first onto the ids the rest of the module speaks.
 *
 * Mermaid runs before highlighting so a diagram never reaches the fence walk;
 * placeholders carry no <code>, so the two passes can't collide either way.
 */
export interface PreviewOptions {
  /** Whether the surrounding surface is dark. Only mermaid needs to know. */
  dark: boolean;
}

/**
 * Renders markdown into `root` and hydrates it in place. Resolves once the DOM
 * is final. Never rejects on bad content: an unparseable diagram becomes an
 * error node, an unsupported fence becomes escaped text.
 */
export async function renderPreview(
  root: HTMLElement,
  source: string,
  opts: PreviewOptions,
): Promise<void> {
  root.innerHTML = renderMarkdown(source);
  await hydrateMermaid(root, opts);
  await highlightFences(root);
}

/**
 * Replaces every markdown fence in `root` with its highlighted equivalent.
 * Exported separately because a caller that already has rendered markdown in
 * the DOM (a diff pane, an incrementally updated preview) needs this half
 * without re-rendering the markdown.
 */
export async function highlightFences(root: HTMLElement): Promise<void> {
  const pres = Array.from(root.querySelectorAll<HTMLPreElement>("pre.md-pre"));

  for (const pre of pres) {
    const code = pre.querySelector("code");
    if (!code) continue;

    const lang = langFromFence(pre.dataset.lang ?? "");
    // markdown-it keeps the fence's trailing newline in the token content;
    // handing it to Shiki would render an empty final line in every block.
    const source = (code.textContent ?? "").replace(/\n$/, "");
    const html = await highlightCode(source, lang);

    const holder = document.createElement("template");
    holder.innerHTML = html;
    const replacement = holder.content.firstElementChild;
    if (!replacement) continue;

    // Keep the markers the markdown pass put on the block: the surface styles
    // and labels fences through these, and Shiki's <pre> knows nothing of them.
    replacement.classList.add(...pre.classList);
    if (pre.dataset.lang) replacement.setAttribute("data-lang", pre.dataset.lang);
    pre.replaceWith(replacement);
  }
}

export { renderMarkdown, countElements } from "./markdown";
export { hydrateMermaid } from "./mermaid";
export type { MermaidOptions } from "./mermaid";
export {
  highlightCode,
  langFromPath,
  langFromFence,
  isSupportedLang,
  SYN_THEME_NAME,
} from "./highlight";
