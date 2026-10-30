import { parseTrigger, generateDSID } from "./trigger-parser.mjs";

const GAIN_ENRICHER = /\[\[\/gain\s+([^\]]*?)\s*\]\](?:\{([^}]*)\})?/gi;
const OTHER_ENRICHER = /\[\[[^\]]*\]\](?:\{([^}]*)\})?/g;
const UUID_LINK = /@UUID\[[^\]]*\](?:\{([^}]*)\})?/g;
const MARK = "\u0001";
const AMOUNT = String.raw`(\d+d\d+(?:\s*\+\s*\d+)?|\d+)`;

const decode = (s) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#39;|&rsquo;/g, "’").replace(/&quot;/g, "\"");

function gainAmount(inner) {
  const words = inner.trim().split(/\s+/);
  const typeAt = words.findIndex((w, i) => i > 0 && /^[a-z]+$/i.test(w) && !/^d\d/.test(w));
  return (typeAt > 0 ? words.slice(0, typeAt) : words).join(" ").replace(/\s+/g, "");
}

function blocksOf(html, resource) {
  const amounts = [];
  let text = String(html ?? "").replace(GAIN_ENRICHER, (m, inner, label) => {
    if (!/\b(hr|heroic)\b/i.test(inner)) return label ?? "";
    amounts.push(gainAmount(inner));
    return `${MARK}${amounts.length - 1}${MARK}${label ?? `gain ${gainAmount(inner)} ${resource}`}`;
  });
  text = text.replace(OTHER_ENRICHER, (m, label) => label ?? "").replace(UUID_LINK, (m, label) => label ?? "");
  text = text.replace(/<\/(p|li|h\d|tr|div)>|<br\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  return { amounts, blocks: decode(text).split(/\n+/).map((b) => b.replace(/\s+/g, " ").trim()).filter(Boolean) };
}

const sentencesOf = (block) => block.split(/(?<=[.!?])\s+(?=[A-Z\u0001])/);

const ONCE_ROUND = /\b(?:each|every|in a|per) (?:combat )?round\b/i;
const ONCE_STRIP = /\b(?:each|every|in a|in an|per|during the|during an|this) (?:combat )?(?:round|encounter)\b/gi;

const GATES = [
  ["dealerJudged", /judged by you(?: \([^)]*\))? deals damage to you/i],
  ["victimJudged", /damage to a creature judged by you/i],
  ["victimMarked", /damages? a (?:creature|target) marked by you/i],
  ["surged", /incorporating (?:1|one) or more surges/i],
  ["maliceAbility", /uses an ability that costs? malice/i],
  ["maliceDamage", /deals damage to a hero using a villain action or an ability that costs malice/i],
  ["lineOfEffect", /line of effect/i],
  ["threeHeroes", /three or more heroes use an ability on the same turn/i],
  ["heroDeath", /\b(?:you or another hero|any hero|a hero) dies\b/i],
  ["threeSurges", /\bwith 3 surges\b/i],
  ["turnDamageOverLevel", /greater than \d+ \+ your level in a single turn/i],
  ["inNullField", /in the area of your null field/i],
  ["unwillingFall", /unwillingly falls \d+ or more squares/i],
  ["lastRecovery", /spends their last recovery/i],
];

const NOT_YET = "an event Triggers does not detect yet";
const NON_MINION = "a non-minion or solo creature";
const OUTCOME_TIER = "an outcome tier on someone else's roll";
const UNWILLING = "an unwilling death or fall";
const VILLAIN = "damage from a villain action";
const FIXABLE = new Set([NOT_YET, NON_MINION, OUTCOME_TIER, UNWILLING, VILLAIN]);
const PICK_EVENT = "the event it adds to, which you pick in the trigger builder";

