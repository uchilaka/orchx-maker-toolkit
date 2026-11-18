// Minimal YAML frontmatter reader: flat `key: value` lines only. Every SKILL.md
// and agent file in this repo keeps its frontmatter single-line, so a YAML
// dependency isn't worth adding. A folded (`>`) or nested value comes back as
// its raw first line.
// TODO(LAR-388): CRLF files and quoted values (`name: "x"`) parse wrong, and
// a folded value returns the bare `>`, not its first line as said above.
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

module.exports = { parseFrontmatter };
