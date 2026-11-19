// Ticket ids, titles, reasons, PRs and branches come from Linear or an agent: untrusted. One
// line, no HTML, no code spans, and nothing that can split a table cell or open a link. Shared
// by the debrief (worker.mjs) and the SessionStart hook (backlog-worker-status.mjs). `$`, `(`
// and `)` become their full-width forms so no `$(…)` survives for a shell to expand if the text
// is ever pasted or sourced (live review SEC1).
export const clean = (s) => String(s ?? '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/\$/g, '\uFF04')
  .replace(/\(/g, '\uFF08')
  .replace(/\)/g, '\uFF09')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/`/g, "'")
  .replace(/([|[\]])/g, '\\$1')
  .trim();
