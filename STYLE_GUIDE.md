# 🎨 OrchX Maker Toolkit Style Guide

This document defines the standards for visual, documentation, and code style within this repository. Adherence to these rules ensures consistency and professional quality.

## 😃 Emojis

To maintain a consistent and inclusive visual identity, all emojis that **officially support skin tones** (typically people, body parts, and professions) MUST use the **medium-dark skin tone** (🏾).

- **Correct:** 👍🏾, 👩🏾‍💻, 👨🏾‍💻, 🤲🏾
- **Do Not Modify:** 🏗, 🚀, 🎯, 🎨, 🧪 (Objects, places, and symbols do not support skin tones)

### How to Check
If applying the modifier (🏾) results in a separate block of color rather than a single unified emoji, the emoji does not support skin tones and should remain in its standard form.

## 📝 Markdown Standards

- **Formatting:** Use GitHub-flavored Markdown (GFM).
- **Headers:** Use `#` for the main title, `##` for sections, and `###` for sub-sections.
- **Lists:** Use `-` for unordered lists and `1.` for ordered lists.
- **Code Blocks:** Always specify the language for syntax highlighting (e.g., \`\`\`bash, \`\`\`javascript).
- **Line Length:** Aim for a maximum of 120 characters per line for better readability in text editors.

## 🛠 Automation

Markdown styling is automatically enforced via:
1. **Markdownlint:** See `.markdownlint.json` for rules.
2. **VS Code:** Workspace settings in `.vscode/settings.json` apply formatting on save and paste.

---
**Note:** The `/specialist` agent enforces these rules during design and documentation reviews.
