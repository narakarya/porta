import type { ChangedFile } from "../../../lib/commands";

/**
 * Folder-nested view of a flat `ChangedFile[]` list (mockup-19's signature
 * tree, vs. the flat `dir/base` row `FileRow` used before G7). A `dir` node's
 * `path` is the accumulated folder path (no trailing slash) — stable across
 * refreshes, so it doubles as the collapse-state key in `FileTree`.
 */
export type TreeNode =
  | { kind: "dir"; name: string; path: string; children: TreeNode[] }
  | { kind: "file"; name: string; path: string; file: ChangedFile };

/**
 * Build a nested dir/file tree from changed-file paths (split on `/`).
 * Sort order at every level: directories before files, then alphabetical —
 * matches the mockup and most file-tree UIs (VS Code, GitHub).
 */
export function buildFileTree(files: ChangedFile[]): TreeNode[] {
  // Intermediate mutable dir representation so we can look children up by
  // name while walking each path's segments, then freeze+sort at the end.
  type DirBuild = { kind: "dir"; name: string; path: string; children: (DirBuild | FileLeaf)[]; dirs: Map<string, DirBuild> };
  type FileLeaf = { kind: "file"; name: string; path: string; file: ChangedFile };

  const root: DirBuild = { kind: "dir", name: "", path: "", children: [], dirs: new Map() };

  for (const file of files) {
    const segments = file.path.split("/").filter((s) => s.length > 0);
    let cursor = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      let next = cursor.dirs.get(seg);
      if (!next) {
        const path = cursor.path ? `${cursor.path}/${seg}` : seg;
        next = { kind: "dir", name: seg, path, children: [], dirs: new Map() };
        cursor.dirs.set(seg, next);
        cursor.children.push(next);
      }
      cursor = next;
    }
    const base = segments[segments.length - 1] ?? file.path;
    cursor.children.push({ kind: "file", name: base, path: file.path, file });
  }

  function sortAndFreeze(dir: DirBuild): TreeNode[] {
    const sorted = [...dir.children].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return sorted.map((node): TreeNode =>
      node.kind === "dir"
        ? { kind: "dir", name: node.name, path: node.path, children: sortAndFreeze(node) }
        : node,
    );
  }

  return sortAndFreeze(root);
}
