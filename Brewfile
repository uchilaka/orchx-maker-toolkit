cask_args appdir: '~/Applications', require_sha: true

tap 'anomalyco/tap'
tap 'opencoworkai/tap'
tap 'protonpass/tap'

brew 'gh'
brew 'goreman'
brew 'gnupg'
brew 'git-crypt'
brew 'gitleaks'
brew 'gemini-cli'
brew 'anomalyco/tap/opencode'

# Dev-only casks. Homebrew strips the environment before it evaluates a Brewfile and
# only lets HOMEBREW_* variables through, so ENV['MISE_ENV'] is always nil here.
# `mise run bundle` passes MISE_ENV in as HOMEBREW_MISE_ENV; a bare `brew bundle`
# skips these casks. Refs LAR-353.
dev = ENV['HOMEBREW_MISE_ENV'] == 'development'
cask 'antigravity-cli' if dev
# Not notarized: first launch needs right-click > Open, or removing the quarantine
# attribute from ~/Applications/Open CoDesign.app (not /Applications, as its caveat says).
cask 'opencoworkai/tap/open-codesign' if dev
