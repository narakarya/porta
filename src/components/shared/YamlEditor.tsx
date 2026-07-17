import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { search } from "@codemirror/search";
import type { EditorView as EditorViewType } from "@codemirror/view";

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Minimum rows of content (editor won't shrink below this). Default 14. */
  rows?: number;
  /** Max height as CSS value. Default "60vh" — editor auto-grows with content. */
  maxHeight?: string;
  /** 1-based line number of a backend-reported error (from serde_yaml). */
  errorLine?: number;
  errorMessage?: string;
  /** Called once the CodeMirror EditorView is created (for external search control). */
  onReady?: (view: EditorViewType) => void;
  /** Disable CodeMirror's native Cmd+F search panel — set true when the parent supplies its own search UI. Default false. */
  disableNativeSearch?: boolean;
}

/**
 * CodeMirror 6 YAML editor.
 *
 * Features out of the box (from basicSetup): line numbers, bracket matching,
 * multi-cursor, Tab → indent, Cmd+/ to toggle `#` comments (yaml lang declares
 * `commentTokens`), history/undo, search, etc.
 *
 * Linting: takes optional errorLine/errorMessage from the parent (which calls
 * serde_yaml via `parse_compose_string`) and underlines that line.
 */
export default function YamlEditor({ value, onChange, placeholder, rows = 14, maxHeight = "60vh", errorLine, errorMessage, onReady, disableNativeSearch = false }: Props) {
  const extensions = useMemo(() => {
    const exts = [
      yaml(),
      lintGutter(),
      EditorView.lineWrapping,
      search({ top: true }),
    ];
    if (errorLine && errorMessage) {
      const line = errorLine;
      const msg = errorMessage;
      exts.push(
        linter((view) => {
          const diags: Diagnostic[] = [];
          const totalLines = view.state.doc.lines;
          const target = Math.min(Math.max(line, 1), totalLines);
          const lineObj = view.state.doc.line(target);
          diags.push({
            from: lineObj.from,
            to: lineObj.to,
            severity: "error",
            message: msg,
          });
          return diags;
        })
      );
    }
    return exts;
  }, [errorLine, errorMessage]);

  return (
    <div className="bg-surface-code border border-subtle rounded-lg overflow-hidden focus-within:border-accent transition-colors">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="dark"
        minHeight={`${rows * 20}px`}
        maxHeight={maxHeight}
        placeholder={placeholder}
        onCreateEditor={(view) => onReady?.(view)}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          tabSize: 2,
          autocompletion: false,
          // Cmd/Ctrl+F is driven by the parent's own search bar (opt-in via
          // disableNativeSearch); disable CodeMirror's built-in keymap so its
          // native panel doesn't also open.
          searchKeymap: !disableNativeSearch,
        }}
      />
    </div>
  );
}