const MANUAL = [
  [/null field(?! ability(?: \([^)]*\))? uses a main action)/i, "the area of the Null Field"],
  [/\bcompanion\b/i, "a creature adjacent to your companion"],
  [/summoner['’]s range/i, "the Summoner's Range"],
  [/\bunwillingly\b/i, UNWILLING],
  [/that can be (?:spent|used) only/i, "a gain that can be spent on only one thing"],
  [/\byou can [^.]*\bgain\b/i, "a choice the player makes"],
  [/villain action/i, VILLAIN],
  [/appeal to the muses/i, "the Appeal to the Muses roll at the start of your turn"],
  [/who isn['’]t a minion|\bsolo creature\b/i, NON_MINION],
  [/tier \d outcome/i, OUTCOME_TIER],
  [/area ability|aid attack|hide maneuver|temporary stamina|triggered action|single turn|spends? malice|natural 2\b|last recovery|falls \d+/i, NOT_YET],
];

const TYPED = ["acid", "cold", "corruption", "fire", "holy", "lightning", "poison", "psychic", "sonic"];
const NEAR = String.raw`within (\d+) squares(?: of you)?`;
const words = (list) => list.split(/,\s*(?:or\s+)?|\s+or\s+/).map((w) => w.trim().toLowerCase()).filter(Boolean);

const FIXUPS = [
  [new RegExp(`^you or (?:a )?creature ${NEAR} gains temporary stamina, or uses a triggered action`, "i"), (m) => [
    { event: "GAINS_TEMP_STAMINA", scope: "ANY", range: Number(m[1]) },
    { event: "USES_ABILITY", scope: "ANY", range: Number(m[1]), abilityType: "triggered", defensiveTriggered: true },
  ]],
  [new RegExp(`^you or any ally ${NEAR} gains temporary stamina, or uses a triggered action`, "i"), (m) => [
    { event: "GAINS_TEMP_STAMINA", scope: "SELF_OR_ALLY", range: Number(m[1]) },
    { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: Number(m[1]), abilityType: "triggered", defensiveTriggered: true },
  ]],
  [new RegExp(`^a creature ${NEAR} uses an area ability`, "i"), (m) => [
    { event: "USES_ABILITY", scope: "ANY", range: Number(m[1]), abilityKeywords: ["area"] },
  ]],
  [new RegExp(`^a creature ${NEAR} who isn['’]t a minion is reduced to 0 stamina, or .*?a solo creature ${NEAR} becomes winded`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageOutcome: ["zero"], organization: { exclude: ["minion"] } },
    { event: "WINDED", scope: "ANY", range: Number(m[2]), organization: { include: ["solo"] } },
  ]],
  [new RegExp(`^an ally ${NEAR} obtains a tier (\\d) outcome on a power roll, or an enemy ${NEAR} obtains a tier (\\d) outcome`, "i"), (m) => [
    { event: "POWER_ROLL_RESULT", scope: "ALLY", range: Number(m[1]), tierFilter: [Number(m[2])] },
    { event: "POWER_ROLL_RESULT", scope: "ENEMY", range: Number(m[3]), tierFilter: [Number(m[4])] },
  ]],
  [new RegExp(`^you or any ally ${NEAR} uses the aid attack maneuver or an ability that targets an ally`, "i"), (m) => [
    { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: Number(m[1]), abilityDsid: "aid-attack" },
    { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: Number(m[1]), targetsAlly: true },
  ]],
  [new RegExp(`^you or a creature ${NEAR} takes the aid attack or hide maneuver`, "i"), (m) => [
    { event: "USES_ABILITY", scope: "ANY", range: Number(m[1]), abilityDsid: "aid-attack" },
    { event: "USES_ABILITY", scope: "ANY", range: Number(m[1]), abilityDsid: "dsct-hide" },
  ]],
  [new RegExp(`^you or a creature ${NEAR} takes damage greater than \\d+ \\+ your level`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]) },
  ]],
  [/^an enemy in the area of your null field ability uses a main action/i, [
    { event: "USES_ABILITY", scope: "ENEMY", range: "none", abilityType: "main" },
  ]],
  [new RegExp(`^you or an ally ${NEAR} uses a triggered action`, "i"), (m) => [
    { event: "USES_ABILITY", scope: "SELF_OR_ALLY", range: Number(m[1]), abilityType: "triggered" },
  ]],
  [new RegExp(`^you or a creature ${NEAR} teleports or uses an area ability`, "i"), (m) => [
    { event: "TELEPORTS", scope: "ANY", range: Number(m[1]) },
    { event: "USES_ABILITY", scope: "ANY", range: Number(m[1]), abilityKeywords: ["area"] },
  ]],
  [/^a creature rolls a natural 2 on a power roll/i, [{ event: "NATURAL_2", scope: "ANY", range: "none" }]],
  [/^the director deals damage to a hero using a villain action/i, [{ event: "TAKES_DAMAGE", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }]],
  [/^a hero unwillingly falls \d+ or more squares/i, [{ event: "FALL_START", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }]],
  [/^a hero spends their last recovery/i, [{ event: "SPENDS_RECOVERY", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }]],
  [/^the director spends malice/i, [{ event: "MALICE_SPENT", scope: "ANY", range: "none" }]],
  [new RegExp(`^you or a creature ${NEAR} gains a surge`, "i"), (m) => [{ event: "GAINS_SURGE", scope: "ANY", range: Number(m[1]) }]],
  [new RegExp(`^you or a creature ${NEAR} takes damage that isn['’]t untyped greater than`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageTypes: TYPED },
  ]],
  [new RegExp(`^you or a creature ${NEAR} takes ([a-z ,]+?) damage, or is made ([a-z ,]+)$`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageTypes: words(m[2]) },
    { event: "CONDITION_GAIN", scope: "ANY", range: Number(m[1]), conditions: words(m[3]) },
  ]],
  [new RegExp(`^you or a creature ${NEAR} takes ([a-z ,]+?) damage, begins dying, or dies`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageTypes: words(m[2]) },
    { event: "DYING", scope: "ANY", range: Number(m[1]) },
    { event: "DIES", scope: "ANY", range: Number(m[1]) },
  ]],
  [/the director uses an ability that costs malice/i, { event: "USES_ABILITY", scope: "ANY", range: "none" }],
  [/rolls a natural 19 or 20/i, { event: "NATURAL_19_20", scope: "ANY", range: "none" }],
  [/three or more heroes use an ability/i, { event: "USES_ABILITY", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }],
  [/(?:you or another hero|any hero) dies/i, { event: "STAMINA_BELOW", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }],
  [/any hero is made winded/i, { event: "WINDED", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }],
  [new RegExp(`^you or a creature ${NEAR} takes damage that isn['’]t untyped or holy, or uses an ability or effect that has them change their form or size`, "i"), (m) => [
    { event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageTypes: TYPED.filter((t) => t !== "holy") },
    { event: "SIZE_CHANGES", scope: "ANY", range: Number(m[1]) },
    { event: "FORM_CHANGES", scope: "ANY", range: Number(m[1]) },
  ]],
  [/^you or a creature within (\d+) squares takes damage that isn['’]t/i, (m) => ({ event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]) })],
  [/^you or a creature within (\d+) squares takes ([a-z, ]+?) damage/i, (m) => ({ event: "TAKES_DAMAGE", scope: "ANY", range: Number(m[1]), damageTypes: m[2].split(/,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean) })],
  [/^an enemy within (\d+) squares takes ([a-z, ]+?) damage/i, (m) => ({ event: "TAKES_DAMAGE", scope: "ENEMY", range: Number(m[1]), damageTypes: m[2].split(/,\s*(?:or\s+)?|\s+or\s+/).filter(Boolean) })],
  [/^an enemy within (\d+) squares is force moved/i, (m) => ({ event: "FORCE_MOVED", scope: "ENEMY", range: Number(m[1]) })],
  [/^a creature within (\d+) squares regains stamina/i, (m) => ({ event: "REGAINS_STAMINA", scope: "ANY", range: Number(m[1]) })],
  [/^a hero deals damage with \d+ surges/i, { event: "DEALS_DAMAGE", scope: "SELF_OR_ALLY", heroOnly: true, range: "none" }],
  [/^a creature is force moved/i, { event: "FORCE_MOVED", scope: "ANY", range: "none" }],
  [/^you or any ally damages a (?:creature|target)/i, { event: "DEALS_DAMAGE", scope: "SELF_OR_ALLY", range: "none" }],
  [/^a creature judged by you/i, { event: "TAKES_DAMAGE", scope: "SELF", range: "none" }],
  [/^you deal damage/i, { event: "DEALS_DAMAGE", scope: "SELF", range: "none" }],
];

function triggerFrom(condition) {
  let t = condition.replace(/^[A-Z][\w'’ ]{0,30}:\s*/, "").replace(/^additionally,?\s*/i, "").replace(/\s*\([^)]*\)/g, "");
  t = t.replace(/^(?:the )?first time\b\s*/i, "").replace(/^whenever\s+/i, "").replace(/^when\s+/i, "");
  t = t.replace(ONCE_STRIP, "").replace(/^\s*that\s+/i, "").replace(/,\s*$/, "").replace(/\s+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function onceOf(condition) {
  if (ONCE_ROUND.test(condition)) return "round";
  if (/\bfirst time\b/i.test(condition)) return "encounter";
  return null;
}

const BONUS = /^whenever (?:you gain [\w ]+ from a domain effect|the chosen event grants you)\b.*\badditional\b/i;

function kindOf(sentence) {
  if (BONUS.test(sentence)) return "bonus";
  if (/\binstead of\b/i.test(sentence)) return /start of each of your turns|start of your turn/i.test(sentence) ? "system" : "upgrade";
  if (/start of each of your turns|start of your turn|start of a combat encounter/i.test(sentence)) return "system";
  if (/^if the roll is\b/i.test(sentence) || /\bpray\b/i.test(sentence)) return "pray";
  return "trigger";
}

export function featureGainLines(html, { resource, dsid = "" } = {}) {
  if (!html || !resource) return [];
  const res = resource.toLowerCase();
  const { amounts, blocks } = blocksOf(html, res);
  const optional = /\bchoose (?:one|two|three|\d+) of the following\b/i.test(String(html).replace(/<[^>]+>/g, ""));
  const textGain = new RegExp(String.raw`\bgain(?:s)? ${AMOUNT}(?: additional)? ${res}\b`, "i");
  const insteadOf = new RegExp(String.raw`\bgain(?:s)? ${AMOUNT} ${res} instead of ${AMOUNT}`, "i");
  const lines = [];
  const keys = new Set();
  for (const block of blocks) {
    for (const raw of sentencesOf(block)) {
      const marked = raw.match(new RegExp(`${MARK}(\\d+)${MARK}`));
      const sentence = raw.replace(new RegExp(`${MARK}\\d+${MARK}`, "g"), "");
      const byText = sentence.match(textGain);
      if (!marked && !byText) continue;
      let amount = marked ? amounts[Number(marked[1])] : byText[1].replace(/\s+/g, "");
      const kind = kindOf(sentence);
      const line = { sentence, amount, kind, once: null, trigger: "", parse: null, gates: [], manual: [], upgradeOf: null, optional };
      const instead = sentence.match(insteadOf);
      if (instead) { line.amount = instead[1].replace(/\s+/g, ""); line.upgradeOf = instead[2].replace(/\s+/g, ""); }
      if (kind === "trigger" || kind === "upgrade" || kind === "bonus") {
        const at = marked ? raw.indexOf(marked[0]) : sentence.search(textGain);
        let condition = (marked ? raw.slice(0, at) : sentence.slice(0, at)).replace(/,?\s*(?:you\s+)?(?:gains?\s*)?$/i, "").trim();
        if (!condition || /^[\w ]+:$/.test(condition) || /:\s*(?:you)?$/i.test(condition)) {
          const after = sentence.toLowerCase().indexOf(res, at);
          condition = after >= 0 ? sentence.slice(after + res.length).replace(/[.!]\s*$/, "").trim() : "";
        }
        line.once = onceOf(condition);
        line.trigger = triggerFrom(condition);
        line.gates = GATES.filter(([, rx]) => rx.test(sentence)).map(([id]) => id);
        const over = sentence.match(/greater than (\d+) \+ your level in a single turn/i);
        if (over) line.turnDamageBase = Number(over[1]);
        const fall = sentence.match(/falls (\d+) or more squares/i);
        if (fall) line.fallMin = Number(fall[1]);
        line.manual = MANUAL.filter(([rx]) => rx.test(sentence)).map(([, why]) => why);
        if (!/^[A-Za-z]/.test(line.trigger)) { line.kind = "other"; line.trigger = ""; }
        if (kind === "bonus") {
          line.bonusFor = /domain effect/i.test(sentence) ? "domain" : "chosen";
          line.manual = line.bonusFor === "chosen" ? [PICK_EVENT] : [];
        } else if (line.trigger) {
          const parse = parseTrigger(`${line.trigger}.`, { side: "hero" });
          const fix = FIXUPS.find(([rx]) => rx.test(line.trigger) || rx.test(sentence));
          if (fix) {
            const m = line.trigger.match(fix[0]) ?? sentence.match(fix[0]);
            const patch = typeof fix[1] === "function" ? fix[1](m) : fix[1];
            parse.clauses = Array.isArray(patch)
              ? patch.map((p) => ({ qualifiers: [], ...p, events: [p.event] }))
              : [{ ...(parse.clauses[0] ?? {}), qualifiers: parse.clauses[0]?.qualifiers ?? [], ...patch, events: [patch.event] }];
            parse.confidence = "high";
            parse.source = "gain-fixup";
            if (Array.isArray(patch)) line.manual = line.manual.filter((why) => !FIXABLE.has(why));
          }
          const seen = new Set();
          parse.clauses = parse.clauses.filter((c) => {
            const id = `${c.event}|${c.scope}|${c.abilityDsid ?? ""}|${c.targetsAlly ? "ally" : ""}`;
            return seen.has(id) ? false : (seen.add(id), true);
          });
          line.parse = parse;
        }
      }
      let key = generateDSID(`${dsid} ${line.trigger || sentence}`).slice(0, 80);
      for (let n = 2; keys.has(key); n++) key = `${key.replace(/-\d+$/, "")}-${n}`;
      keys.add(key);
      line.key = key;
      lines.push(line);
    }
  }
  return lines;
}

export const GAIN_EVENTS = new Set(["TAKES_DAMAGE", "DEALS_DAMAGE", "WINDED_OR_DYING", "WINDED", "DYING", "DIES", "FORCE_MOVED", "FORCE_MOVES", "USES_ABILITY",
  "NATURAL_19_20", "NATURAL_2", "SPENDS_RECOVERY", "FALL_START", "POWER_ROLL_RESULT", "STAMINA_BELOW", "REGAINS_STAMINA", "CONDITION_GAIN", "GAINS_TEMP_STAMINA", "GAINS_SURGE", "TELEPORTS", "SIZE_CHANGES", "FORM_CHANGES", "MALICE_SPENT"]);

export function lineAutomated(line) {
  if (line.kind === "bonus") return line.bonusFor === "domain" || !!line.bonusTarget;
  if (line.kind !== "trigger" && line.kind !== "upgrade") return false;
  if (line.manual.length) return false;
  const clauses = line.parse?.clauses ?? [];
  if (!clauses.length || line.parse.confidence !== "high") return false;
  if (clauses.length > 1 && line.parse.source !== "gain-fixup") return false;
  return clauses.every((c) => GAIN_EVENTS.has(c.event));
}
