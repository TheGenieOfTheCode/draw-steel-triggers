import { MODULE_ID, getSetting } from "../util.mjs";
import { getParsedTrigger, clearParseCache, isMaliceAbility, isImplicitMaliceTrigger, isTriggeredAbility, triggerEffectText } from "../triggers/registry.mjs";
import { explainAbilityFilters, explainClauseFlags, annotateTrigger } from "../parser/trigger-parser.mjs";
import { heroGainLines, namedGainLines } from "../triggers/resource-gains.mjs";
import { tierText, ignoreFeature } from "../triggers/feature-triggers.mjs";
import { defersDeath } from "../parser/feature-triggers.mjs";
import { derivedInfo } from "../triggers/derived.mjs";
import { isConsumable } from "../triggers/consumables.mjs";
import { IMPACTS, impactById, impactLabel, impactHint, moveImpact, pruneImpacts, removeImpact } from "./editor-impacts.mjs";

const L = (k, data) => data
  ? game.i18n.format(`DS_TRIGGERS.Editor.${k}`, data)
  : game.i18n.localize(`DS_TRIGGERS.Editor.${k}`);

const FLAG_FIELDS = {
  damageTypes: ["damageTypes"],
  edgeRequired: ["edgeRequired"],
  excludeSelfTarget: ["excludeSelfTarget"],
  effectName: ["effectName"],
  zone: ["zone"],
  postRoll: ["postRoll"],
  half: ["halfDamage", "halfOnUse"],
  rollMod: ["rollMod"],
  redirect: ["redirect"],
  targetsOwner: ["targetsOwner"],
  victimNotSelf: ["victimNotSelf"],
  sourceScope: ["sourceScope"],
  rolledDamage: ["rolledDamage"],
  organization: ["organization"],
  tauntedByOwner: ["tauntedByOwner"],
  ownerLacks: ["ownerLacks"],
  ownerEffect: ["ownerEffect"],
  through: ["through", "throughScope"],
  victimNotMentor: ["victimNotMentor"],
  entersSpace: ["entersSpace"],
  lineOfEffect: ["lineOfEffect"],
  fmType: ["fmType"],
  victimEndsAdjacent: ["victimEndsAdjacent"],
  firstTurn: ["firstTurn"],
  damageOutcome: ["damageOutcome"],
  reducedByImmunity: ["reducedByImmunity"],
  rangeMin: ["rangeMin"],
  notForceMoved: ["notForceMoved"],
  ownerGrabbing: ["ownerGrabbing"],
  fromFalling: ["fromFalling"],
  victimCondition: ["victimCondition"],
  fallReduction: ["fallReduction"],
  subjectConcealed: ["subjectConcealed"],
  fromForcedMovement: ["fromForcedMovement"],
  arrives: ["arrives"],
  highGround: ["highGround"],
  damageReduction: ["damageReduction"],
  damageBonus: ["damageBonus"],
  fmMod: ["fmMod"],
  fallSafe: ["fallSafe"],
  flankedByDealer: ["flankedByDealer"],
  rangeOn: ["rangeOn"],
  rangeAbility: ["range"],
  ownerInAbilityRange: ["ownerInAbilityRange"],
  throughMark: ["throughMark"],
  wouldLeave: ["wouldLeave"],
  damageRedirect: ["damageRedirect"],
};

const keywordLabel = (k) => {
  const label = ds.CONFIG?.abilities?.keywords?.[k]?.label;
  return label ? game.i18n.localize(label) : k;
};

const charLabel = (c) => game.i18n.localize(ds.CONFIG?.characteristics?.[c]?.label ?? c);

function fmModText(mod) {
  const n = mod?.amount ?? (mod?.char ? charLabel(mod.char) : "");
  const key = { boost: "FmModBoost", reduce: "FmModReduce", redirect: "FmModRedirect", slide: "FmModSlide", vertical: "FmModVertical", objectDamage: "FmModObject" }[mod?.mode];
  return key ? L(key, { n }) : L("QualEffectNone");
}

function describeFilter(id, fields) {
  switch (id) {
    case "range": return L("QualEffectRange", { n: fields.range });
    case "abilityType": return L("QualEffectType", { type: fields.abilityType });
    case "abilityCostMax": return L("QualEffectCost", { n: fields.abilityCostMax });
    case "abilityCategory": return L({ heroic: "QualEffectHeroic", signature: "QualEffectSignature" }[fields.abilityCategory] ?? "QualEffectNonHeroic");
    case "abilityKeywords": return L("QualEffectKeywords", { keywords: fields.abilityKeywordGroups?.length
      ? fields.abilityKeywordGroups.map((g) => g.map(keywordLabel).join(" or ")).join(", and ")
      : fields.abilityKeywords.map(keywordLabel).join(fields.abilityKeywordsAll ? " and " : " or ") });
    case "abilityCostScales": return L("QualEffectScales");
    case "abilityPotency": return L("QualEffectPotency");
    case "abilityTargetCount": return L("QualEffectTargets", {
      n: fields.abilityTargetCount,
      side: fields.abilityTargetSide ?? L("QualSideCreature"),
    });
    case "abilityDsid": return L("QualEffectDsid", { dsid: fields.abilityDsid });
    case "damageTypes": return L("QualEffectDamageTypes");
    case "edgeRequired": return L("QualEffectEdge");
    case "excludeSelfTarget": return L("QualEffectExcludeSelf");
    case "effectName": return L("QualEffectEffectName");
    case "zone": return L("QualEffectZone");
    case "postRoll": return L("QualEffectPostRoll");
    case "half": return L("QualEffectHalf");
    case "rollMod": return L("QualEffectRollMod");
    case "redirect": return L("QualEffectRedirect");
    case "targetsOwner": return L("QualEffectTargetsOwner");
    case "victimNotSelf": return L("QualEffectVictimNotSelf");
    case "sourceScope": return L("QualEffectSourceScope", { side: String(fields.sourceScope ?? "").toLowerCase() });
    case "rolledDamage": return L("QualEffectRolledDamage");
    case "organization": return L("QualEffectOrganization", { org: (fields.organization?.exclude ?? []).join(", ") });
    case "tauntedByOwner": return L("QualEffectTauntedByOwner");
    case "ownerLacks": return L("QualEffectOwnerLacks", { condition: conditionLabel(fields.ownerLacks).toLowerCase() });
    case "ownerEffect": return L({ victim: "QualEffectOwnerEffectHit", dealer: "QualEffectOwnerEffectDealer" }[fields.ownerEffect?.on] ?? "QualEffectOwnerEffect", { label: fields.ownerEffect?.label ?? "" });
    case "through": return fields.throughScope
      ? L("QualEffectThroughSide", { side: String(fields.throughScope).toLowerCase() })
      : L("QualEffectThrough");
    case "victimNotMentor": return L("QualEffectNotMentor");
    case "entersSpace": return L("QualEffectEntersSpace");
    case "lineOfEffect": return L("QualEffectLineOfEffect");
    case "fmType": return L("QualEffectFmType", { type: [].concat(fields.fmType ?? []).join(" or ") });
    case "victimEndsAdjacent": return L(fields.victimEndsAdjacent === "ally" ? "QualEffectEndsAdjacentAlly" : "QualEffectEndsAdjacentSelf");
    case "firstTurn": return L("QualEffectFirstTurn");
    case "damageOutcome": return L("QualEffectDamageOutcome");
    case "reducedByImmunity": return L("QualEffectImmunity");
    case "rangeMin": return L("QualEffectRangeMin", { n: fields.rangeMin });
    case "notForceMoved": return L("QualEffectNotForceMoved");
    case "ownerGrabbing": return L("QualEffectOwnerGrabbing");
    case "fromFalling": return L("QualEffectFromFalling");
    case "victimCondition": return L("QualEffectVictimCondition", { condition: conditionLabel(fields.victimCondition).toLowerCase() });
    case "fallReduction": return L("QualEffectFallReduction");
    case "subjectConcealed": return L("QualEffectConcealed");
    case "fromForcedMovement": return L("QualEffectFromForcedMovement");
    case "arrives": return L("QualEffectArrives");
    case "highGround": return L("QualEffectHighGround");
    case "damageReduction": return L("QualEffectDamageReduction", { n: fields.damageReduction === "level" ? L("QualYourLevel")
      : typeof fields.damageReduction === "object" ? `${fields.damageReduction.base} + ${charLabel(fields.damageReduction.char)}` : fields.damageReduction });
    case "fallSafe": return L("QualEffectFallSafe");
    case "damageBonus": return L("QualEffectDamageBonus", { n: fields.damageBonus });
    case "fmMod": return fmModText(fields.fmMod);
    case "flankedByDealer": return L("QualEffectFlanked");
    case "rangeOn": return L("QualEffectDealerRange", { n: fields.range?.char ? charLabel(fields.range.char) : fields.range });
    case "rangeAbility": return L("QualEffectAbilityRange", { ability: rangeLineLabel(fields.range) });
    case "ownerInAbilityRange": return L("QualEffectOwnerInRange");
    case "throughMark": return L("QualEffectThroughMark");
    case "wouldLeave": return L("QualEffectWouldDying");
    case "damageRedirect": return L("QualEffectDamageRedirect");
    default: return L("QualEffectNone");
  }
}

