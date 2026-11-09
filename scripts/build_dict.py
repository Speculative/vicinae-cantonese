"""Build assets/dict.json from CC-Canto, CC-CEDICT and the CC-Canto readings file.

Usage: python scripts/build_dict.py <data-dir> <out.json>

<data-dir> must contain cccanto-webdist.txt, cccedict-canto-readings-*.txt and
cedict_1_0_ts_utf-8_mdbg.txt (see scripts/fetch_data.sh). Frequencies come from
HKCanCor (via pycantonese) and wordfreq's Chinese list.

Output entry layout: [trad, simp, jyutping, defs ("\n"-joined), freq, flags, pinyin]
  freq  -- zipf-like base usage score, 0 when unknown
  flags -- bit 0: has CC-Canto definitions, bit 1: has CC-CEDICT definitions,
           bit 2: reading derived per character (no dictionary reading)
  pinyin -- display only, with tone marks; the word's CC-CEDICT readings, " / "-joined,
            those paired with this jyutping first; CC-Canto's pinyin for words CC-CEDICT lacks
"""

import glob
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict

LINE_RE = re.compile(r"^(\S+) (\S+) \[([^\]]*)\](?: \{([^}]*)\})?(?: /(.*)/)?")
FLAG_CANTO, FLAG_CEDICT, FLAG_DERIVED = 1, 2, 4
# Nonstandard spellings mapped to the form the frequency corpora use.
VARIANTS_FOR_FREQ = {"嗮": "晒"}


def norm_jyutping(s):
    s = s.lower().replace(",", " ")
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return " ".join(s.split())


TONE_MARKS = {"a": "āáǎà", "e": "ēéěè", "i": "īíǐì", "o": "ōóǒò", "u": "ūúǔù", "ü": "ǖǘǚǜ"}


def pinyin_marks(s):
    """"ni3 hao3" -> "nǐ hǎo"; tone 5 (neutral) is left unmarked."""

    def syllable(m):
        syl, tone = m.group(1).replace("u:", "ü").replace("v", "ü").replace("U:", "Ü"), int(m.group(2))
        if tone == 5:
            return syl
        lower = syl.lower()
        # Standard placement: a or e if present, the o of "ou", otherwise the last vowel.
        for v in ("a", "e"):
            if v in lower:
                i = lower.index(v)
                break
        else:
            i = lower.index("o") if "ou" in lower else max(lower.rfind(v) for v in "iouü")
        if i < 0:
            return syl
        marked = TONE_MARKS[lower[i]][tone - 1]
        return syl[:i] + (marked.upper() if syl[i].isupper() else marked) + syl[i + 1 :]

    s = re.sub(r"([1-5])(?=[A-Za-z])", r"\1 ", s.strip())  # "duo1xie4" -> "duo1 xie4"
    s = re.sub(r"\s+([,，])", r"\1", s)
    return re.sub(r"([A-Za-zü:]+)([1-5])", syllable, s)


def norm_pinyin(s):
    return re.sub(r"\s+", "", s.lower().replace("u:", "v"))


def split_defs(raw):
    raw = re.sub(r"\s*#.*$", "", raw).strip().strip("/")
    out = []
    for d in raw.split("/"):
        # CC-Canto sometimes packs senses as "1. foo 2. bar"
        parts = re.split(r"(?:^|\s)\d+\.\s+", d)
        out.extend(p.strip() for p in parts if p.strip())
    # CC-Canto writes part of speech as its own sense, e.g. "/(noun)/Company/".
    merged = []
    for d in out:
        if merged and re.fullmatch(r"\([a-z ]+\)", merged[-1]):
            merged[-1] = f"{merged[-1]} {d}"
        else:
            merged.append(d)
    return merged


def read_lines(path):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                continue
            m = LINE_RE.match(line.rstrip("\n"))
            if m:
                yield m.groups()


def load_freq():
    import pycantonese
    import wordfreq

    tokens = pycantonese.hkcancor().tokens()
    hk = Counter(t.word for t in tokens)
    hk_reading = Counter((t.word, (t.jyutping or "").replace(" ", "")) for t in tokens)
    hk_total = len(tokens)
    zh = wordfreq.get_frequency_dict("zh")

    def attested(trad, simp):
        scores = [0.0]
        if trad in hk:
            scores.append(math.log10(hk[trad] / hk_total * 1e9))
        f = zh.get(simp)
        if f:
            # wordfreq's Chinese list is written Mandarin; a word only found there
            # is probably less common in Cantonese than its count suggests.
            scores.append(math.log10(f * 1e9) - 1.5)
        return max(scores)

    def compositional(trad, simp):
        """Estimate for colloquial compounds neither corpus has as one token, e.g. 多謝晒 = 多謝 + 晒."""
        t, s = VARIANTS_FOR_FREQ.get(trad, trad), simp
        for ch, std in VARIANTS_FOR_FREQ.items():
            t, s = t.replace(ch, std), s.replace(ch, std)
        best = 0.0
        for i in range(1, len(t)):
            a, b = attested(t[:i], s[:i]), attested(t[i:], s[i:])
            # Splitting into two single characters says little about the word.
            if a and b and (i > 1 or len(t) - i > 1):
                best = max(best, min(a, b) - 1.0)
        return best

    def freq(trad, simp, jyut, reading_rank, canto):
        """reading_rank: index of this reading among the word's readings, in source order."""
        base = attested(trad, simp)
        if not base and canto and len(trad) > 1:
            base = compositional(trad, simp)
        if base == 0:
            return 0
        # Word frequencies don't say which reading is meant; HKCanCor's tagged
        # readings do, otherwise fall back to dictionary order.
        if trad in hk:
            share = hk_reading[(trad, jyut.replace(" ", ""))] / hk[trad]
            base += math.log10(max(share, 0.005))
        else:
            base -= 0.3 * reading_rank
        return round(max(base, 0.1), 2)

    return freq


