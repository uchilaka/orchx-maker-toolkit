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
# Links point at the MAIN checkout, never a worktree: a link into a worktree dangles as
# soon as that worktree is pruned. So a skill must be merged to main before it installs.
# SKILL_SOURCE_ROOT overrides the checkout — used by the selftest, and for trying an
# unmerged skill from a worktree on purpose.
#
# Nothing is ever deleted outright:
#   - install over a real directory with identical content moves it to
#     ~/.claude/skill-backups/<name>-<timestamp> first; different content is refused.
#   - uninstall only removes a symlink that resolves into the source checkout.
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

for name in "${names[@]}"; do
  case "$name" in */*|.*|'') fail "$name: invalid skill name"; continue ;; esac
  src="$src_skills/$name"
  dest="$dest_skills/$name"

  if [ "$action" = install ]; then
    if [ -L "$src" ]; then fail "$name: $src is a mount:claude symlink, not a repo-local skill"; continue; fi
    if [ ! -f "$src/SKILL.md" ]; then fail "$name: no skill at $src (merged to main yet?)"; continue; fi
    mkdir -p "$dest_skills"

    if [ -L "$dest" ]; then
      if [ "$(resolve "$dest")" = "$(resolve "$src")" ]; then
        echo "$name: already installed -> $(readlink "$dest")"
      else
        old="$(readlink "$dest")"
        ln -sfn "$src" "$dest"
        echo "$name: installed -> $src (was -> $old)"
      fi
    elif [ -e "$dest" ]; then
      if ! diff -rq "$dest" "$src" >/dev/null 2>&1; then
        fail "$name: $dest is a real directory and differs from $src — reconcile by hand (diff -r \"$dest\" \"$src\")"
        continue
      fi
      mkdir -p "$backups"
      backup="$backups/$name-$(date +%Y%m%dT%H%M%S)"
      mv "$dest" "$backup"
      ln -s "$src" "$dest"
      echo "$name: installed -> $src (identical copy moved to $backup)"
    else
      ln -s "$src" "$dest"
      echo "$name: installed -> $src"
    fi
    install_hooks "$name" "$src" "$dest"

  else
    if [ -L "$dest" ]; then
      target="$(readlink "$dest")"
      if [ "$target" = "$src" ] || { [ -n "$(resolve "$dest")" ] && [ "$(resolve "$dest")" = "$(resolve "$src")" ]; }; then
        rm "$dest"
        echo "$name: uninstalled"
        remove_hooks "$name" "$src" "$dest"
      else
        fail "$name: $dest points at $target, not this checkout — left alone"
      fi
    elif [ -e "$dest" ]; then
      fail "$name: $dest is a real directory, not an install from this repo — left alone"
    else
      echo "$name: not installed"
      # A hook left behind would run a script that isn't there.
      remove_hooks "$name" "$src" "$dest"
    fi
  fi
done

exit $status