const abilityFilterList = (event, triggerText, effectText) => event === "USES_ABILITY" ? explainAbilityFilters(triggerText, effectText)
  : ["DEALS_DAMAGE", "TAKES_DAMAGE", "RESISTS_POTENCY", "FORCE_MOVES"].includes(event) ? explainAbilityFilters(triggerText, effectText).filter((f) => f.id === "abilityKeywords") : [];

function qualifierPills(clause, triggerText, effectText, pristine = null) {
  const off = new Set(clause.filtersOff ?? []);
  const flagView = { ...clause };
  for (const id of off) for (const field of FLAG_FIELDS[id] ?? []) if (pristine?.[field] !== undefined) flagView[field] = pristine[field];
  const pills = [];
  const consumed = [];

  const distance = (clause.qualifiers ?? []).find((q) => /within \d+|\badjacent\b/i.test(q));
  if (distance || Number.isFinite(clause.range)) {
    const n = Number.isFinite(clause.range) ? clause.range : 1;
    pills.push({
      id: "range", text: distance ?? L("QualRangeImplied", { n }),
      tooltip: describeFilter("range", { range: n }),
      enforced: true, disabled: off.has("range"),
    });
    if (distance) consumed.push(distance);
  }

  for (const f of abilityFilterList(clause.event, triggerText, effectText)) {
    pills.push({
      id: f.id, text: f.fragment,
      tooltip: describeFilter(f.id, f.id === "abilityKeywords" && typeof clause.abilityKeywordsAll === "boolean" ? { ...f.fields, abilityKeywordsAll: clause.abilityKeywordsAll } : f.fields)
        + (f.from === "effect" ? ` ${L("QualFromEffect")}` : ""),
      enforced: true, disabled: off.has(f.id), fromEffect: f.from === "effect",
    });
    consumed.push(f.fragment);
  }

  for (const f of explainClauseFlags(flagView, triggerText, effectText)) {
    pills.push({
      id: f.id, text: f.fragment,
      tooltip: describeFilter(f.id, flagView) + (f.from === "effect" ? ` ${L("QualFromEffect")}` : ""),
      enforced: true, disabled: off.has(f.id), fromEffect: f.from === "effect",
    });
    consumed.push(f.fragment);
  }

  
  let rest = (clause.qualifiers ?? []).filter((q) => !consumed.includes(q)).join(", ");
  for (const c of consumed) rest = rest.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  rest = rest.replace(/\s*(?:^|,)\s*(?:that|and|or|the)\b\s*/gi, " ").replace(/[\s,]+/g, " ").trim();
  if (/^(?:(?:with|using|by|from|to|of|against|a|an|the|that|and|or)\b\s*)+$/i.test(rest)) rest = "";
  if (rest) pills.push({ id: "", text: rest, tooltip: L("QualEffectNone"), enforced: false, disabled: false });

  return pills;
}

const EVENT_GROUPS = [
  ["Common", [
    "TAKES_DAMAGE", "DEALS_DAMAGE", "DIES", "WINDED", "DYING",
    "TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY", "MAKES_STRIKE", "POWER_ROLL", "MOVES", "FORCE_MOVED",
    "TURN_START", "TURN_END", "CONDITION_GAIN", "USES_ABILITY",
  ]],
  ["Rare", [
    "FORCE_MOVES", "ROUND_START", "POWER_ROLL_RESULT", "ZONE_ENTER", "ZONE_TURN_START",
    "EFFECT_ENDS", "SAVING_THROW", "REGAINS_STAMINA", "LOSES_STAMINA", "MARKED",
    "WINDED_OR_DYING", "FALL_START", "SPENDS_RECOVERY", "HERO_TOKEN_EARNED", "RESISTS_POTENCY",
  ]],
  ["Bespoke", [
    "RESOURCE_GAIN", "STAMINA_BELOW", "MECHANISM", "NARRATIVE",
    "GRAB_ENDS", "TEST_FAILED", "UNKNOWN",
  ]],
];
const SCOPES = [
  "SELF", "TARGET", "ALLY", "ENEMY", "ANY", "COMPANION", "MENTOR",
  "GROUP", "SELF_OR_ALLY", "OBJECT", "GRABBED_CREATURE", "UNKNOWN",
];

