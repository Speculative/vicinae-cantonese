// Dictionary loading and ranking. Kept free of @vicinae/api so it can be tested with plain node.
import { readFileSync } from "node:fs";

export const FLAG_CANTO = 1;
export const FLAG_CEDICT = 2;
export const FLAG_DERIVED = 4;

type RawEntry = [string, string, string, string, number, number, string?];

export type Entry = {
  id: string;
  trad: string;
  simp: string;
  jyutping: string;
  /** Display only; not searched. */
  pinyin: string;
  defs: string[];
  freq: number;
  flags: number;
  // Search keys, built once at load.
  syllables: { base: string; tone: string }[];
  basesJoined: string;
  defsLower: string[];
  blob: string;
  prior: number;
};

export type Usage = {
  entries: Record<string, { n: number; t: number }>;
  queries: Record<string, Record<string, number>>;
};

export type Dictionary = {
  entries: Entry[];
  byId: Map<string, Entry>;
  syllableBases: Set<string>;
  syllablePrefixes: Set<string>;
};

export type Result = { entry: Entry; score: number; match: "jyutping" | "english" | "chinese" };

// Matches stronger than this are ordered by tier first, then by score within the tier.
const TIER_WEIGHT = 10;

export function entryId(trad: string, jyutping: string) {
  return `${trad}|${jyutping}`;
}

function staticPrior(trad: string, defs: string[], freq: number, flags: number) {
  let p = freq;
  if (flags & FLAG_CANTO) p += 2;
  if (flags & FLAG_DERIVED) p -= 1.5;
  const first = defs[0]?.toLowerCase() ?? "";
  if (/^(old |archaic |japanese |)variant of|^surname |^see [^a-z]/.test(first)) p -= 2;
  p -= 0.25 * Math.max(0, [...trad].length - 2);
  return p;
}

export function loadDictionary(path: string): Dictionary {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { entries: RawEntry[] };
  const entries: Entry[] = [];
  const byId = new Map<string, Entry>();
  const syllableBases = new Set<string>();

  for (const [trad, simp, jyutping, defsJoined, freq, flags, pinyin = ""] of raw.entries) {
    const syllables = jyutping.split(" ").map((s) => {
      const m = /^([a-z]+)([1-6]?)$/.exec(s);
      return m ? { base: m[1], tone: m[2] } : { base: s, tone: "" };
    });
    for (const s of syllables) syllableBases.add(s.base);
    const defs = defsJoined.split("\n");
    const defsLower = defs.map((d) => d.toLowerCase());
    const e: Entry = {
      id: entryId(trad, jyutping),
      trad,
      simp,
      jyutping,
      pinyin,
      defs,
      freq,
      flags,
      syllables,
      basesJoined: syllables.map((s) => s.base).join(""),
      defsLower,
      blob: defsLower.join("\n"),
      prior: staticPrior(trad, defs, freq, flags),
    };
    entries.push(e);
    byId.set(e.id, e);
  }

  const syllablePrefixes = new Set<string>();
  for (const b of syllableBases) for (let i = 1; i <= b.length; i++) syllablePrefixes.add(b.slice(0, i));

  return { entries, byId, syllableBases, syllablePrefixes };
}

// ---------------------------------------------------------------------------
// Jyutping

type QuerySyllable = { base: string; tone: string; partial: boolean };

/**
 * All ways to read `query` as a jyutping syllable sequence. Spaces and tones are optional;
 * the final syllable may be incomplete (typing in progress). Returns [] if it isn't jyutping.
 */
