# LLM Wikify Skill

## Overview
The `llm-wikify` skill sets up an LLM-maintained wiki inside any repository, following Andrej Karpathy's [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. Instead of re-deriving knowledge from raw files on every question, the agent compiles the repo's sources once into a persistent, interlinked set of markdown pages and keeps them current.

## Features
- **Three Layers:** Raw sources (the repo, read in place, plus a `raw/` drop folder), the LLM-owned `wiki/`, and a schema file that defines the conventions and workflows.
- **Harness Neutral:** The schema lives in `AGENTS.md`, with one-line `CLAUDE.md` and `GEMINI.md` pointers, so any agent picks it up.
- **Ingest / Query / Lint Workflows:** Defined in the schema, so they keep working without this skill loaded.
- **Staleness Detection:** Pages cite repo sources by path and short SHA, so lint can flag claims whose source has since changed.
- **Index and Log:** A content catalog (`index.md`) and a grep-parseable, append-only timeline (`log.md`).
- **Local-Only Option:** Can keep the wiki out of a shared repo via `.git/info/exclude`, touching no tracked files.

## Usage
Activate this skill in a repository that doesn't have a wiki yet. It asks up to four questions (purpose, location, visibility, first ingest), scaffolds the wiki, queues sources in `.pending-ingest.yml`, and optionally ingests the first few. Afterwards, ask the agent to "ingest", "query", or "lint" the wiki.

## Installation
Claude Code skill (`.claude/skills/llm-wikify/`), mountable. Symlink it from a checkout so edits go live in every session:
```bash
ln -s "$PWD/.claude/skills/llm-wikify" ~/.claude/skills/llm-wikify
```
