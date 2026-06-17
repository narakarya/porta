import { useMemo } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { yaml } from "@codemirror/lang-yaml";
import { json } from "@codemirror/lang-json";
import { StreamLanguage } from "@codemirror/language";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export type CodeLanguage = "yaml" | "toml" | "json" | "text";

interface Props {
  value: string;
  onChange: (v: string) => void;
  language: CodeLanguage;
  placeholder?: string;
  /** Minimum rows of content (editor won't shrink below this). Default 14. */
  rows?: number;
  /** Max height as CSS value. Default "60vh" — editor auto-grows with content. */
  maxHeight?: string;
}

function languageExtension(language: CodeLanguage): Extension[] {
  switch (language) {
    case "yaml":
      return [yaml()];
    case "json":
      return [json()];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "text":
    default:
      return [];
  }
}

/**
 * Generic CodeMirror 6 editor with per-language syntax highlighting. Used by the
 * file editor for everything that isn't an `.env` file (which has its own
 * rows/secret-masking editor) — TOML (mise), JSON (package.json), plain text
 * (.tool-versions, .nvmrc), etc.
 *
 * Compose YAML keeps using the dedicated `YamlEditor` (it adds serde_yaml lint
 * underlines fed from the Rust parser).
 */
export default function CodeEditor({ value, onChange, language, placeholder, rows = 14, maxHeight = "60vh" }: Props) {
  const extensions = useMemo(
    () => [...languageExtension(language), EditorView.lineWrapping],
    [language],
  );

  return (
    <div className="bg-[#0d0d0f] border border-white/[0.08] rounded-lg overflow-hidden focus-within:border-blue-500/60 transition-colors">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="dark"
        minHeight={`${rows * 20}px`}
        maxHeight={maxHeight}
        placeholder={placeholder}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          tabSize: 2,
          autocompletion: false,
        }}
      />
    </div>
  );
}
