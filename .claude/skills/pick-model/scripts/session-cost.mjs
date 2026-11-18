#!/usr/bin/env node
// Estimates what a whole agent session costs on each candidate model, assuming the
// model is kept for the session so the prompt cache stays warm. Prices come from
// OpenRouter's public model list (no key needed), or from --prices for offline use.
//
//   node session-cost.mjs --profile standard --effort medium anthropic/claude-opus-5.5 openai/gpt-6.2-sol
//   node session-cost.mjs --list --since-days 90
//
// Exit 0 on success, 2 on bad input or an unknown model id.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const USER_MODELS_URL = 'https://openrouter.ai/api/v1/models/user';
const USER_PAGE = 200;
const MAX_PAGES = 50;
const FETCH_TIMEOUT_MS = 30_000;

// Session shapes, calibrated against real OpenCode sessions on this machine: a fresh
// session starts around 40k tokens of system prompt, instructions and skill list, and
// each agent step adds a tool result plus a few hundred output tokens.
export const PROFILES = {
  quick: { steps: 15, startContext: 40_000, endContext: 70_000, outputPerStep: 300 },
  standard: { steps: 60, startContext: 40_000, endContext: 150_000, outputPerStep: 400 },
  marathon: { steps: 200, startContext: 40_000, endContext: 400_000, outputPerStep: 500 },
};

// Output (including reasoning) scales with effort. Rough multipliers relative to
// medium: they rank models fairly, but don't read the dollar figure as a quote.
export const EFFORT = { none: 0.4, minimal: 0.5, low: 0.6, medium: 1, high: 1.8, xhigh: 2.5, max: 3.5 };

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

// OpenRouter prices are USD per token, as strings. A tiered model carries
// `overrides` that apply once the prompt reaches `min_prompt_tokens`.
export function priceAt(pricing, contextTokens) {
  let tier = {
    input: num(pricing.prompt),
    output: num(pricing.completion),
    cacheRead: num(pricing.input_cache_read),
    cacheWrite: num(pricing.input_cache_write),
  };
  for (const o of pricing.overrides ?? []) {
    if (contextTokens >= (o.min_prompt_tokens ?? Infinity)) {
      tier = {
        input: num(o.prompt) ?? tier.input,
        output: num(o.completion) ?? tier.output,
        cacheRead: num(o.input_cache_read) ?? tier.cacheRead,
        cacheWrite: num(o.input_cache_write) ?? tier.cacheWrite,
      };
    }
  }
  return tier;
}

// Step 0 writes the starting context to the cache. Every step then reads the
// context so far from cache, writes the tokens it added, and pays for its output.
// Without cache pricing, every step pays full input price for the whole context.
export function estimate(model, shape, effort = 'medium') {
  const mult = EFFORT[effort];
  if (mult === undefined) throw new Error(`unknown effort "${effort}" (${Object.keys(EFFORT).join(', ')})`);
  const output = shape.outputPerStep * mult;
  const grow = (shape.endContext - shape.startContext) / shape.steps;
  const cached = num(model.pricing.input_cache_read) !== undefined;
  const first = priceAt(model.pricing, shape.startContext);
  let cost = cached ? shape.startContext * (first.cacheWrite ?? first.input) : 0;
  for (let i = 0; i < shape.steps; i++) {
    const context = shape.startContext + i * grow;
    const p = priceAt(model.pricing, context);
    cost += cached
      ? context * p.cacheRead + grow * (p.cacheWrite ?? p.input) + output * p.output
      : (context + grow) * p.input + output * p.output;
  }
  const overflow = model.context_length && shape.endContext > model.context_length;
  return { id: model.id, cost, cached, overflow: Boolean(overflow), contextLength: model.context_length };
}

// Candidates worth showing for a coding session: tool calling, real prices
// (routers report -1), and released recently enough to be current. `:batch`
// endpoints are dropped: they answer asynchronously, so a session can't use them.
export function listCurrent(models, sinceDays, now = Date.now()) {
  const cutoff = now / 1000 - sinceDays * 86_400;
  return models
    .filter((m) => !m.id.endsWith(':batch'))
    .filter((m) => (m.supported_parameters ?? []).includes('tools'))
    .filter((m) => Number(m.pricing?.prompt) > 0 && m.created >= cutoff)
    .sort((a, b) => b.created - a.created);
}

export function parseArgs(argv) {
  const opts = { ids: [], profile: 'standard', effort: 'medium', sinceDays: 120 };
  const value = (i, flag) => {
    if (argv[i + 1] === undefined) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--prices') opts.prices = value(i++, a);
    else if (a === '--profile') opts.profile = value(i++, a);
    else if (a === '--effort') opts.effort = value(i++, a);
    else if (a === '--since-days') opts.sinceDays = Number(value(i++, a));
    else if (a === '--steps') opts.steps = Number(value(i++, a));
    else if (a === '--start-context') opts.startContext = Number(value(i++, a));
    else if (a === '--end-context') opts.endContext = Number(value(i++, a));
    else if (a === '--output-per-step') opts.outputPerStep = Number(value(i++, a));
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else opts.ids.push(a.replace(/^openrouter\/(?!auto)/, ''));
  }
  const base = PROFILES[opts.profile];
  if (!base) throw new Error(`unknown profile "${opts.profile}" (${Object.keys(PROFILES).join(', ')})`);
  opts.shape = { ...base };
  for (const k of ['steps', 'startContext', 'endContext', 'outputPerStep']) {
    if (opts[k] !== undefined) {
      if (!(opts[k] > 0)) throw new Error(`--${k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} must be a positive number`);
      opts.shape[k] = opts[k];
      opts.label = 'custom';
    }
  }
  opts.label ??= opts.profile;
  return opts;
}