def main(data_dir, out_path):
    canto_path = os.path.join(data_dir, "cccanto-webdist.txt")
    readings_path = sorted(glob.glob(os.path.join(data_dir, "cccedict-canto-readings-*.txt")))[-1]
    cedict_path = os.path.join(data_dir, "cedict_1_0_ts_utf-8_mdbg.txt")

    # (trad, jyutping) -> entry
    entries = {}
    order = []

    def add(trad, simp, jyut, defs, flag, pinyin):
        key = (trad, jyut)
        e = entries.get(key)
        if e is None:
            e = entries[key] = {
                "trad": trad, "simp": simp, "jyut": jyut, "canto": [], "cedict": [], "flags": 0,
                "pinyin": [], "canto_pinyin": [],
            }
            order.append(key)
        bucket = e["canto"] if flag & FLAG_CANTO else e["cedict"]
        for d in defs:
            if d not in e["canto"] and d not in e["cedict"]:
                bucket.append(d)
        e["flags"] |= flag
        # CEDICT pinyin is paired with this jyutping by the readings file; CC-Canto's is
        # only a fallback for words CEDICT lacks (it's sometimes copied from a variant).
        p = pinyin_marks(pinyin)
        target = e["pinyin"] if flag & FLAG_CEDICT else e["canto_pinyin"]
        if p and all(p.lower() != q.lower() for q in target):
            target.append(p)

    for trad, simp, pin, jyut, defs in read_lines(canto_path):
        if jyut and defs:
            add(trad, simp, norm_jyutping(jyut), split_defs(defs), FLAG_CANTO, pin)

    readings = defaultdict(list)
    for trad, simp, pin, jyut, _ in read_lines(readings_path):
        if jyut:
            readings[(trad, simp, norm_pinyin(pin))].append(norm_jyutping(jyut))

    cedict = [g for g in read_lines(cedict_path) if g[4]]

    # Per-character readings, used for CEDICT words the readings file doesn't cover.
    char_readings = defaultdict(set)
    for (trad, _), e in entries.items():
        if len(trad) == 1:
            char_readings[trad].add(e["jyut"])
    for (trad, _s, _p), js in readings.items():
        if len(trad) == 1:
            char_readings[trad].update(js)

    def derive(trad):
        out = []
        for ch in trad:
            r = char_readings.get(ch)
            if not r or len(r) != 1:
                return None
            out.append(next(iter(r)))
        return " ".join(out)

    derived = dropped = 0
    for trad, simp, pin, _, defs in cedict:
        defs = split_defs(defs)
        js = readings.get((trad, simp, norm_pinyin(pin)))
        if js:
            for j in dict.fromkeys(js):
                add(trad, simp, j, defs, FLAG_CEDICT, pin)
            continue
        j = derive(trad)
        if j:
            derived += 1
            add(trad, simp, j, defs, FLAG_CEDICT | FLAG_DERIVED, pin)
        else:
            dropped += 1

    # The readings file's pinyin<->jyutping pairing is noisy (it pairs 好 hào with
    # hou2, and nothing with 行 haang4), so show every Mandarin reading of the word,
    # with the paired ones first.
    word_pinyin = defaultdict(list)
    for trad, _simp, pin, _, _ in cedict:
        p = pinyin_marks(pin)
        if all(p.lower() != q.lower() for q in word_pinyin[trad]):
            word_pinyin[trad].append(p)

    def display_pinyin(e):
        out = list(e["pinyin"])
        for p in word_pinyin.get(e["trad"], []):
            if all(p.lower() != q.lower() for q in out):
                out.append(p)
        return " / ".join(out or e["canto_pinyin"])

    freq = load_freq()
    reading_rank = Counter()
    out = []
    for key in order:
        e = entries[key]
        flags = e["flags"]
        # A dictionary reading anywhere beats a derived one.
        if flags & FLAG_DERIVED and flags & FLAG_CANTO:
            flags &= ~FLAG_DERIVED
        defs = e["canto"] + e["cedict"]
        out.append([e["trad"], e["simp"], e["jyut"], "\n".join(defs), freq(e["trad"], e["simp"], e["jyut"], reading_rank[e["trad"]], bool(flags & FLAG_CANTO)), flags, display_pinyin(e)])
        reading_rank[e["trad"]] += 1

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "entries": out}, f, ensure_ascii=False, separators=(",", ":"))

    print(f"{len(out)} entries ({derived} derived readings, {dropped} CEDICT entries without a reading dropped)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
