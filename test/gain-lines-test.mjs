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
  ["Melodrama: natural 2", "<p>Whenever a creature rolls a natural 2 on a power roll, you [[/gain 2 heroic]]{gain 2 drama}.</p>", "drama",
    [{ event: "NATURAL_2", scope: "ANY", range: "none" }], { once: null }],
  ["Melodrama: villainous damage", "<p>The first time the Director deals damage to a hero using a Villain action or an ability that costs Malice, you [[/gain 2 heroic]]{gain 2 drama}.</p>", "drama",
    [{ event: "TAKES_DAMAGE", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }], { gates: ["maliceDamage"] }],
  ["Melodrama: long fall", "<p>The first time a hero unwillingly falls 5 or more squares, you [[/gain 2 heroic]]{gain 2 drama}.</p>", "drama",
    [{ event: "FALL_START", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }], { gates: ["unwillingFall"], fallMin: 5 }],
  ["Melodrama: last Recovery", "<p>Whenever a hero spends their last Recovery, [[/gain 2 heroic]]{gain 2 drama}.</p>", "drama",
    [{ event: "SPENDS_RECOVERY", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }], { gates: ["lastRecovery"], once: null }],
  ["Null: Malice ability", "<p>The first time each combat round that the Director uses an ability that costs Malice, you [[/gain 1 hr]]{gain 1 discipline}.</p>", "discipline",
    [{ event: "USES_ABILITY", scope: "ANY", range: "none" }], { gates: ["maliceAbility"], once: "round" }],
  ["Knowledge keeps its own check", piety("the first time in an encounter that the Director spends Malice."), "piety",
    [{ event: "MALICE_SPENT", scope: "ANY", range: "none" }], { gates: [] }],
];

const BONUSES = [
  ["Blessed Domain", "<p>Whenever you gain piety from a domain effect, you gain 1 additional piety.</p>", "piety", "domain", true],
  ["Melodrama: chosen event", "<p>Whenever the chosen event grants you drama, you [[/gain 1 heroic]]{gain 1 additional drama}.</p>", "drama", "chosen", false],
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
    if (!("once" in extra) && line.once !== "encounter") problems.push(`once: expected "encounter", got ${JSON.stringify(line.once)}`);
  }
  if (problems.length) console.log(`FAIL ${name}\n  ${problems.join("\n  ")}`);
  else passed++;
}
for (const [name, html, resource, bonusFor, automated] of BONUSES) {
  const line = featureGainLines(html, { resource })[0];
  const problems = [];
  if (line?.kind !== "bonus") problems.push(`kind: expected "bonus", got ${JSON.stringify(line?.kind)}`);
  else {
    if (line.bonusFor !== bonusFor) problems.push(`bonusFor: expected ${bonusFor}, got ${line.bonusFor}`);
    if (line.amount !== "1") problems.push(`amount: expected "1", got ${JSON.stringify(line.amount)}`);
    if (lineAutomated(line) !== automated) problems.push(`automated: expected ${automated}`);
    if (!automated && !lineAutomated({ ...line, bonusTarget: "some-line" })) problems.push("not automated once a target is picked");
  }
  if (problems.length) console.log(`FAIL ${name}\n  ${problems.join("\n  ")}`);
  else passed++;
}
const total = CASES.length + BONUSES.length;
console.log(`${passed}/${total} passed`);
if (passed !== total) process.exitCode = 1;