// With an API key, ask OpenRouter for the models that key may actually use: it
// applies the key's guardrails, privacy settings and provider preferences, so a
// model blocked by guardrail never reaches the shortlist. Guardrails are assigned
// per key, so this must be the key the harness sends. Without a key, the public
// list is all there is, and the caller is warned it may include blocked models.
export async function loadModels({ pricesFile, apiKey, fetchImpl = fetch, warn = console.error } = {}) {
  if (pricesFile) {
    const body = JSON.parse(readFileSync(pricesFile, 'utf8'));
    return { models: body.data ?? body, filtered: Boolean(body.filtered) };
  }
  if (!apiKey) {
    warn('session-cost: OPENROUTER_API_KEY is not set, so guardrails are NOT applied; some listed models may be blocked');
    const res = await fetchImpl(MODELS_URL);
    if (!res.ok) throw new Error(`${MODELS_URL} returned HTTP ${res.status}`);
    return { models: (await res.json()).data, filtered: false };
  }
  // Page until a page adds no new ids, rather than until a short page: a server
  // that caps `limit` below USER_PAGE would otherwise end the list early, and one
  // that ignores `offset` would repeat the same full page forever. MAX_PAGES is a
  // backstop against anything else that keeps paging alive.
  const byId = new Map();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(`${USER_MODELS_URL}?limit=${USER_PAGE}&offset=${byId.size}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // Never echo the key: the status alone says whether it was rejected.
    if (!res.ok) throw new Error(`${USER_MODELS_URL} returned HTTP ${res.status}${res.status === 401 ? ' (key rejected)' : ''}`);
    const data = (await res.json()).data;
    const before = byId.size;
    for (const m of Array.isArray(data) ? data : []) if (!byId.has(m.id)) byId.set(m.id, m);
    if (byId.size === before) return { models: [...byId.values()], filtered: true };
  }
  throw new Error(`${USER_MODELS_URL} still returned new models after ${MAX_PAGES} pages`);
}

const usd = (n) => `$${n.toFixed(2)}`;
const date = (s) => new Date(s * 1000).toISOString().slice(0, 10);
const perM = (s) => (s === undefined ? '-' : (Number(s) * 1e6).toFixed(2));

async function main(argv) {
  const opts = parseArgs(argv);
  const { models, filtered } = await loadModels({ pricesFile: opts.prices, apiKey: process.env.OPENROUTER_API_KEY });
  const byId = new Map(models.map((m) => [m.id, m]));
  const scope = filtered ? 'allowed by your guardrails' : 'UNFILTERED: guardrails not applied';

  if (opts.list) {
    const rows = listCurrent(models, opts.sinceDays);
    if (opts.json) return console.log(JSON.stringify({ filtered, models: rows.map((m) => ({ id: m.id, released: date(m.created), pricing: m.pricing })) }, null, 2));
    console.log(`models ${scope}`);
    console.log('released    in/M   out/M  cache-read/M  id');
    for (const m of rows) {
      console.log(`${date(m.created)}  ${perM(m.pricing.prompt).padStart(5)}  ${perM(m.pricing.completion).padStart(6)}  ${perM(m.pricing.input_cache_read).padStart(12)}  ${m.id}`);
    }
    return;
  }

  if (opts.ids.length === 0) throw new Error('name at least one model id, or pass --list');
  const missing = opts.ids.filter((id) => !byId.has(id));
  if (missing.length) {
    const why = filtered ? 'not allowed for this key (guardrails, privacy settings or provider preferences) or not a real id' : 'not in the price list';
    throw new Error(`${why}: ${missing.join(', ')}`);
  }
  const routers = opts.ids.filter((id) => Number(byId.get(id).pricing.prompt) < 0);
  if (routers.length) throw new Error(`${routers.join(', ')} is a router with no fixed price; estimate the models it routes to instead`);

  const rows = opts.ids.map((id) => estimate(byId.get(id), opts.shape, opts.effort)).sort((a, b) => a.cost - b.cost);
  if (opts.json) return console.log(JSON.stringify({ filtered, shape: opts.shape, effort: opts.effort, rows }, null, 2));
  const s = opts.shape;
  if (!filtered) console.log(`prices ${scope}`);
  console.log(`${opts.label}: ${s.steps} steps, ${s.startContext / 1000}k -> ${s.endContext / 1000}k context, ${s.outputPerStep} output/step, effort ${opts.effort}`);
  for (const r of rows) {
    const notes = [!r.cached && 'no cache pricing', r.overflow && `exceeds ${r.contextLength / 1000}k context`].filter(Boolean);
    console.log(`${usd(r.cost).padStart(8)}  ${r.id}${notes.length ? `  (${notes.join('; ')})` : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`session-cost: ${err.message}`);
    process.exit(2);
  });
}
