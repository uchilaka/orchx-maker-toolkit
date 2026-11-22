#!/usr/bin/env bash
# Install or uninstall ~/.local/bin/openv as a symlink to openv's bin/openv.
#
#   install-link.sh install [--force]
#   install-link.sh uninstall
#
# install replaces an existing link only when it points at an openv script
# (another checkout, a pruned worktree). A link to anything else may be the
# user's own `openv`, so it's replaced only with --force.
#
# Links point at the MAIN checkout (via git --git-common-dir) so a link into a
# worktree doesn't dangle when the worktree is pruned. Set SKILL_SOURCE_ROOT to
# test an unmerged worktree copy on purpose; outside a git checkout (a plugin
# cache) it falls back to its own skill directory. Reused by `mise run
# install:openv` (S15) and `uninstall:claude-global openv` (S14).
set -euo pipefail

usage() {
  echo "usage: $(basename "$0") install [--force] | uninstall" >&2
  exit 2
}

# TODO(LAR-557): test the argument shapes (uninstall --force, --force install)
# and dangling or relative links.
force=
case "$#:${1:-}:${2:-}" in
  1:install: | 1:uninstall:) action="$1" ;;
  2:install:--force) action=install force=1 ;;
  *) usage ;;
esac

# Follows a symlink chain to a physical file path; empty if dangling.
resolve_file() {
  local p="$1" t
  while [ -L "$p" ]; do
    t="$(readlink "$p")"
    case "$t" in /*) p="$t" ;; *) p="$(dirname "$p")/$t" ;; esac
  done
  [ -e "$p" ] || return 0
  echo "$(cd "$(dirname "$p")" && pwd -P)/$(basename "$p")"
}

resolve_dir() { (cd "$1" 2>/dev/null && pwd -P) || true; }

here="$(cd "$(dirname "$0")" && pwd -P)"
if [ -n "${SKILL_SOURCE_ROOT:-}" ]; then
  src_bin="$SKILL_SOURCE_ROOT/.claude/skills/openv/bin/openv"
elif common_dir="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"; then
  case "$common_dir" in
    */.git) src_root="$(dirname "$common_dir")" ;;
    *) src_root="$common_dir" ;;
  esac
  src_bin="$src_root/.claude/skills/openv/bin/openv"
else
  src_bin="$here/openv"
fi

link_path="${OPENV_LINK_PATH:-$HOME/.local/bin/openv}"
link_dir="$(dirname "$link_path")"

warn_path() {
  case ":$PATH:" in
    *":$link_dir:"*) ;;
    *) echo "warning: $link_dir is not on PATH; add 'export PATH=\"$link_dir:\$PATH\"' to your shell rc" >&2 ;;
  esac
}

case "$action" in
  install)
    [ -x "$src_bin" ] || { echo "openv: source script missing or not executable: $src_bin" >&2; exit 1; }
    src_phys="$(resolve_file "$src_bin")"
    if [ -L "$link_path" ]; then
      cur_raw="$(readlink "$link_path")"
      cur_phys="$(resolve_file "$link_path")"
      if [ "$cur_phys" = "$src_phys" ]; then
        echo "openv: already linked -> $cur_raw"
        warn_path
        exit 0
      fi
      case "$cur_raw" in
        */.claude/skills/openv/bin/openv) ;;
        *)
          if [ -z "$force" ]; then
            echo "openv: $link_path already links to $cur_raw, which isn't openv; re-run with --force to replace it" >&2
            exit 1
          fi
          ;;
      esac
      mkdir -p "$link_dir"
      ln -sfn "$src_bin" "$link_path"
      echo "openv: installed -> $src_bin (was -> $cur_raw)"
      warn_path
      exit 0
    fi
    if [ -e "$link_path" ]; then
      echo "openv: refusing to replace non-symlink $link_path" >&2
      exit 1
    fi
    mkdir -p "$link_dir"
    ln -s "$src_bin" "$link_path"
    echo "openv: installed -> $src_bin"
    warn_path
    ;;
  uninstall)
    if [ ! -L "$link_path" ] && [ ! -e "$link_path" ]; then
      echo "openv: not installed ($link_path absent)"
      exit 0
    fi
    if [ ! -L "$link_path" ]; then
      echo "openv: leaving $link_path (not a symlink)" >&2
      exit 0
    fi
    src_skill_phys="$(resolve_dir "$(dirname "$src_bin")/..")"
    cur_raw="$(readlink "$link_path")"
    cur_phys="$(resolve_file "$link_path")"
    # Remove only if it resolves into this openv skill dir, or is a dangling
    # link that clearly targeted an openv bin/openv script.
    case "$cur_phys" in
      "$src_skill_phys"/*)
        rm "$link_path"
        echo "openv: removed $link_path"
        ;;
      '')
        case "$cur_raw" in
          */.claude/skills/openv/bin/openv)
            rm "$link_path"
            echo "openv: removed dangling $link_path (was -> $cur_raw)"
            ;;
          *)
            echo "openv: leaving dangling symlink $link_path -> $cur_raw (not openv)" >&2
            ;;
        esac
        ;;
      *)
        echo "openv: leaving $link_path -> $cur_raw (points outside $src_skill_phys)" >&2
        ;;
    esac
    ;;
esac
