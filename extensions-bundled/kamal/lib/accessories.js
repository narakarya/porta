// Returns the keys of the top-level `accessories:` mapping in a kamal deploy.yml.
// Minimal YAML-subset scan (no external parser): find the column-0
// `accessories:` line, then collect immediate child keys (the first deeper
// indentation level) until indentation returns to column 0.
export function parseAccessories(yamlText) {
  const lines = String(yamlText).split("\n");
  let i = 0;
  for (; i < lines.length; i++) {
    if (/^accessories:\s*$/.test(lines[i])) break;
  }
  if (i >= lines.length) return [];
  i++;
  const names = [];
  let childIndent = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*$/.test(line)) continue;            // skip blank
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;                      // back to top level → done
    if (childIndent === null) childIndent = indent;
    if (indent !== childIndent) continue;         // deeper (accessory props) → skip
    const m = line.trimStart().match(/^([A-Za-z0-9_-]+):/);
    if (m) names.push(m[1]);
  }
  return names;
}
