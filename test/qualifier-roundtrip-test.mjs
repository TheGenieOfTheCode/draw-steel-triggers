// Regression test: node test/qualifier-roundtrip-test.mjs
// Every parsed clause must survive the trigger builder untouched: each qualifier's settings go through the picker's form
// values and back, writing them must change nothing, and saving (which prunes impacts) must change nothing either.
// Fields no qualifier or builder control owns are listed.
import fs from "fs";
import { QUALIFIERS, readSettings, writeSettings, formValue, parseFormValue, ownedFields } from "../src/ui/qualifier-library.mjs";
import { IMPACTS, pruneImpacts } from "../src/ui/editor-impacts.mjs";

const SYSTEM_KEYWORDS = ["animal", "animapathy", "area", "charge", "chronopathy", "cryokinesis", "earth", "encounter", "fire", "green",
  "magic", "melee", "metamorphosis", "psionic", "pyrokinesis", "ranged", "resopathy", "rot", "performance", "strike", "telekinesis",
  "telepathy", "void", "weapon"];
globalThis.ds ??= { CONFIG: { abilities: { keywords: Object.fromEntries(SYSTEM_KEYWORDS.map((k) => [k, {}])) } } };

const CORE = new Set(["event", "events", "scope", "qualifiers", "range", "rangeOn", "rangeMin", "ownerInAbilityRange", "postRoll", "oncePerRound",
  "targetScoped", "rollerScoped", "fmBefore", "filtersOff", "impactText", "abilityKeywordGroups", "_customs", "_customPending",
  ...IMPACTS.flatMap((i) => i.keys)]);
const OWNED = new Set(QUALIFIERS.flatMap(ownedFields));

export function checkClause(clause) {
  const problems = [];
  for (const q of QUALIFIERS) {
    const copy = JSON.parse(JSON.stringify(clause));
    const settings = readSettings(q, copy);
    const fromForm = {};
    for (const r of q.rules) {
      const parsed = parseFormValue(r, formValue(r, settings[r.key]));
      if (parsed !== undefined) fromForm[r.key] = parsed;
    }
    const changed = writeSettings(q, copy, fromForm);
    if (changed.length || JSON.stringify(copy) !== JSON.stringify(clause)) problems.push(`${q.id} rewrote ${changed.join(", ") || "fields"}`);
  }
  const saved = JSON.parse(JSON.stringify(clause));
  pruneImpacts(saved);
  if (JSON.stringify(saved) !== JSON.stringify(clause)) problems.push(`saving rewrote it: ${JSON.stringify(clause)} became ${JSON.stringify(saved)}`);
  const unowned = Object.keys(clause).filter((k) => !CORE.has(k) && !OWNED.has(k));
  return { problems, unowned };
}

if (process.argv[1]?.endsWith("qualifier-roundtrip-test.mjs")) {
  const { parseTrigger, generateDSID } = await import("../src/parser/trigger-parser.mjs");
  const fixture = JSON.parse(fs.readFileSync(new URL("./trigger-fixture.json", import.meta.url)));
  let bad = 0, clauses = 0;
  const unowned = new Map();
  for (const f of fixture) {
    const p = parseTrigger(f.trigger, { dsid: generateDSID(f.name), ownerName: f.owner });
    for (const c of p.clauses) {
      clauses++;
      const r = checkClause(c);
      if (r.problems.length) { bad++; console.log(`FAIL ${f.name}: ${r.problems.join("; ")}`); }
      for (const k of r.unowned) unowned.set(k, [...(unowned.get(k) ?? []), f.name]);
    }
  }
  for (const [k, names] of unowned) console.log(`UNOWNED ${k}: ${names.slice(0, 3).join(", ")}`);
  console.log(`${clauses - bad}/${clauses} clauses round-trip unchanged`);
  if (bad || unowned.size) process.exitCode = 1;
}
