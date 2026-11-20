# Matches the hook input's command against deny.tsv (passed as $deny) and prints
# "<pattern>: <reason>" for the first row that matches, or an empty string. The
# matching rule is written down in deny.tsv's header; this implements it.
# Anything it can't trust (a malformed deny.tsv, a command that isn't a string)
# is a jq error, which the guard turns into a block.

def esc: gsub("(?<c>[.*+?^${}()|\\[\\]\\\\])"; "\\\(.c)");

def rx:
  if startswith("--") then "(^|[\\s=])" + esc + "(?![A-Za-z0-9_-])"
  else (split(" ") | map(esc)) as $w
    | "(^|[^A-Za-z0-9_./-])([^\\s();|&$`]*/)?" + ($w | join("[\\s)]+")) + "(?![A-Za-z0-9_.-])"
  end;

($deny | gsub("\r"; "") | split("\n") | map(select(test("^\\s*(#|$)") | not))) as $rows
| if ($rows | length) == 0 then error("deny.tsv has no rows")
  elif ($rows | all(test("^\\S+( \\S+)*\\t\\S"))) | not then
    error("deny.tsv has a row that isn't <pattern><TAB><reason>")
  else . end
| (.tool_input.command // "")
| if type != "string" then error("tool_input.command isn't a string") else . end
| gsub("\\\\\n"; " ") | gsub("[\"']"; "")
| . as $cmd
| test("openv|pass-cli|pass://") as $named
| (first($rows[] | split("\t")
    | select((.[0] | startswith("--") | not) or $named)
    | select(.[0] as $p | $cmd | test($p | rx)))
   | "\(.[0]): \(.[1])") // ""
