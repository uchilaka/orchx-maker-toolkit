#!/usr/bin/env bash
# Install or uninstall this repo's Claude-native skills (.claude/skills/<name>) into the
# user-scope catalog at ~/.claude/skills/, as symlinks — so the repo stays the one source
# file per skill and edits here take effect everywhere.
#
#   claude-global-skill.sh install   [--with-hooks|--no-hooks] [name...]   # default: every repo-local skill
#   claude-global-skill.sh uninstall [name...]
#
# A skill can ship optional hooks in install/hooks.json (see claude_skill_hooks.cjs).
# install asks before adding them to ~/.claude/settings.json; --with-hooks or --no-hooks
# answers up front. With no terminal to ask and no flag, they're not added. uninstall
# removes exactly the hooks install would add, nothing else.
#
# A skill's agents/*.md are linked into ~/.claude/agents/ as part of the skill link (not
# behind --with-hooks), by the same rules. A statusLine in install/hooks.json is offered
# like the hooks, and only set when the user has none (see claude_skill_hooks.cjs).
#
# Links point at the MAIN checkout, never a worktree: a link into a worktree dangles as
# soon as that worktree is pruned. So a skill must be merged to main before it installs.
# SKILL_SOURCE_ROOT overrides the checkout — used by the selftest, and for trying an
# unmerged skill from a worktree on purpose.
#
# Nothing is ever deleted outright:
#   - install over a real directory with identical content moves it to
#     ~/.claude/skill-backups/<name>-<timestamp> first; different content is refused.
#   - uninstall only removes a symlink that resolves into the source checkout.
#   - an agent file is treated like a skill directory: a different real file is refused.
set -euo pipefail

usage() { echo "usage: $(basename "$0") install [--with-hooks|--no-hooks] [skill-name...] | uninstall [skill-name...]" >&2; exit 2; }

[ $# -ge 1 ] || usage
action="$1"; shift
case "$action" in install|uninstall) ;; *) usage ;; esac

hooks_mode=ask
names=()
for arg in "$@"; do
  case "$arg" in
    --with-hooks|--no-hooks)
      [ "$action" = install ] || usage
      want="${arg#--}"; want="${want%%-hooks}"   # with | no
      [ "$hooks_mode" = ask ] || [ "$hooks_mode" = "$want" ] || usage
      hooks_mode="$want" ;;
    -*) usage ;;
    *) names+=("$arg") ;;
  esac
done

if [ -n "${SKILL_SOURCE_ROOT:-}" ]; then
  src_root="$SKILL_SOURCE_ROOT"
else
  common_dir="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
  src_root="$(dirname "$common_dir")"
fi
src_skills="$src_root/.claude/skills"
dest_skills="$HOME/.claude/skills"
dest_agents="$HOME/.claude/agents"
backups="$HOME/.claude/skill-backups"

# Physical path of an existing directory (or symlink to one); empty if it doesn't resolve.
resolve() { (cd "$1" 2>/dev/null && pwd -P) || true; }

