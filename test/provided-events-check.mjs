// Melee Superiority's opportunity attack line stays "later" until a module provides OPPORTUNITY_ATTACK.
// node test/provided-events-check.mjs
globalThis.ds ??= { CONFIG: { abilities: { keywords: {} } } };
const { provideEvent } = await import("../src/parser/trigger-parser.mjs");
const { featureTriggerLines } = await import("../src/parser/feature-triggers.mjs");
const html = "<p>After constant drills, you can more accurately anticipate an enemy’s plan and thwart their attempts to move across the battlefield. Whenever you make an opportunity attack, the target’s speed is reduced to 0 until the end of the current turn.</p><p><strong>Mark Benefit:</strong> When a creature marked by you attempts to move or shift within distance of your melee free strike, you can use a free triggered action and spend 2 focus to make a melee free strike against that creature</p>";
const show = () => featureTriggerLines(html, { dsid: "melee-superiority", name: "Melee Superiority", resource: "focus" })
  .filter((l) => /opportunity attack/.test(l.sentence))
  .map((l) => `${l.kind}${l.later ? ` (${l.later})` : ""} events=${l.parse.clauses.map((c) => c.event).join(",")}`);
const before = show();
provideEvent("OPPORTUNITY_ATTACK");
const after = show();
console.log("without a provider:", before);
console.log("with a provider:   ", after);
const ok = before.every((s) => s.startsWith("later (Opportunity attacks)")) && after.every((s) => s.startsWith("trigger") && s.includes("OPPORTUNITY_ATTACK"));
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