export function segmentJyutping(dict: Dictionary, query: string, limit = 16): QuerySyllable[][] {
  const tokens = query.toLowerCase().split(/[\s']+/).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => /^[a-z]+[1-6]?(?:[a-z]+[1-6]?)*$/.test(t))) return [];

  const segmentToken = (tok: string, isLast: boolean): QuerySyllable[][] => {
    const out: QuerySyllable[][] = [];
    const walk = (i: number, acc: QuerySyllable[]) => {
      if (out.length >= limit) return;
      if (i === tok.length) {
        out.push(acc);
        return;
      }
      for (let j = Math.min(tok.length, i + 6); j > i; j--) {
        const base = tok.slice(i, j);
        if (!/^[a-z]+$/.test(base)) continue;
        const tone = /[1-6]/.test(tok[j] ?? "") ? tok[j] : "";
        const end = j + tone.length;
        // A toneless final syllable may still be being typed ("nei ho" -> hou).
        const partial = isLast && end === tok.length && !tone;
        if (partial ? dict.syllablePrefixes.has(base) : dict.syllableBases.has(base))
          walk(end, [...acc, { base, tone, partial }]);
      }
    };
    walk(0, []);
    return out;
  };

  let segs: QuerySyllable[][] = [[]];
  tokens.forEach((tok, i) => {
    const parts = segmentToken(tok, i === tokens.length - 1);
    const next: QuerySyllable[][] = [];
    for (const s of segs) for (const p of parts) if (next.length < limit) next.push([...s, ...p]);
    segs = next;
  });
  // Prefer readings with fewer, complete syllables ("sin" over "si"+"n...").
  return segs.sort((a, b) => a.length - b.length);
}

function syllableMatches(q: QuerySyllable, s: { base: string; tone: string }) {
  if (q.tone && q.tone !== s.tone) return false;
  return q.partial ? s.base.startsWith(q.base) : s.base === q.base;
}

/** 3 = whole word, 2 = word starts with query, 1 = query appears inside the word, 0 = no match. */
function jyutpingTier(e: Entry, segs: QuerySyllable[][]) {
  let best = 0;
  for (const seg of segs) {
    const n = seg.length;
    if (n > e.syllables.length) continue;
    for (let start = 0; start + n <= e.syllables.length; start++) {
      let ok = true;
      for (let k = 0; k < n && ok; k++) ok = syllableMatches(seg[k], e.syllables[start + k]);
      if (!ok) continue;
      const whole = n === e.syllables.length && e.syllables[n - 1].base === seg[n - 1].base;
      const tier = start > 0 ? 1 : whole ? 3 : 2;
      if (tier > best) best = tier;
      if (best === 3) return 3;
      break;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// English

const LEADING_FILLER = /^(?:to|a|an|the)\s+/;

function core(gloss: string) {
  return gloss
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_FILLER, "")
    .replace(/[.!?]+$/, "");
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type EnglishQuery = { core: string; words: string[]; wordRes: RegExp[] };

function parseEnglish(query: string): EnglishQuery | null {
  const words = query.toLowerCase().match(/[a-z0-9']+/g);
  if (!words) return null;
  const last = words.length - 1;
  return {
    core: core(query.toLowerCase()),
    words,
    // Earlier words must be whole (allowing plurals); the last one may still be being typed.
    wordRes: words.map((w, i) => new RegExp(`\\b${escapeRe(w)}${i === last ? "" : "(?:s|es)?\\b"}`)),
  };
}

/**
 * 5 = a gloss is exactly the query, 4.2-4.7 = a gloss starts with it, 3 = one sense contains every word,
 * 2 = the words are spread across senses. Returns [tier, index of the best sense].
 */
function englishTier(e: Entry, q: EnglishQuery): [number, number] {
  for (const w of q.words) if (!e.blob.includes(w)) return [0, 0];
  let best = 0;
  let bestIdx = 0;
  for (let i = 0; i < e.defsLower.length && best < 5; i++) {
    const d = e.defsLower[i];
    if (!q.wordRes.every((re) => re.test(d))) continue;
    let tier = 3;
    for (const gloss of d.split(/[;,]/)) {
      const c = core(gloss);
      if (c === q.core) {
        tier = 5;
        break;
      }
      if (c.startsWith(q.core) && /\W|^$/.test(c.charAt(q.core.length))) {
        // "thank you very much" for "thank you" is nearly as good as exact; the more
        // it adds, the less it is about the query.
        const extra = c.slice(q.core.length).trim().split(/\s+/).length;
        tier = Math.max(tier, 4.8 - 0.05 * extra, 4.2);
      }
    }
    if (tier > best) {
      best = tier;
      bestIdx = i;
    }
  }
  if (!best && q.wordRes.every((re) => re.test(e.blob))) best = 2;
  return [best, bestIdx];
}

// ---------------------------------------------------------------------------

const HAN = /[㐀-鿿豈-﫿\u{20000}-\u{3134f}]/u;

export function normalizeQuery(q: string) {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

export function usageBonus(usage: Usage, id: string, query: string) {
  let b = 0;
  const u = usage.entries[id];
  if (u) {
    const ageDays = (Date.now() - u.t) / 86_400_000;
    b += 1.5 * Math.log2(1 + u.n) * (ageDays < 30 ? 1 : 0.5);
  }
  const qn = usage.queries[query]?.[id];
  if (qn) b += 4 * Math.log2(1 + qn);
  return b;
}

export function search(dict: Dictionary, rawQuery: string, usage: Usage, limit = 80): Result[] {
  const query = normalizeQuery(rawQuery);
  if (!query) return [];
  const results: Result[] = [];

  if (HAN.test(query)) {
    const q = query.replace(/\s+/g, "");
    for (const e of dict.entries) {
      const hit = (w: string) => (w === q ? 3 : w.startsWith(q) ? 2 : w.includes(q) ? 1 : 0);
      const tier = Math.max(hit(e.trad), hit(e.simp));
      if (tier)
        results.push({ entry: e, match: "chinese", score: tier * TIER_WEIGHT + e.prior + usageBonus(usage, e.id, query) });
    }
  } else {
    const segs = segmentJyutping(dict, query);
    const hasTone = /[a-z][1-6]/.test(query);
    // One letter is too little to search definitions with.
    const eng = hasTone || query.length < 2 ? null : parseEnglish(query);
    const prefilter = segs.map((s) => s.map((x) => x.base).join(""));

    for (const e of dict.entries) {
      let tier = 0;
      let match: Result["match"] = "jyutping";
      let senseIdx = 0;
      if (segs.length && prefilter.some((p) => e.basesJoined.includes(p))) {
        // Jyutping tiers map onto the English scale: whole word = exact gloss, etc.
        const jt = jyutpingTier(e, segs);
        if (jt) tier = jt + 2;
      }
      if (eng) {
        const [et, idx] = englishTier(e, eng);
        if (et > tier) {
          tier = et;
          match = "english";
          senseIdx = idx;
        }
      }
      if (!tier) continue;
      const score = tier * TIER_WEIGHT + e.prior - Math.min(0.6 * senseIdx, 8) + usageBonus(usage, e.id, query);
      results.push({ entry: e, match, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Entries the user has picked before, most-used first. */
export function recent(dict: Dictionary, usage: Usage, limit = 30): Entry[] {
  return Object.entries(usage.entries)
    .sort(([, a], [, b]) => b.n * 0.5 + b.t / 86_400_000 - (a.n * 0.5 + a.t / 86_400_000))
    .map(([id]) => dict.byId.get(id))
    .filter((e): e is Entry => !!e)
    .slice(0, limit);
}

const MAX_QUERIES = 500;

export function recordUsage(usage: Usage, id: string, rawQuery: string): Usage {
  const query = normalizeQuery(rawQuery);
  const prev = usage.entries[id];
  const entries = { ...usage.entries, [id]: { n: (prev?.n ?? 0) + 1, t: Date.now() } };
  let queries = usage.queries;
  if (query) {
    const { [query]: forQuery, ...rest } = queries;
    // Re-inserting moves the query to the end, so the oldest are dropped first.
    queries = { ...rest, [query]: { ...forQuery, [id]: (forQuery?.[id] ?? 0) + 1 } };
    const keys = Object.keys(queries);
    if (keys.length > MAX_QUERIES) for (const k of keys.slice(0, keys.length - MAX_QUERIES)) delete queries[k];
  }
  return { entries, queries };
}

export function forgetUsage(usage: Usage, id: string): Usage {
  const { [id]: _, ...entries } = usage.entries;
  const queries: Usage["queries"] = {};
  for (const [q, m] of Object.entries(usage.queries)) {
    const { [id]: __, ...rest } = m;
    if (Object.keys(rest).length) queries[q] = rest;
  }
  return { entries, queries };
}