if [ ${#names[@]} -eq 0 ]; then
  # Real directories only: symlinks here are mount:claude mounts of Gemini skills.
  for d in "$src_skills"/*/; do
    d="${d%/}"
    [ -L "$d" ] || names+=("$(basename "$d")")
  done
fi

status=0
fail() { echo "$1" >&2; status=1; }

hooks_helper="$(cd "$(dirname "$0")" && pwd)/claude_skill_hooks.cjs"

# $1 name, $2 source dir, $3 installed dir. Hook commands name the installed dir,
# so they keep working when the checkout moves.
install_hooks() {
  local name="$1" frag="$2/install/hooks.json" dest="$3" add=no reply=
  [ -f "$frag" ] || return 0
  if node "$hooks_helper" has "$frag" "$dest" >/dev/null 2>&1; then
    echo "$name: optional hooks already in ~/.claude/settings.json"; return 0
  fi
  case "$hooks_mode" in
    with) add=yes ;;
    no) echo "$name: optional hooks skipped (--no-hooks)"; return 0 ;;
    ask)
      if [ -t 0 ] && [ -t 1 ]; then
        echo "$name: optional hooks: $(node "$hooks_helper" describe "$frag")"
        read -r -p "  Add them to ~/.claude/settings.json? [y/N] " reply || reply=
        case "$reply" in [yY]|[yY][eE][sS]) add=yes ;; esac
      fi ;;
  esac
  if [ "$add" = yes ]; then
    echo "$name: adding optional hooks"
    node "$hooks_helper" add "$frag" "$dest" || fail "$name: its hooks were not added"
  else
    echo "$name: optional hooks not added (to add them: mise run install:claude-global -- --with-hooks $name)"
  fi
}

remove_hooks() {
  local name="$1" frag="$2/install/hooks.json" dest="$3"
  [ -f "$frag" ] || return 0
  node "$hooks_helper" remove "$frag" "$dest" || fail "$name: its hooks were not removed"
}

# Physical path of an existing file, following symlinks; empty if it doesn't resolve.
resolve_file() { node -e 'try{console.log(require("fs").realpathSync(process.argv[1]))}catch{}' "$1"; }

# link_item <src> <dest> <label> <skill|agent>: symlink dest -> src, and set item_ok to
# yes, or to no when it refuses (the reason is already reported). It sets a variable rather
# than returning 1 so it is never called in a tested context, where bash suspends set -e.
# label prefixes every message ("alpha:" for a skill, "alpha: agent x.md" for an agent).
# A skill directory and an agent file share these rules except where noted; the
# differences predate this helper and are kept on purpose:
#   - an existing link is compared by its literal target, never the resolved one (a link
#     that reaches this checkout through an alias dangles once the alias is removed, so it
#     is re-pointed). A skill link is always re-pointed; an agent link that resolves to
#     some other live file is somebody else's agent and is refused.
#   - a real dest with identical content moves to the backups dir first: <name>-<ts> for
#     a skill, agent-<name>-<ts>.md for an agent. Different content is refused.
link_item() {
  local src="$1" dest="$2" label="$3" kind="$4" old backup ts
  item_ok=no
  mkdir -p "$(dirname "$dest")"
  if [ -L "$dest" ]; then
    old="$(readlink "$dest")"
    if [ "$old" = "$src" ]; then
      if [ "$kind" = skill ]; then echo "$label already installed -> $old"; else echo "$label already installed"; fi
    elif [ "$kind" = agent ] && [ -e "$dest" ] && [ "$(resolve_file "$dest")" != "$(resolve_file "$src")" ]; then
      fail "$label $dest points at $old, not this checkout — left alone"; return 0
    else
      ln -sfn "$src" "$dest"
      echo "$label installed -> $src (was -> $old)"
    fi
  elif [ -e "$dest" ]; then
    if [ "$kind" = skill ]; then
      if ! diff -rq "$dest" "$src" >/dev/null 2>&1; then
        fail "$label $dest is a real directory and differs from $src — reconcile by hand (diff -r \"$dest\" \"$src\")"
        return 0
      fi
    elif ! cmp -s "$dest" "$src"; then
      fail "$label $dest is a real file and differs from $src — reconcile by hand (diff \"$dest\" \"$src\")"
      return 0
    fi
    mkdir -p "$backups"
    ts="$(date +%Y%m%dT%H%M%S)"
    if [ "$kind" = skill ]; then backup="$backups/$(basename "$dest")-$ts"
    else old="$(basename "$dest")"; backup="$backups/agent-${old%.md}-$ts.md"; fi
    mv "$dest" "$backup"
    ln -s "$src" "$dest"
    echo "$label installed -> $src (identical copy moved to $backup)"
  else
    ln -s "$src" "$dest"
    echo "$label installed -> $src"
  fi
  item_ok=yes
}

# same_target <a> <b> <skill|agent>: both resolve, to the same physical path.
same_target() {
  local here
  if [ "$3" = skill ]; then
    here="$(resolve "$1")"; [ -n "$here" ] && [ "$here" = "$(resolve "$2")" ]
  else
    here="$(resolve_file "$1")"; [ -n "$here" ] && [ "$here" = "$(resolve_file "$2")" ]
  fi
}

# unlink_item <src> <dest> <label> <skill|agent>: removes dest only when it is a symlink
# into this checkout (literal target, or the same resolved path). Sets item_ok to yes when
# dest is gone afterwards (removed, or a skill that was not installed), else no. A real
# skill directory is refused; an agent that is not a symlink is skipped silently.
unlink_item() {
  local src="$1" dest="$2" label="$3" kind="$4" target
  item_ok=no
  if [ -L "$dest" ]; then
    target="$(readlink "$dest")"
    if [ "$target" = "$src" ] || same_target "$dest" "$src" "$kind"; then
      rm "$dest"
      echo "$label uninstalled"
      item_ok=yes
    else
      fail "$label $dest points at $target, not this checkout — left alone"
    fi
  elif [ "$kind" = agent ]; then
    :
  elif [ -e "$dest" ]; then
    fail "$label $dest is a real directory, not an install from this repo — left alone"
  else
    echo "$label not installed"
    item_ok=yes
  fi
}

# $1 name, $2 source skill dir. Links (or unlinks) each agents/*.md in ~/.claude/agents/.
install_agents() {
  local name="$1" f base
  [ -d "$2/agents" ] || return 0
  for f in "$2/agents"/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    link_item "$f" "$dest_agents/$base" "$name: agent $base" agent
  done
}

remove_agents() {
  local name="$1" f base
  [ -d "$2/agents" ] || return 0
  for f in "$2/agents"/*.md; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    unlink_item "$f" "$dest_agents/$base" "$name: agent $base" agent
  done
}

for name in "${names[@]}"; do
  case "$name" in */*|.*|'') fail "$name: invalid skill name"; continue ;; esac
  src="$src_skills/$name"
  dest="$dest_skills/$name"

  if [ "$action" = install ]; then
    if [ -L "$src" ]; then fail "$name: $src is a mount:claude symlink, not a repo-local skill"; continue; fi
    if [ ! -f "$src/SKILL.md" ]; then fail "$name: no skill at $src (merged to main yet?)"; continue; fi
    link_item "$src" "$dest" "$name:" skill
    [ "$item_ok" = yes ] || continue
    install_agents "$name" "$src"
    install_hooks "$name" "$src" "$dest"

  else
    remove_agents "$name" "$src"
    # Hooks go with the link, and also when nothing is installed: a hook left behind would
    # run a script that isn't there.
    unlink_item "$src" "$dest" "$name:" skill
    if [ "$item_ok" = yes ]; then remove_hooks "$name" "$src" "$dest"; fi
  fi
done

exit $status