const DAMAGE_EVENTS = new Set(["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "DEALS_DAMAGE"]);

const CONDITIONS = ["bleeding", "dazed", "frightened", "grabbed", "prone", "restrained", "slowed", "taunted", "weakened"];
const conditionLabel = (id) => {
  const status = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects.find((s) => s.id === id) : CONFIG.statusEffects?.[id];
  return status?.name ? game.i18n.localize(status.name) : label(id);
};

const TARGETING_EVENTS = new Set(["TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY"]);

const CHARACTERISTIC_LABEL = (key) => game.i18n.localize(ds.CONFIG?.characteristics?.[key]?.label ?? key);

function rangeLineLabel(range) {
  if (range.char) return L("RangeChar", { char: CHARACTERISTIC_LABEL(range.char) });
  if (range.ability) return L("RangeAbility", { ability: range.ability.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) });
  return L("RangeAuto");
}

function rangeColumn(range) {
  if (range === "none") return L("RangeNone");
  if (Number.isFinite(range)) return L("RangeWithin", { n: range });
  if (range && typeof range === "object") return range.char ? CHARACTERISTIC_LABEL(range.char) : rangeLineLabel(range);
  return L("RangeAuto");
}

const label = (v) => v.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const shownEvent = (event) => event === "WOULD_TAKE_DAMAGE" ? "TAKES_DAMAGE" : event;

function shownEffect(item) {
  const box = document.createElement("div");
  box.innerHTML = [...(item.system.effects ?? [])].map((e) => e.description ?? "").join(" ");
  for (const secret of box.querySelectorAll("section.secret")) secret.remove();
  for (const block of box.querySelectorAll("p, li, div")) block.append(" ");
  return box.textContent.replace(/\s+/g, " ").trim();
}

const blankClause = () => ({ event: "UNKNOWN", scope: "SELF", qualifiers: [], _customs: [] });

function fieldAttrs(impact, index, field) {
  const attrs = [`data-impact-field="${field.name}"`, `data-impact="${impact.id}"`, `data-index="${index}"`];
  if (field.rerender) attrs.push("data-rerender");
  if (field.type === "number") attrs.push(`step="1" min="${field.min ?? 0}"`);
  return attrs.join(" ");
}

export class TriggerEditor extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-trigger-editor",
    classes: ["draw-steel", "dst-trigger-editor"],
    window: { minimizable: true, resizable: true },
    position: { width: 600, height: 640 },
    form: { handler: null, closeOnSubmit: false, submitOnChange: false },
    actions: {
      addClause: TriggerEditor.#onAddClause,
      clauseMenu: TriggerEditor.#onClauseMenu,
      addImpact: TriggerEditor.#onAddImpact,
      impactMenu: TriggerEditor.#onImpactMenu,
      toggleRow: TriggerEditor.#onToggleRow,
      saveOverride: TriggerEditor.#onSaveOverride,
      resetParser: TriggerEditor.#onResetParser,
      ignoreFeature: TriggerEditor.#onIgnoreFeature,
    },
  };

  static TABS = {
    primary: {
      tabs: [{ id: "trigger" }, { id: "impact" }, { id: "config" }],
      initial: "trigger",
      labelPrefix: "DS_TRIGGERS.Editor.Tabs",
    },
  };

  static PARTS = {
    header: { template: `modules/${MODULE_ID}/templates/trigger-editor/header.hbs` },
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    trigger: { template: `modules/${MODULE_ID}/templates/trigger-editor/trigger.hbs`, scrollable: [""] },
    impact: { template: `modules/${MODULE_ID}/templates/trigger-editor/impact.hbs`, scrollable: [""] },
    config: { template: `modules/${MODULE_ID}/templates/trigger-editor/config.hbs`, scrollable: [""] },
    footer: { template: `modules/${MODULE_ID}/templates/trigger-editor/footer.hbs` },
  };

  constructor(item, { line = null, ...options } = {}) {
    super(line ? { ...options, id: "dst-trigger-editor-line", position: { width: 600, height: Math.min(800, window.innerHeight - 40) } } : options);
    this.item = item;
    this._line = line;
    this._lineType = line ? (line.lineType ?? "gain") : null;
    this._triggerText = line ? (line.trigger ? `${line.trigger}.` : "") : (item.system.trigger ?? "");
    this._effectText = line ? (line.effect ?? "") : triggerEffectText(item);
    const parse = line ? line.parse : getParsedTrigger(item);
    this._clauses = (parse?.clauses ?? [blankClause()])
      .map((c) => foundry.utils.deepClone(c));
    const keywordIds = new Set(Object.keys(ds.CONFIG.monsters?.keywords ?? {}));
    for (const clause of this._clauses) {
      clause._customs = clause.groupName && !keywordIds.has(clause.groupName) ? [clause.groupName] : [];
    }
    this._pristine = foundry.utils.deepClone(this._clauses);
    this._expanded = new Set();
    this._malice = item.getFlag(MODULE_ID, "malice");
    this._useImpacts = foundry.utils.deepClone(item.getFlag(MODULE_ID, "useImpacts") ?? {});
    this._source = parse?.source ?? "none";
    this._confidence = parse?.confidence ?? "";
  }

  get title() {
    return game.i18n.format("DS_TRIGGERS.Editor.Title", { name: this._line ? this._shownName() : this.item.name });
  }

  _headerContext() {
    const F = (k) => game.i18n.localize(`DS_TRIGGERS.${k}`);
    if (this._line) {
      return {
        img: this.item.img, name: this._shownName(), owner: this.item.name,
        kind: F(this._lineType === "feature" ? "Feature.Legend" : "Gain.Legend"),
      };
    }
    const type = ds.CONFIG.abilities?.types?.[this.item.system?.type]?.label;
    const malice = isMaliceAbility(this.item) || isImplicitMaliceTrigger(this.item);
    return {
      img: this.item.img, name: this.item.name, owner: this.item.actor?.name ?? "",
      kind: malice ? L("KindMalice") : type ? game.i18n.localize(type) : L("KindTrigger"),
    };
  }

  _clauseContext(c, index, keywords, damageTypes) {
    const qualifiers = qualifierPills(c, this._triggerText, this._effectText, this._pristine?.[index]);
    const summary = qualifiers.filter((q) => !q.disabled).map((q) => q.text);
    if (c.postRoll) summary.unshift(L("TimingAfterShort"));
    return {
      index,
      colour: index % 4,
      legend: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: index + 1 }),
      summary: summary.join(", ") || L("QualifiersShortNone"),
      expanded: this._expanded.has(`clause-${index}`),
      eventLabel: label(shownEvent(c.event)),
      scopeLabel: label(c.scope ?? "UNKNOWN"),
      rangeLabel: rangeColumn(c.range),
      eventGroups: EVENT_GROUPS.map(([key, list]) => ({
        label: L(`EventGroup${key}`),
        options: list.map((e) => ({ value: e, label: label(e), selected: e === shownEvent(c.event) })),
      })),
      eventHint: game.i18n.localize(`DS_TRIGGERS.Editor.EventDesc.${shownEvent(c.event)}`),
      scopeOptions: SCOPES.map((s) => ({ value: s, label: label(s), selected: s === c.scope })),
      rangeOptions: [
        ...(c.range && typeof c.range === "object" ? [["line", rangeLineLabel(c.range)]] : []),
        ["auto", L("RangeAuto")], ["none", L("RangeNone")], ["custom", L("RangeCustom")],
      ].map(([value, optLabel]) => ({
        value, label: optLabel,
        selected: (c.range === "none" ? "none" : Number.isFinite(c.range) ? "custom"
          : c.range && typeof c.range === "object" ? "line" : "auto") === value,
      })),
      rangeCustom: Number.isFinite(c.range),
      rangeValue: Number.isFinite(c.range) ? c.range : 1,
      qualifiers,
      showKeywordMode: (c.abilityKeywords?.length ?? 0) > 1 && !c.abilityKeywordGroups?.length,
      keywordAll: !!c.abilityKeywordsAll,
      keywordHint: L("KeywordModeHint", { keywords: (c.abilityKeywords ?? []).map(keywordLabel).join(", ") }),
      showDamageTypes: DAMAGE_EVENTS.has(c.event),
      showCondition: c.event === "CONDITION_GAIN",
      conditionOptions: [...new Set([...CONDITIONS, ...[].concat(c.condition ?? [])])]
        .map((value) => ({ value, label: conditionLabel(value), selected: [].concat(c.condition ?? []).includes(value) })),
      showTiming: TARGETING_EVENTS.has(c.event) || !!c.postRoll,
      timingOptions: [["before", L("TimingBefore")], ["after", L("TimingAfter")]]
        .map(([value, optLabel]) => ({ value, label: optLabel, selected: (c.postRoll ? "after" : "before") === value })),
      targeting: TARGETING_EVENTS.has(c.event),
      excludeSelfTarget: !!c.excludeSelfTarget,
      showGroup: c.scope === "GROUP",
      damageTypeOptions: damageTypes.map((d) => ({ ...d, active: (c.damageTypes ?? []).includes(d.value) })),
      groupOptions: keywords.map((k) => ({ ...k, active: c.groupName === k.value })),
      customOptions: (c._customs ?? []).filter(Boolean).map((value) => ({ value, active: c.groupName === value })),
      customPending: !!c._customPending,
      abilityDsid: c.abilityDsid ?? "",
      edgeRequired: !!c.edgeRequired,
      ownerUnacted: !!c.ownerUnacted,
      anyHeroUnacted: !!c.anyHeroUnacted,
    };
  }

  _impactRows() {
    const rows = [];
    const many = this._clauses.length > 1;
    this._clauses.forEach((c, index) => {
      for (const impact of IMPACTS) {
        if (!impact.has(c)) continue;
        const row = `${impact.id}-${index}`;
        const fields = (impact.fields?.(c) ?? []).map((f) => ({ ...f, attrs: fieldAttrs(impact, index, f) }));
        const homes = impact.keys.length && many
          ? this._clauses.map((other, i) => ({ other, i })).filter(({ other, i }) => i === index || (impact.supports(other) && !impact.has(other)))
          : [];
        const clauseOptions = homes.length > 1 ? homes.map(({ i }) => ({
          value: i, label: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: i + 1 }), selected: i === index,
        })) : null;
        rows.push({
          id: impact.id, index, row, icon: impact.icon,
          label: impactLabel(impact),
          summary: impact.summary(c),
          hint: impactHint(impact),
          unsupported: impact.supports(c) ? "" : L("Impact.Unsupported", { n: index + 1 }),
          colour: index % 4,
          clauseLabel: many ? game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: index + 1 }) : "",
          fields, clauseOptions,
          hasBody: true,
          expanded: this._expanded.has(row),
        });
      }
    });
    return [...this._wholeImpactRows(), ...rows];
  }

  _wholeImpactRows() {
    const row = (id, icon, summary, { fields = [], removable = false } = {}) => ({
      id, row: `whole-${id}`, icon, whole: true, fixed: !removable, label: L(`Impact.${id}.Label`), summary,
      hint: L(`Impact.${id}.Hint`), fields, hasBody: true, expanded: this._expanded.has(`whole-${id}`),
    });
    const line = this._line;
    const rows = [];
    if (this._lineType === "gain") {
      const folded = this.item.actor ? heroGainLines(this.item.actor).find((e) => e.line.key === line.key)?.line : null;
      const summary = folded?.upgradedBy
        ? game.i18n.format("DS_TRIGGERS.Gain.Upgraded", { amount: folded.amount, name: folded.upgradedBy })
        : L("Impact.gain.Summary", { n: line.amount });
      return [row("gain", "fa-solid fa-bolt", summary, { fields: [{ name: "amount", label: game.i18n.localize("DS_TRIGGERS.Gain.Amount"), type: "text", value: line.amount, attrs: 'data-gain-field="amount"' }] })];
    }
    const actor = this.item.actor;
    const derived = line ? null : derivedInfo(this.item);
    const effect = String((line ?? derived) ? (line?.effect ?? "") : "").trim();
    const fromText = line ? /^spend a recovery\.?$/i.test(effect) : !!derived?.spendsRecovery;
    if (fromText) rows.push(row("recovery", "fa-solid fa-heart-pulse", L("Impact.recovery.Summary")));
    else if (this._useImpacts?.spendsRecovery) rows.push(row("recovery", "fa-solid fa-heart-pulse", L("Impact.recovery.Added"), { removable: true }));
    if (line?.cost?.amount) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: line.cost.amount, resource: line.cost.resource ?? "" })));
    else if (derived?.epicCost) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: derived.epicCost, resource: actor?.system?.hero?.epic?.label ?? "" })));
    else if (!line && Number(this.item.system?.resource) > 0) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: this.item.system.resource, resource: actor?.system?.coreResource?.name ?? "" })));
    const source = line ? this.item : derived ? actor?.items.get(derived.sourceId) : null;
    if (isConsumable(source)) rows.push(row("consumable", "fa-solid fa-flask", L(getSetting("autoSpendConsumables") ? "Impact.consumable.Auto" : "Impact.consumable.Manual")));
    if (line && defersDeath(line.effect)) rows.push(row("defersDeath", "fa-solid fa-skull", L("Impact.defersDeath.Summary")));
    return rows;
  }

  _addableWhole() {
    if (this._line) return [];
    const derived = derivedInfo(this.item);
    return derived?.spendsRecovery || this._useImpacts.spendsRecovery ? [] : ["recovery"];
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const keywords = Object.entries(ds.CONFIG.monsters?.keywords ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const damageTypes = Object.entries(ds.CONFIG.damageTypes ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }));
    const side = this.item.actor && this.item.actor.type !== "hero" ? "monster" : "hero";
    const annotated = annotateTrigger(this._triggerText, this._line ? { effectText: this._effectText, side } : {
      side,
      dsid: this.item.system?._dsid ?? this.item.dsid,
      ownerName: this.item.actor?.name ?? "",
      effectText: this._effectText,
      targetType: this.item.system?.target?.type,
    });
    const triggerPills = annotated.segments.map((s) => {
      const clauses = s.clauses ?? (s.clause == null ? [] : [s.clause]);
      const shared = clauses.length > 1;
      return {
        ...s,
        isPill: s.kind !== "plain",
        indexes: clauses.join(","),
        colour: shared ? "dst-tt-shared" : (s.clause == null ? "" : `dst-tt-c${s.clause % 4}`),
        style: shared ? `--dst-tt-a: var(--dst-tt-c${clauses[0] % 4}); --dst-tt-stops: ${clauses.map((c) => `var(--dst-tt-c${c % 4})`).join(", ")}; --dst-tt-fills: ${clauses.map((c) => `color-mix(in srgb, var(--dst-tt-c${c % 4}) 16%, var(--dst-tt-base))`).join(", ")};` : "",
        tooltip: s.kind === "plain" ? "" : game.i18n.format(`DS_TRIGGERS.Editor.TriggerPill.${s.kind}`, { n: clauses.map((c) => c + 1).join(" & ") }),
      };
    });
    const effect = this._line ? (this._lineType === "feature" ? this._line.effect : "") : shownEffect(this.item);
    return {
      ...context,
      header: this._headerContext(),
      triggerText: this._triggerText,
      triggerPills,
      effectText: effect ? effect[0].toUpperCase() + effect.slice(1) : "",
      gain: this._lineType === "gain" ? this._gainContext() : null,
      feature: this._lineType === "feature" ? this._featureContext() : null,
      isLine: !!this._line,
      noTriggerText: this._line?.sentence || L("NoTriggerText"),
      statusLine: game.i18n.format("DS_TRIGGERS.Editor.Status", { source: this._source, confidence: this._confidence || "n/a" }),
      isManual: this._line ? !!this.item.getFlag(MODULE_ID, `${this._lineFlag()}.${this._line.key}`) : !!this.item.getFlag(MODULE_ID, "manual"),
      labels: {
        clauses: L("Clauses"), event: L("Event"), scope: L("Scope"), range: L("Range"), timing: L("Timing"),
        qualifiers: L("Qualifiers"), qualifiersNone: L("QualifiersNone"),
        keywordMode: L("KeywordMode"), keywordAny: L("KeywordAny"), keywordAll: L("KeywordAll"),
        damageTypes: L("DamageTypes"), condition: L("Condition"),
        abilityDsid: L("AbilityDsid"), groupName: L("GroupName"), groupNone: L("GroupNone"),
        customPh: L("CustomPh"), customEllipsis: L("CustomEllipsis"),
        edgeRequired: L("EdgeRequired"), ownerUnacted: L("OwnerUnacted"), anyHeroUnacted: L("AnyHeroUnacted"),
        availability: L("Availability"), excludeSelfTarget: L("ExcludeSelfTarget"),
        addClause: L("AddClause"), options: L("RowOptions"), expand: L("RowExpand"),
        impacts: L("Impacts"), clause: L("Clause"), wholeTrigger: L("WholeTrigger"), effect: L("EffectText"),
        addImpact: L("AddImpact"), noImpacts: L("NoImpacts"), noImpactsPossible: L("NoImpactsPossible"),
        malice: L("Malice"), save: L("Save"), reset: L("Reset"),
      },
      hints: {
        scope: L("ScopeHint"), range: L("RangeHint"), qualifiers: L("QualifiersHint"), timing: L("TimingHint"),
        damageTypes: L("DamageTypesHint"), condition: L("ConditionHint"), abilityDsid: L("AbilityDsidHint"),
        groupName: L("GroupNameHint"), checks: L("ChecksHint"), malice: L("MaliceHint"),
        excludeSelfTarget: L("ExcludeSelfTargetHint"),
        save: L("SaveHint"), reset: L("ResetHint"),
      },
      clauses: this._clauses.map((c, index) => this._clauseContext(c, index, keywords, damageTypes)),
      impacts: this._impactRows(),
      canAddImpact: this._addableImpacts().length > 0 || this._addableWhole().length > 0,
      maliceOptions: [
        { value: "default", label: L("MaliceDefault"), selected: this._malice === undefined },
        { value: "true", label: L("MaliceAlways"), selected: this._malice === true },
        { value: "false", label: L("MaliceNever"), selected: this._malice === false },
      ],
    };
  }

  async _preparePartContext(partId, context, options) {
    const part = await super._preparePartContext(partId, context, options);
    if (partId in (context.tabs ?? {})) part.tab = context.tabs[partId];
    return part;
  }

  _addableImpacts() {
    return IMPACTS.map((impact) => ({ impact, index: this._clauses.findIndex((c) => impact.supports(c) && !impact.has(c)) }))
      .filter(({ index }) => index >= 0);
  }

  _openMenu(event, target, entries) {
    const Menu = foundry.applications.ux.ContextMenu.implementation;
    const menu = new Menu(document.createElement("div"), "*", entries, { jQuery: false, fixed: true });
    setTimeout(() => {
      ui.context = menu;
      menu.render(target, { event });
    }, 0);
  }

  _setExpanded(row, open) {
    if (open) this._expanded.add(row);
    else this._expanded.delete(row);
    for (const toggle of this.element.querySelectorAll(`[data-action="toggleRow"][data-row="${row}"]`)) {
      const li = toggle.closest(".expandable-document");
      li?.querySelector(".document-description")?.classList.toggle("expanded", open);
      const icon = li?.querySelector("a.fa-solid[data-action=\"toggleRow\"]");
      icon?.classList.toggle("fa-angle-down", open);
      icon?.classList.toggle("fa-angle-right", !open);
    }
  }

  _flashControl(index, field, text, { scroll = true } = {}) {
    const clauseEl = this.element.querySelector(`.dst-editor-clause[data-index="${index}"]`);
    if (!clauseEl) return;
    let target = null;
    if (field === "qualifiers") {
      const wanted = text.toLowerCase();
      target = [...clauseEl.querySelectorAll(".dst-qual-pill")].find((p) => p.textContent.trim().toLowerCase() === wanted)
        ?? clauseEl.querySelector(".dst-qual-pills");
    } else {
      target = clauseEl.querySelector(`select[data-field="${field}"]`);
    }
    target ??= clauseEl;
    if (scroll) target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.style.setProperty("--dst-flash-colour", `var(--dst-tt-c${index % 4})`);
    void target.offsetWidth;
    target.classList.add("dst-flash");
    setTimeout(() => target.classList.remove("dst-flash"), 1800);
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const titleEl = this.element.querySelector(".window-header .window-title");
    if (titleEl) titleEl.innerHTML = `<img class="dst-window-emblem" src="modules/${MODULE_ID}/icons/emblem-coin.png" alt="">${this.title}`;
    this._listenerAbort?.abort();
    this._listenerAbort = new AbortController();
    const { signal } = this._listenerAbort;
    const el = this.element;

    el.addEventListener("click", (event) => {
      const ttPill = event.target.closest(".dst-tt-pill");
      if (ttPill) {
        event.preventDefault();
        for (const old of el.querySelectorAll(".dst-flash")) old.classList.remove("dst-flash");
        const indexes = String(ttPill.dataset.indexes ?? ttPill.dataset.index).split(",").map(Number);
        if (this.tabGroups.primary !== "trigger") this.changeTab("trigger", "primary");
        const opening = indexes.filter((i) => !this._expanded.has(`clause-${i}`));
        for (const i of indexes) this._setExpanded(`clause-${i}`, true);
        setTimeout(() => indexes.forEach((index, i) => this._flashControl(index, ttPill.dataset.field, ttPill.textContent.trim(), { scroll: i === 0 })), opening.length ? 200 : 0);
        return;
      }
      const pill = event.target.closest("[data-qual-toggle]");
      if (!pill) return;
      event.preventDefault();
      this._syncFromDOM();
      const clause = this._clauses[Number(pill.dataset.index)];
      const id = pill.dataset.qualToggle;
      if (!clause || !id) return;
      const off = new Set(clause.filtersOff ?? []);
      if (off.has(id)) off.delete(id);
      else off.add(id);
      if (off.size) clause.filtersOff = [...off];
      else delete clause.filtersOff;
      this._applyFilters(clause);
      this.render();
    }, { signal });

    el.addEventListener("change", (event) => {
      const target = event.target;
      if (target.matches?.('select[data-field="groupSelect"]') && target.value === "__custom__") {
        this._syncFromDOM();
        this._clauses[Number(target.dataset.index)]._customPending = true;
        this.render();
        return;
      }
      const custom = target.closest?.(".dst-custom-input");
      if (custom) {
        const value = custom.value.trim();
        this._syncFromDOM();
        const clause = this._clauses[Number(custom.dataset.index)];
        clause._customPending = false;
        if (value) {
          if (!clause._customs.includes(value)) clause._customs.push(value);
          clause.groupName = value;
        }
        this.render();
        return;
      }
      if (target.localName === "select" && target.dataset.field !== "malice" && !target.closest("[data-gain-field], [data-feature-field]")) {
        this._syncFromDOM();
        this.render();
      } else if (target.matches?.("[data-rerender]")) {
        this._syncFromDOM();
        this.render();
      }
    }, { signal });

    for (const input of el.querySelectorAll(".dst-custom-input")) {
      if (!input.value) { input.focus(); break; }
    }
  }

  close(options) {
    this._listenerAbort?.abort();
    return super.close(options);
  }

  _applyFilters(clause) {
    const off = new Set(clause.filtersOff ?? []);
    for (const k of ["abilityDsid", "abilityType", "abilityKeywords", "abilityCostMax", "abilityCategory",
      "abilityCostScales", "abilityTargetCount", "abilityTargetSide", "abilityPotency", "abilityKeywordGroups"]) delete clause[k];

    const keywordAll = clause.abilityKeywordsAll;
    for (const f of abilityFilterList(clause.event, this._triggerText, this._effectText)) {
      if (!off.has(f.id)) Object.assign(clause, f.fields);
    }
    if (typeof keywordAll === "boolean") clause.abilityKeywordsAll = keywordAll;

    const index = this._clauses.indexOf(clause);
    const pristine = this._pristine?.[index] ?? {};
    for (const [id, fields] of Object.entries(FLAG_FIELDS)) {
      for (const field of fields) {
        if (off.has(id)) delete clause[field];
        else if (pristine[field] !== undefined) clause[field] = foundry.utils.deepClone(pristine[field]);
      }
    }

    const distance = (clause.qualifiers ?? [])
      .map((q) => q.match(/within (\d+)/i)?.[1] ?? (/\badjacent\b/i.test(q) ? "1" : null))
      .find(Boolean);
    if (off.has("range")) clause.range = "none";
    else if (distance) clause.range = Number(distance);
  }

  _syncFromDOM() {
    const el = this.element;
    const clauseAt = (node) => this._clauses[Number(node.dataset.index)];
    for (const input of el.querySelectorAll("input[data-field][data-index], select[data-field][data-index]")) {
      if (input.localName === "multi-select" || ["groupSelect", "rangeSelect", "rangeValue", "timing"].includes(input.dataset.field)) continue;
      const clause = clauseAt(input);
      if (!clause) continue;
      const field = input.dataset.field;
      if (input.type === "checkbox") {
        if (input.checked) clause[field] = true;
        else delete clause[field];
      } else if (field === "event") {
        if (!(input.value === "TAKES_DAMAGE" && clause.event === "WOULD_TAKE_DAMAGE")) clause.event = input.value;
      } else if (field === "scope") {
        clause.scope = input.value;
      } else if (input.value.trim()) clause[field] = input.value.trim();
      else delete clause[field];
    }
    for (const radio of el.querySelectorAll("input[data-kw-mode]:checked")) {
      const clause = clauseAt(radio);
      if (clause) clause.abilityKeywordsAll = radio.value === "all";
    }
    for (const ms of el.querySelectorAll('multi-select[data-field="condition"]')) {
      const clause = clauseAt(ms);
      if (!clause) continue;
      const value = Array.from(ms.value ?? []);
      if (value.length) clause.condition = value.length > 1 ? value : value[0];
      else delete clause.condition;
    }
    for (const ms of el.querySelectorAll('multi-select[data-field="damageTypes"]')) {
      const clause = clauseAt(ms);
      if (!clause) continue;
      const value = Array.from(ms.value ?? []);
      if (value.length) clause.damageTypes = value;
      else delete clause.damageTypes;
    }
    for (const select of el.querySelectorAll('select[data-field="timing"]')) {
      const clause = clauseAt(select);
      if (!clause) continue;
      if (select.value === "after") clause.postRoll = true;
      else delete clause.postRoll;
    }
    for (const select of el.querySelectorAll('select[data-field="rangeSelect"]')) {
      const clause = clauseAt(select);
      if (!clause || select.value === "line") continue;
      if (select.value === "none") clause.range = "none";
      else if (select.value === "custom") {
        const input = select.closest(".form-fields")?.querySelector('input[data-field="rangeValue"]');
        clause.range = input ? Math.max(1, Math.floor(Number(input.value) || 1)) : (Number.isFinite(clause.range) ? clause.range : 1);
      } else delete clause.range;
    }
    for (const select of el.querySelectorAll('select[data-field="groupSelect"]')) {
      const clause = clauseAt(select);
      if (!clause || select.value === "__custom__") continue;
      if (select.value) clause.groupName = select.value;
      else delete clause.groupName;
    }
    for (const li of el.querySelectorAll(".dst-editor-impact[data-impact]")) {
      const impact = impactById(li.dataset.impact);
      const clause = clauseAt(li);
      if (!impact?.read || !clause || !impact.has(clause)) continue;
      const values = {};
      for (const input of li.querySelectorAll("[data-impact-field]")) {
        values[input.dataset.impactField] = input.type === "checkbox" ? input.checked : input.value;
      }
      impact.read(clause, values);
    }
    for (const select of el.querySelectorAll("select[data-impact-move]")) {
      const impact = impactById(select.dataset.impactMove);
      const from = clauseAt(select);
      const to = this._clauses[Number(select.value)];
      if (!impact || !from || !to || from === to || !impact.has(from)) continue;
      moveImpact(impact, from, to);
      const row = `${impact.id}-${select.dataset.index}`;
      if (this._expanded.delete(row)) this._expanded.add(`${impact.id}-${select.value}`);
    }
    if (this._lineType === "feature") {
      const field = (name) => el.querySelector(`[data-feature-field="${name}"]`);
      if (field("name")) this._line.customName = field("name").value.trim() || null;
      if (field("enabled")) this._line.enabled = field("enabled").checked;
      if (field("action")) this._line.action = field("action").value || null;
      if (field("once")) this._line.once = field("once").value || null;
    } else if (this._line) {
      const enabled = el.querySelector('input[data-gain-field="enabled"]');
      const amount = el.querySelector('input[data-gain-field="amount"]');
      const once = el.querySelector('select[data-gain-field="once"]');
      const name = el.querySelector('input[data-gain-field="name"]');
      if (name) this._line.customName = name.value.trim() || null;
      if (enabled) this._line.enabled = enabled.checked;
      if (amount?.value.trim()) this._line.amount = amount.value.trim().replace(/\s+/g, "");
      if (once) this._line.once = once.value || null;
    }
    const maliceSel = el.querySelector('select[data-field="malice"]');
    if (maliceSel) this._malice = maliceSel.value === "default" ? undefined : maliceSel.value === "true";
  }

  _exportClauses() {
    return this._clauses.map((c) => {
      const out = foundry.utils.deepClone(c);
      delete out._customs;
      delete out._customPending;
      if (!TARGETING_EVENTS.has(out.event)) delete out.excludeSelfTarget;
      pruneImpacts(out);
      if (out.event !== "DEALS_DAMAGE") delete out.victimScope;
      if (out.event !== "TAKES_DAMAGE" && out.event !== "WOULD_TAKE_DAMAGE" && !TARGETING_EVENTS.has(out.event)) delete out.dealerScope;
      return out;
    });
  }

  _forgetRows() {
    this._expanded = new Set([...this._expanded].filter((row) => row.startsWith("line-")));
  }

  static #onAddClause() {
    this._syncFromDOM();
    this._clauses.push(blankClause());
    this._pristine.push(blankClause());
    this._expanded.add(`clause-${this._clauses.length - 1}`);
    this.render();
  }

  static #onClauseMenu(event, target) {
    const index = Number(target.dataset.index);
    this._openMenu(event, target, [
      { label: L("DuplicateClause"), icon: "fa-solid fa-copy", onClick: () => {
        this._syncFromDOM();
        this._clauses.splice(index + 1, 0, foundry.utils.deepClone(this._clauses[index]));
        this._pristine.splice(index + 1, 0, foundry.utils.deepClone(this._pristine[index] ?? {}));
        this._forgetRows();
        this._expanded.add(`clause-${index + 1}`);
        this.render();
      } },
      { label: L("RemoveClause"), icon: "fa-solid fa-trash", onClick: () => {
        this._syncFromDOM();
        this._clauses.splice(index, 1);
        this._pristine.splice(index, 1);
        if (!this._clauses.length) {
          this._clauses.push(blankClause());
          this._pristine.push(blankClause());
        }
        this._forgetRows();
        this.render();
      } },
    ]);
  }

  static #onAddImpact(event, target) {
    this._syncFromDOM();
    const whole = this._addableWhole().map((id) => ({
      label: L(`Impact.${id}.Label`), icon: "fa-solid fa-heart-pulse",
      onClick: () => {
        this._useImpacts.spendsRecovery = true;
        this.render();
      },
    }));
    this._openMenu(event, target, [...whole, ...this._addableImpacts().map(({ impact, index }) => ({
      label: impactLabel(impact), icon: impact.icon,
      onClick: () => {
        impact.add(this._clauses[index]);
        if (impact.fields) this._expanded.add(`${impact.id}-${index}`);
        this.render();
      },
    }))]);
  }

  static #onImpactMenu(event, target) {
    if (target.dataset.whole) {
      return this._openMenu(event, target, [{
        label: L("RemoveImpact"), icon: "fa-solid fa-trash",
        onClick: () => {
          this._syncFromDOM();
          delete this._useImpacts.spendsRecovery;
          this.render();
        },
      }]);
    }
    const impact = impactById(target.dataset.impact);
    const index = Number(target.dataset.index);
    if (!impact) return;
    this._openMenu(event, target, [{
      label: L("RemoveImpact"), icon: "fa-solid fa-trash",
      onClick: () => {
        this._syncFromDOM();
        removeImpact(impact, this._clauses[index]);
        this._expanded.delete(`${impact.id}-${index}`);
        this.render();
      },
    }]);
  }

  static #onToggleRow(event, target) {
    if (event.target.closest("a[data-action=\"clauseMenu\"], a[data-action=\"impactMenu\"]")) return;
    const row = target.dataset.row;
    this._setExpanded(row, !this._expanded.has(row));
  }

  _lineFlag() {
    return this._lineType === "feature" ? "featureLines" : "gainLines";
  }

  _featureContext() {
    const line = this._line;
    const F = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.Feature.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Feature.${k}`));
    line.customName ??= this.item.getFlag(MODULE_ID, `featureLines.${line.key}`)?.name || null;
    return {
      legend: F("Legend"),
      sentence: line.sentence,
      covered: line.covered ? F("Covered", { name: line.covered }) : "",
      tier: tierText(line.tier),
      canIgnore: game.user.isGM && !!this.item.system?._dsid,
      ignoreHint: F("IgnoreHint"),
      manualWhy: line.manual?.length ? F("ManualWhy", { why: line.manual.map((m) => F(`Manual.${m}`)).join(", ") }) : "",
      name: line.customName ?? "",
      namePlaceholder: line.customName ? "" : line.name,
      enabled: !!line.enabled,
      actionOptions: [["triggered", "ActionTriggered"], ["freeTriggered", "ActionFree"], ["", "ActionNone"]].map(([value, key]) => ({
        value, label: F(key), selected: (line.action ?? "") === value,
      })),
      actionHint: F("ActionHint"),
      onceOptions: [["round", "OnceRound"], ["turn", "OnceTurn"], ["encounter", "OnceEncounter"], ["", "OnceNone"]].map(([value, key]) => ({
        value, label: F(key), selected: (line.once ?? "") === value,
      })),
      labels: { name: F("Name"), enabled: F("Enabled"), action: F("Action"), once: F("Once"), ignore: F("Ignore") },
    };
  }

  _shownName() {
    const line = this._line;
    if (line.customName) return line.customName;
    if (this._lineType === "feature") return line.name || this.item.name;
    return namedGainLines(this.item.actor).find((e) => e.line.key === line.key)?.line.name || line.trigger || this.item.name;
  }

  _gainContext() {
    const line = this._line;
    const saved = this.item.getFlag(MODULE_ID, `gainLines.${line.key}`)?.name ?? "";
    line.customName ??= saved || null;
    const gates = (line.gates ?? []).map((id) => game.i18n.localize(`DS_TRIGGERS.Gain.Gate.${id}`));
    return {
      legend: game.i18n.localize("DS_TRIGGERS.Gain.Legend"),
      sentence: line.sentence,
      name: line.customName ?? "",
      namePlaceholder: line.customName ? "" : this._shownName(),
      enabled: !!line.enabled,
      manualWhy: line.manual?.length ? game.i18n.format("DS_TRIGGERS.Gain.ManualWhy", { why: line.manual.join(", ") }) : "",
      checks: gates.length ? game.i18n.format("DS_TRIGGERS.Gain.Checks", { list: gates.join(", ") }) : "",
      onceOptions: [["round", "OnceRound"], ["encounter", "OnceEncounter"], ["", "OnceNone"]].map(([value, key]) => ({
        value, label: game.i18n.localize(`DS_TRIGGERS.Gain.${key}`), selected: (line.once ?? "") === value,
      })),
      labels: {
        name: game.i18n.localize("DS_TRIGGERS.Gain.Name"),
        enabled: game.i18n.localize("DS_TRIGGERS.Gain.Enabled"),
        once: game.i18n.localize("DS_TRIGGERS.Gain.Once"),
      },
    };
  }

  static async #onSaveOverride() {
    this._syncFromDOM();
    if (this._lineType === "feature") {
      const line = this._line;
      await this.item.update({ [`flags.${MODULE_ID}.featureLines.${line.key}`]: {
        clauses: this._exportClauses(), enabled: !!line.enabled, action: line.action ?? null, once: line.once ?? null,
        name: line.customName ?? null,
      } });
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.Saved", { name: this._shownName() }));
      this.close();
      return;
    }
    if (this._line) {
      const line = this._line;
      await this.item.update({ [`flags.${MODULE_ID}.gainLines.${line.key}`]: {
        clauses: this._exportClauses(), enabled: !!line.enabled, amount: line.amount, once: line.once ?? null,
        name: line.customName ?? null,
      } });
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.Saved", { name: this.item.name }));
      this.close();
      return;
    }
    const update = {
      [`flags.${MODULE_ID}.manual`]: true,
      [`flags.${MODULE_ID}.trigger`]: { clauses: this._exportClauses() },
    };
    if (this._malice === undefined) update[`flags.${MODULE_ID}.-=malice`] = null;
    else update[`flags.${MODULE_ID}.malice`] = this._malice;
    if (Object.keys(this._useImpacts).length) update[`flags.${MODULE_ID}.useImpacts`] = this._useImpacts;
    else update[`flags.${MODULE_ID}.-=useImpacts`] = null;
    await this.item.update(update);
    clearParseCache(this.item.uuid);
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.Saved", { name: this.item.name }));
    this.close();
  }

  static async #onIgnoreFeature() {
    const dsid = String(this.item.system?._dsid ?? "").toLowerCase();
    if (!dsid || !game.user.isGM) return;
    await ignoreFeature({ dsid, name: this.item.name });
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Feature.Ignored", { name: this.item.name, dsid }));
    this.close();
  }

  static async #onResetParser() {
    this._syncFromDOM();
    if (this._line) {
      await this.item.update({ [`flags.${MODULE_ID}.${this._lineFlag()}.-=${this._line.key}`]: null });
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.ResetDone", { name: this.item.name }));
      this.close();
      return;
    }
    const update = {
      [`flags.${MODULE_ID}.-=manual`]: null,
      [`flags.${MODULE_ID}.-=trigger`]: null,
      [`flags.${MODULE_ID}.-=useImpacts`]: null,
    };
    if (this._malice === undefined) update[`flags.${MODULE_ID}.-=malice`] = null;
    else update[`flags.${MODULE_ID}.malice`] = this._malice;
    await this.item.update(update);
    clearParseCache(this.item.uuid);
    ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.ResetDone", { name: this.item.name }));
    this.close();
  }
}

Hooks.on("renderDrawSteelItemSheet", (app, element) => {
  const item = app.document;
  if (item?.type !== "ability" || !app.isEditable) return;
  if (!isTriggeredAbility(item) && !isMaliceAbility(item) && !isImplicitMaliceTrigger(item)) return;
  const anchor = element.querySelector('input[name="system.trigger"]')
    ?? element.querySelector('select[name="system.type"]');
  if (!anchor) return;
  const fields = anchor.closest(".form-fields") ?? anchor.parentElement;
  if (!fields || fields.querySelector(".dst-trigger-edit-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dst-trigger-edit-btn";
  btn.innerHTML = `<i class="fa-solid fa-wrench"></i>`;
  btn.dataset.tooltip = game.i18n.localize("DS_TRIGGERS.Editor.OpenTooltip");
  btn.addEventListener("click", () => new TriggerEditor(item).render({ force: true }));
  
  const wrap = document.createElement("div");
  wrap.className = "dst-input-wrap";
  anchor.parentNode.insertBefore(wrap, anchor);
  wrap.appendChild(anchor);
  wrap.appendChild(btn);
});
