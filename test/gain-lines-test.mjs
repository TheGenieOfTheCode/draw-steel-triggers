// Regression test: node test/gain-lines-test.mjs
// Every 1st level heroic resource gain must read as automated, with the clauses its rule needs.
globalThis.ds ??= { CONFIG: { abilities: { keywords: {} } } };
globalThis.game ??= { i18n: { localize: (k) => k, format: (k) => k } };

const { featureGainLines, lineAutomated } = await import("../src/parser/feature-lines.mjs");

const piety = (text) => `<p><strong>Piety:</strong> You [[/gain 2 hr]]{gain 2 piety} ${text}</p>`;
const CASES = [
  ["Creation", piety("the first time in an encounter that a creature within 10 squares uses an area ability."), "piety",
    [{ event: "USES_ABILITY", scope: "ANY", range: 10, abilityKeywords: ["area"] }]],
  ["Death", piety("the first time in an encounter that a creature within 10 squares who isn’t a minion is reduced to 0 Stamina, or the first time in an encounter that a solo creature within 10 squares becomes winded."), "piety",
    [{ event: "TAKES_DAMAGE", scope: "ANY", range: 10, damageOutcome: ["zero"], organization: { exclude: ["minion"] } },
      { event: "WINDED", scope: "ANY", range: 10, organization: { include: ["solo"] } }]],
  ["Fate", piety("the first time in an encounter that an ally within 10 squares obtains a tier 3 outcome on a power roll, or an enemy within 10 squares obtains a tier 1 outcome on a power roll."), "piety",
    [{ event: "POWER_ROLL_RESULT", scope: "ALLY", range: 10, tierFilter: [3] }, { event: "POWER_ROLL_RESULT", scope: "ENEMY", range: 10, tierFilter: [1] }]],
  ["Love", piety("the first time in an encounter that you or any ally within 10 squares uses the Aid Attack maneuver or an ability that targets an ally."), "piety",
    [{ event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: 10, abilityDsid: "aid-attack" }, { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: 10, targetsAlly: true }]],
  ["Protection", piety("the first time in an encounter that you or any ally within 10 squares gains temporary Stamina, or uses a triggered action to reduce incoming damage or to impose a bane or double bane on an enemy’s power roll."), "piety",
    [{ event: "GAINS_TEMP_STAMINA", scope: "SELF_OR_ALLY", range: 10 }, { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: 10, abilityType: "triggered", defensiveTriggered: true }]],
  ["Trickery", piety("the first time in an encounter that you or a creature within 10 squares takes the Aid Attack or Hide maneuver."), "piety",
    [{ event: "USES_ABILITY", scope: "ANY", range: 10, abilityDsid: "aid-attack" }, { event: "USES_ABILITY", scope: "ANY", range: 10, abilityDsid: "dsct-hide" }]],
  ["War", piety("the first time in an encounter that you or a creature within 10 squares takes damage greater than 10 + your level in a single turn."), "piety",
    [{ event: "TAKES_DAMAGE", scope: "ANY", range: 10 }], { gates: ["turnDamageOverLevel"], turnDamageBase: 10 }],
  ["Null Field", "<p>Additionally, the first time each combat round that an enemy in the area of your Null Field ability (see below) uses a main action, you [[/gain 1 hr]]{gain 1 discipline}.</p>", "discipline",
    [{ event: "USES_ABILITY", scope: "ENEMY", range: "none", abilityType: "main" }], { gates: ["inNullField"], once: "round" }],
];

const strip = (c) => { const { qualifiers, events, ...rest } = c; return rest; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let passed = 0;
for (const [name, html, resource, clauses, extra = {}] of CASES) {
  const line = featureGainLines(html, { resource }).find((l) => l.kind === "trigger");
  const problems = [];
  if (!line) problems.push("no gain line read");
  else {
    if (!lineAutomated(line)) problems.push(`not automated (manual: ${line.manual.join(", ") || "none"})`);
    const got = line.parse.clauses.map(strip);
    if (!same(got, clauses)) problems.push(`clauses\n    expected: ${JSON.stringify(clauses)}\n    got:      ${JSON.stringify(got)}`);
    for (const [key, want] of Object.entries(extra)) if (!same(line[key], want)) problems.push(`${key}: expected ${JSON.stringify(want)}, got ${JSON.stringify(line[key])}`);
    if (!extra.once && line.once !== "encounter") problems.push(`once: expected "encounter", got ${JSON.stringify(line.once)}`);
  }
  if (problems.length) console.log(`FAIL ${name}\n  ${problems.join("\n  ")}`);
  else passed++;
}
console.log(`${passed}/${CASES.length} passed`);
if (passed !== CASES.length) process.exitCode = 1;
