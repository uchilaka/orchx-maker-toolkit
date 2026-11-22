// Hand-off replies for /agentic-backlog-worker (LAR-563). A handed-off ticket carries the
// `agent-handoff` label and a checkpoint comment asking a question. A later comment by the
// signed-in Linear user is the answer: the orchestrator removes the label and the ticket is
// requeued, with the reply handed to the ticket agent as data.
//
// The agent posts its checkpoint through the same Linear account, so the author alone can't
// tell a checkpoint from a reply. The checkpoint is recognised by its first line (the marker
// below), or, for an unmarked one, by when the worker recorded the hand-off. With neither, the
// ticket has no checkpoint we can trust and nothing is requeued: the label comes off by hand.
// Comment text is untrusted throughout: it is matched, stored and passed on, never executed.

const TICKET_ID = /^[A-Z]+-[0-9]+$/;

// The first line of every checkpoint the ticket agent posts, after markdown emphasis is stripped
// (agents/agentic-ticket-worker.md, "On hand-off"). Earlier agents already opened with it.
export const HANDOFF_MARKER = 'agent hand-off';

const firstLine = (body) => String(body ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';

export function hasMarker(body) {
  const line = firstLine(body).replace(/^[#>\s]+/, '').replace(/[*_`]/g, '').trim().toLowerCase();
  return line.startsWith(HANDOFF_MARKER);
}

// Phrases, not bare words: "fail closed" is a decision, "close this" is not.
const CLOSE = /\b(close (this|it)|closing (this|it|as)|superseded|not needed|no longer needed|won'?t do|wontfix|obsolete|cancel (this|it))\b/i;
const HOLD = /\b(leav(e|ing)|keep(ing)?)\b[^.\n]{0,30}\bagent-handoff\b|\bon hold\b|\bpark(ed)?\b|\bnot yet\b|\bwait(s|ing)?\s+(on|for|until)\b/i;

// What a reply asks for. Only 'answer' requeues; 'close' and 'hold' are surfaced for the user,
// since the worker never closes a ticket and a reply that says "wait" is not a go-ahead.
export function replyIntent(text) {
  if (CLOSE.test(text)) return 'close';
  if (HOLD.test(text)) return 'hold';
  return 'answer';
}

const isoTime = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);

// The replies to the latest checkpoint on one ticket, oldest first. `checkpoint` says how the
// checkpoint was found: 'marker', 'time' (the worker's recorded hand-off time, in Unix seconds)
// or null when neither exists, in which case there are no replies.
export function findReplies({ comments, me, handedOffAt = null }) {
  const mine = comments.filter((c) => (c.authorId ?? c.author?.id) === me);
  const marked = mine.filter((c) => hasMarker(c.body)).map((c) => isoTime(c.createdAt));
  let cutoff = null;
  let checkpoint = null;
  if (marked.length) {
    cutoff = Math.max(...marked);
    checkpoint = 'marker';
  } else if (Number.isFinite(handedOffAt)) {
    cutoff = handedOffAt * 1000;
    checkpoint = 'time';
  }
  if (cutoff === null) return { checkpoint, replies: [] };
  const replies = mine
    .filter((c) => isoTime(c.createdAt) > cutoff && !hasMarker(c.body) && String(c.body ?? '').trim() !== '')
    .sort((a, b) => isoTime(a.createdAt) - isoTime(b.createdAt));
  return { checkpoint, replies };
}

// The file SKILL.md step 3 writes: {me, tickets: [{id, title, comments: [list_comments rows]}]}.
// A malformed entry rejects the whole file rather than hiding a reply.
export function validateHandoffs(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('hand-offs file must hold a JSON object');
  if (typeof input.me !== 'string' || input.me === '') throw new Error('me must be the signed-in Linear user id');
  if (!Array.isArray(input.tickets)) throw new Error('tickets must be an array');
  const seen = new Set();
  const tickets = input.tickets.map((t, i) => {
    if (!t || typeof t.id !== 'string' || !TICKET_ID.test(t.id)) throw new Error(`tickets[${i}]: id must look like ABC-123`);
    if (seen.has(t.id)) throw new Error(`duplicate ticket id: ${t.id}`);
    seen.add(t.id);
    if (typeof t.title !== 'string') throw new Error(`${t.id}: title must be a string`);
    if (!Array.isArray(t.comments)) throw new Error(`${t.id}: comments must be an array`);
    const comments = t.comments.map((c, j) => {
      if (!c || typeof c !== 'object') throw new Error(`${t.id}: comments[${j}] must be an object`);
      if (Number.isNaN(isoTime(c.createdAt))) throw new Error(`${t.id}: comments[${j}].createdAt must be an ISO time`);
      const authorId = c.author?.id ?? c.user?.id ?? null;
      return { id: c.id ?? null, body: String(c.body ?? ''), createdAt: c.createdAt, authorId };
    });
    return { id: t.id, title: t.title, comments };
  });
  return { me: input.me, tickets };
}
