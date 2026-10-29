// Regression test: node test/potency-roundtrip-test.mjs
// A parsed Change the Potency impact must survive the trigger builder: its fields go through form values and back
// through read(), then saving prunes impacts, and the clause must come out unchanged, characteristic included.
const CHARS = ["might", "agility", "reason", "intuition", "presence"];
globalThis.ds ??= { CONFIG: { abilities: { keywords: {} } } };
ds.CONFIG.characteristics ??= Object.fromEntries(CHARS.map((c) => [c, { label: c }]));
globalThis.game ??= { i18n: { localize: (k) => k, format: (k) => k } };

const { parseTrigger } = await import("../src/parser/trigger-parser.mjs");
const { impactById, pruneImpacts } = await import("../src/ui/editor-impacts.mjs");

const formValues = (fields) => Object.fromEntries(fields.map((f) => [f.name,
  f.type === "checkbox" ? !!f.checked
    : f.type === "select" ? String(f.options.find((o) => o.selected)?.value ?? f.options[0]?.value ?? "")
    : String(f.value ?? "")]));

function throughBuilder(clause) {
  const impact = impactById("potencyMod");
  const copy = JSON.parse(JSON.stringify(clause));
  impact.read(copy, formValues(impact.fields(copy)));
  pruneImpacts(copy);
  return copy;
}

const CASES = [
  ["You would take damage", "Any potency associated with the damage is reduced by R.", { amount: -1, char: "reason", scope: "all" }],
  ["You would take damage", "Any potency associated with the damage is reduced by your Presence score.", { amount: -1, char: "presence", scope: "all" }],
  ["An enemy uses an ability against you", "The triggering ability's damage is halved, and any potency associated with the damage is reduced by M.", { amount: -1, char: "might", scope: "all" }],
  ["You deal damage to a creature", "Any potency associated with the damage is increased by I.", { amount: 1, char: "intuition", scope: "all" }],
  ["You would take damage", "The potency of one effect associated with the damage is reduced by 1.", { amount: -1, scope: "one" }],
  ["You would take damage", "The potency of any effects associated with the damage is increased by 2.", { amount: 2, scope: "all" }],
];

let bad = 0;
for (const [trigger, effectText, want] of CASES) {
  const parsed = parseTrigger(trigger, { effectText });
  const clause = parsed.clauses.find((c) => c.potencyMod);
  const label = `"${effectText}"`;
  if (!clause) { bad++; console.log(`FAIL ${label}: no potency change parsed`); continue; }
  if (JSON.stringify(clause.potencyMod) !== JSON.stringify(want)) {
    bad++; console.log(`FAIL ${label}: parsed ${JSON.stringify(clause.potencyMod)}, expected ${JSON.stringify(want)}`); continue;
  }
  const saved = throughBuilder(clause);
  if (JSON.stringify(saved) !== JSON.stringify(clause)) { bad++; console.log(`FAIL ${label}: ${JSON.stringify(clause.potencyMod)} became ${JSON.stringify(saved.potencyMod)}`); continue; }
  console.log(`ok   ${label}: ${JSON.stringify(saved.potencyMod)}`);
}

const blank = { event: "WOULD_TAKE_DAMAGE", potencyMod: { amount: -1, char: "reason", scope: "all", spend: true } };
const cleared = JSON.parse(JSON.stringify(blank));
impactById("potencyMod").read(cleared, { ...formValues(impactById("potencyMod").fields(cleared)), char: "" });
if (cleared.potencyMod.char !== undefined || cleared.potencyMod.amount !== -1 || !cleared.potencyMod.spend) {
  bad++; console.log(`FAIL a blank characteristic should leave a flat -1: got ${JSON.stringify(cleared.potencyMod)}`);
} else console.log(`ok   blank characteristic gives a flat number: ${JSON.stringify(cleared.potencyMod)}`);

console.log(bad ? `${bad} failed` : "PASS");
process.exitCode = bad ? 1 : 0;
