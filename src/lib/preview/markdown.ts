import MarkdownIt from "markdown-it";

/**
 * Markdown renderer for git file previews. Replaces the extension's hand-rolled
 * md-util.js; parity with it is asserted in markdown.test.ts against golden
 * fixtures under fixtures/markdown/.
 *
 * Mermaid fences are NOT rendered here — they become placeholders that
 * ./mermaid.ts hydrates lazily, so a preview with no diagram never pays for the
 * mermaid chunk.
 */
const md = new MarkdownIt({
  html: false, // previews render untrusted repo content — never pass raw HTML through
  linkify: true,
  breaks: false,
});

const MERMAID_INFO = /^mermaid\b/;

// Fenced blocks: mermaid becomes a placeholder, everything else keeps
// markdown-it's default rendering plus a language badge the extension also showed.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim();
  if (MERMAID_INFO.test(info)) {
    return `<pre class="md-mermaid" data-mermaid="${md.utils.escapeHtml(token.content)}"></pre>`;
  }
  const lang = info.split(/\s+/)[0] || "";
  const badge = lang ? `<span class="md-lang">${md.utils.escapeHtml(lang)}</span>` : "";
  return badge + defaultFence(tokens, idx, options, env, self);
};

// GFM task lists ("- [ ] foo" / "- [x] foo"): markdown-it has no built-in
// support for these, so the extension's rendered checkboxes would otherwise
// come out as literal "[ ]"/"[x]" text, violating the <input> floor. This
// core rule rewrites the leading marker on a list item's first inline token
// into a checkbox, mirroring the shape markdown-it-task-lists produces.
const TASK_MARKER = /^\[([ xX])\]\s(.*)$/s;

md.core.ruler.push("task_lists", (state) => {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length - 2; i++) {
    if (tokens[i].type !== "list_item_open") continue;
    const inline = tokens[i + 2];
    if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
    const first = inline.children[0];
    if (first.type !== "text") continue;
    const match = TASK_MARKER.exec(first.content);
    if (!match) continue;

    first.content = match[2];
    const checkboxToken = new state.Token("html_inline", "", 0);
    const checked = match[1].toLowerCase() === "x";
    checkboxToken.content = `<input class="md-check" type="checkbox" disabled${checked ? " checked" : ""} /> `;
    inline.children.unshift(checkboxToken);
  }
});

export function renderMarkdown(src: string): string {
  return md.render(src);
}

/**
 * Counts opening tags by name. Shared with the fixture generator's logic so the
 * two sides of the parity assertion measure the same thing.
 */
export function countElements(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b/gi)) {
    const tag = m[1].toLowerCase();
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}
