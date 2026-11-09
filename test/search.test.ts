import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { entryId, loadDictionary, recordUsage, search, segmentJyutping, type Usage } from "../src/search";

const t0 = performance.now();
const dict = loadDictionary(join(__dirname, "..", "assets", "dict.json"));
console.log(`loaded ${dict.entries.length} entries in ${Math.round(performance.now() - t0)}ms`);

const empty: Usage = { entries: {}, queries: {} };
const top = (q: string, n = 5, usage = empty) => search(dict, q, usage).slice(0, n).map((r) => r.entry.trad);
const topIds = (q: string, n = 5) => search(dict, q, empty).slice(0, n).map((r) => r.entry.id);

test("jyutping with tones", () => {
  assert.equal(top("nei5 hou2")[0], "你好");
  assert.equal(top("m4 goi1")[0], "唔該");
});

test("jyutping without tones or spaces", () => {
  assert.equal(top("neihou")[0], "你好");
  assert.equal(top("mgoi")[0], "唔該");
  assert.ok(top("sik faan").includes("食飯"));
});

test("partial final syllable", () => {
  assert.ok(top("nei ho").includes("你好"));
});

test("single syllable prefers the common reading", () => {
  assert.equal(topIds("ge3")[0], entryId("嘅", "ge3"));
  assert.ok(topIds("haang", 3).includes(entryId("行", "haang4")));
});

test("english definitions", () => {
  assert.ok(top("hello").includes("你好"));
  // Cantonese forms above Mandarin 謝謝, even though 謝謝 has an exact "thank you" gloss.
  assert.ok(["多謝晒", "多謝嗮"].includes(top("thank you")[0]));
  assert.ok(top("thank you", 6).includes("唔該晒"));
  assert.ok(top("thanks", 10).includes("多謝"));
  assert.ok(top("computer").includes("電腦"));
  assert.ok(top("to eat").includes("食"));
});

test("chinese characters", () => {
  assert.equal(top("電腦")[0], "電腦");
  assert.equal(top("电脑")[0], "電腦");
});

test("segmentation rejects non-jyutping", () => {
  assert.deepEqual(segmentJyutping(dict, "hello"), []);
  assert.ok(segmentJyutping(dict, "gwongdung").length > 0);
});

test("usage promotes picked entries for that query", () => {
  const before = top("hou", 10);
  const target = search(dict, "hou", empty)[8].entry;
  let u = empty;
  for (let i = 0; i < 3; i++) u = recordUsage(u, target.id, "hou");
  assert.notEqual(before[0], target.trad);
  assert.equal(search(dict, "hou", u)[0].entry.id, target.id);
});

test("search is fast enough per keystroke", () => {
  for (const q of ["a", "h", "nei", "to go", "sik6", "好"]) {
    const s = performance.now();
    search(dict, q, empty);
    const ms = performance.now() - s;
    console.log(`  ${q.padEnd(6)} ${ms.toFixed(1)}ms`);
    assert.ok(ms < 150, `${q} took ${ms}ms`);
  }
});

for (const q of ["hello", "nei", "hou", "thank you", "eat", "gwongdung", "love", "sik", "computer", "beautiful"]) {
  test(`show: ${q}`, () => {
    console.log(
      `  ${q}: ` +
        search(dict, q, empty)
          .slice(0, 8)
          .map((r) => `${r.entry.trad}(${r.entry.jyutping};${r.score.toFixed(1)})`)
          .join(" "),
    );
  });
}
