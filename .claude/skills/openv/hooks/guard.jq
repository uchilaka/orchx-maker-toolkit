# Matches the hook input's command against deny.tsv (passed as $deny) and prints
# "<pattern>: <reason>" for the first row that matches, or an empty string.
#
# Words: each is a whole token, separated by any whitespace. The first may carry
# a path (/opt/homebrew/bin/pass-cli) and must follow the start of the line, a
# separator, a quote, $( or whitespace, so it also catches `sh -c '...'` and
# `x && pass-cli ...`. Flags (--no-masking) match anywhere.

def esc: gsub("(?<c>[.*+?^${}()|\\[\\]\\\\])"; "\\\(.c)");

def rx:
  if startswith("--") then "(^|[\\s'\"=])" + esc + "(?![A-Za-z0-9_-])"
  else (split(" ") | map(esc)) as $w
    | "(^|[^A-Za-z0-9_./-])([^\\s'\"();|&$`]*/)?" + ($w | join("\\s+")) + "(?![A-Za-z0-9_.-])"
  end;

(.tool_input.command // "") as $cmd
| [ $deny | split("\n")[]
    | select(length > 0 and (startswith("#") | not))
    | split("\t")
    | select(.[0] as $p | $cmd | test($p | rx)) ]
| if length > 0 then "\(.[0][0]): \(.[0][1])" else "" end
