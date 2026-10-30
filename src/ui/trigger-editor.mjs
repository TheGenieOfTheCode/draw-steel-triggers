import { MODULE_ID, getSetting } from "../util.mjs";
import { getParsedTrigger, clearParseCache, isMaliceAbility, isImplicitMaliceTrigger, isTriggeredAbility, triggerEffectText } from "../triggers/registry.mjs";
import { explainAbilityFilters, explainClauseFlags, annotateTrigger } from "../parser/trigger-parser.mjs";
import { heroGainLines, namedGainLines, itemGainLines } from "../triggers/resource-gains.mjs";
import { tierText, ignoreFeature, itemFeatureLines } from "../triggers/feature-triggers.mjs";
import { defersDeath } from "../parser/feature-triggers.mjs";
import { derivedInfo } from "../triggers/derived.mjs";
import { isConsumable } from "../triggers/consumables.mjs";
import { COUNTDOWN_RESOURCES } from "../triggers/countdowns.mjs";
import { QUALIFIERS, qualifierById, hasQualifier, writeSettings, clearQualifier } from "./qualifier-library.mjs";
import { QualifierPicker, optionLabel, conditionLabel } from "./qualifier-picker.mjs";
import { IMPACTS, impactById, impactLabel, impactHint, moveImpact, pruneImpacts, removeImpact } from "./editor-impacts.mjs";
import { richify, setTip, tip } from "./tips.mjs";

const L = (k, data) => data
  ? game.i18n.format(`DS_TRIGGERS.Editor.${k}`, data)
  : game.i18n.localize(`DS_TRIGGERS.Editor.${k}`);

const Q = (k, data) => data
  ? game.i18n.format(`DS_TRIGGERS.Qualifier.${k}`, data)
  : game.i18n.localize(`DS_TRIGGERS.Qualifier.${k}`);

const FLAG_TO_QUALIFIER = {
  damageTypes: "damage", edgeRequired: "roll", excludeSelfTarget: "ability", effectName: "which", zone: "zone", targetsOwner: "ability", targetsAlly: "ability", organizationInclude: "creatureIs",
  victimNotSelf: "creatureIs", sourceScope: "hasEffect", rolledDamage: "ability", abilityDealsDamage: "ability", fmPowerRoll: "ability", organization: "creatureIs", tauntedByOwner: "hasEffect",
  ownerLacks: "hasEffect", ownerEffect: "hasEffect", through: "movement", entersSpace: "movement", lineOfEffect: "lineOfEffect",
  victimNotMentor: "creatureIs", fmType: "movement", victimEndsAdjacent: "movement", firstTurn: "acted", damageOutcome: "damage",
  reducedByImmunity: "damage", notForceMoved: "ability", ownerGrabbing: "grabbing", fromFalling: "damage", victimCondition: "hasEffect",
  subjectConcealed: "subjectConcealed", fromForcedMovement: "damage", arrives: "movement", highGround: "highGround",
  flankedByDealer: "flankedByDealer", throughMark: "hasEffect", wouldLeave: "damage",
};

const SOURCE_RANK = ["manual", "bespoke", "effect", "parser"];

const FLAG_TO_IMPACTS = {
  half: ["halfHeld", "halfStrike"], rollMod: ["rollMod"], redirect: ["redirect"], fmMod: ["fmMod"], damageRedirect: ["redirectHeld"],
  damageReduction: ["reduceHeld"], fallReduction: ["fallReduce"], fallSafe: ["fallSafe"], damageBonus: ["damageBonus"],
};

function impactFragments(clause, triggerText, effectText) {
  const out = {};
  for (const f of explainClauseFlags(clause, triggerText, effectText)) {
    for (const id of FLAG_TO_IMPACTS[f.id] ?? []) out[id] ??= { fragment: f.fragment, from: f.from };
  }
  return out;
}

const shownWords = (text) => String(text ?? "")
  .replace(/\[\[[^\]]*\]\]\{([^}]*)\}/g, "$1")
  .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/\s+/g, " ")
  .trim();

function markFragments(html, pieces) {
  const box = document.createElement("div");
  box.innerHTML = html;
  const nodes = [];
  let full = "";
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: full.length });
    full += n.nodeValue;
  }
  const taken = [];
  for (const piece of pieces) {
    const words = shownWords(piece.fragment);
    if (!words) continue;
    const rx = new RegExp(words.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "gi");
    for (const m of full.matchAll(rx)) {
      const start = m.index, end = m.index + m[0].length;
      if (taken.some((t) => start < t.end && end > t.start)) continue;
      taken.push({ ...piece, start, end });
      break;
    }
  }
  taken.sort((x, y) => y.start - x.start);
  for (const t of taken) {
    for (const { node, start } of [...nodes].reverse()) {
      const len = node.nodeValue.length;
      const from = Math.max(t.start - start, 0), to = Math.min(t.end - start, len);
      if (from >= to || !node.parentNode) continue;
      const tail = node.splitText(to);
      const middle = from > 0 ? node.splitText(from) : node;
      const pill = document.createElement("span");
      pill.className = `dst-effect-pill dst-src-${t.source}`;
      pill.dataset.row = t.row;
      pill.dataset.tooltip = t.tooltip;
      pill.setAttribute("role", "button");
      pill.tabIndex = 0;
      middle.parentNode.insertBefore(pill, tail);
      pill.append(middle);
    }
  }
  return box.innerHTML;
}

const charLabel = (c) => game.i18n.localize(ds.CONFIG?.characteristics?.[c]?.label ?? c);

function shortValue(q, rule, value) {
  if (rule.kind === "check") return "";
  if (rule.kind === "ownerEffect") return value.label;
  if (rule.kind === "effects") {
    return value.map((e) => [Q(`Effect.on.${e.on ?? "subject"}`), Q(`Effect.has.${e.has !== false}`),
      e.kind === "condition" ? conditionLabel(e.value) : e.kind === "mark" ? Q(`Effect.mark.${e.value}`) : e.value,
      e.by && e.by !== "anyone" ? Q(`Effect.by.${e.by}`) : ""].filter(Boolean).join(" ")).join("; ");
  }
  return [].concat(value).map((v) => optionLabel(rule, v)).join(" or ");
}

function qualifierSummary(q, clause) {
  const parts = [];
  for (const rule of q.rules) {
    const value = rule.read(clause);
    if (value === undefined) continue;
    parts.push(Q(`${q.id}.Short.${rule.key}`, { v: shortValue(q, rule, value) }));
  }
  return parts.join(", ");
}

function textFragments(clause, triggerText, effectText) {
  const out = [];
  for (const f of explainAbilityFilters(triggerText, effectText)) {
    if (Object.keys(f.fields ?? {}).some((k) => clause[k] !== undefined)) out.push({ q: "ability", fragment: f.fragment, from: f.from });
  }
  for (const f of explainClauseFlags(clause, triggerText, effectText)) out.push({ q: FLAG_TO_QUALIFIER[f.id] ?? null, fragment: f.fragment, from: f.from });
  return out;
}

function leftoverText(clause, consumed) {
  let rest = (clause.qualifiers ?? []).filter((q) => !consumed.includes(q)).join(", ");
  for (const c of consumed) rest = rest.replace(new RegExp(c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), "");
  rest = rest.replace(/\s*(?:^|,)\s*(?:that|and|or|the)\b\s*/gi, " ").replace(/[\s,]+/g, " ").trim();
  if (/^(?:(?:with|using|by|from|to|of|against|a|an|the|that|and|or)\b\s*)+$/i.test(rest)) rest = "";
  return rest;
}

const isBespoke = (baseline, key) => baseline?.source === "special" || baseline?.bespoke === "all" || (Array.isArray(baseline?.bespoke) && baseline.bespoke.includes(key));

function ruleSource(rule, clause, baseClause, baseline, fromEffect) {
  const now = rule.read(clause);
  if (now === undefined) return null;
  const was = baseClause ? rule.read(baseClause) : undefined;
  if (JSON.stringify(now) !== JSON.stringify(was)) return "manual";
  if (isBespoke(baseline, rule.key)) return "bespoke";
  return fromEffect ? "effect" : "parser";
}

export function qualifierSources(q, clause, baseClause, baseline, fragments = []) {
  const effectOnly = fragments.length > 0 && fragments.every((f) => f.from === "effect");
  const out = {};
  for (const rule of q.rules) {
    const src = ruleSource(rule, clause, baseClause, baseline, effectOnly || rule.key === "abilityCostScales");
    if (src) out[rule.key] = src;
  }
  return out;
}

function clauseQualifierPills(clause, triggerText, effectText, baseClause, baseline) {
  const fragments = textFragments(clause, triggerText, effectText);
  const consumed = fragments.map((f) => f.fragment);
  const distance = (clause.qualifiers ?? []).find((q) => /within \d+|\badjacent\b/i.test(q));
  if (distance) consumed.push(distance);
  const pills = [];
  for (const q of QUALIFIERS) {
    if (!hasQualifier(q, clause)) continue;
    const mine = fragments.filter((f) => f.q === q.id);
    const sources = qualifierSources(q, clause, baseClause, baseline, mine);
    const ranked = Object.values(sources).sort((a, b) => SOURCE_RANK.indexOf(a) - SOURCE_RANK.indexOf(b));
    const source = q.unchecked ? "unchecked" : ranked[0] ?? "parser";
    const fromText = [...new Set(mine.map((f) => f.fragment))].join(", ");
    pills.push({
      id: q.id, source,
      text: fromText || qualifierSummary(q, clause) || Q(`${q.id}.Label`),
      tooltip: `<strong>${foundry.utils.escapeHTML(Q(`${q.id}.Label`))}</strong> (${foundry.utils.escapeHTML(Q(`Source.${source}`))})<br>${foundry.utils.escapeHTML(qualifierSummary(q, clause))}<br><em>${foundry.utils.escapeHTML(Q("PillHint"))}</em>`,
    });
  }
  const rest = leftoverText(clause, consumed);
  if (rest) pills.push({ id: "", source: "unchecked", text: rest, tooltip: foundry.utils.escapeHTML(Q("SourceHint.unchecked")) });
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
    "GAINS_TEMP_STAMINA", "GAINS_SURGE", "TELEPORTS", "SIZE_CHANGES", "FORM_CHANGES", "MALICE_SPENT", "NATURAL_19_20",
    "STAMINA_BELOW", "GRAB_ENDS", "RESOURCE_GAIN", "TEST_FAILED",
  ]],
  ["Bespoke", [
    "MECHANISM", "NARRATIVE", "UNKNOWN",
  ]],
];
const SCOPES = [
  "SELF", "TARGET", "ALLY", "ENEMY", "ANY", "COMPANION", "MENTOR",
  "GROUP", "SELF_OR_ALLY", "OBJECT", "GRABBED_CREATURE", "UNKNOWN",
];

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

function unlinkImpactText(clause, id) {
  if (!clause?.impactText?.[id]) return;
  delete clause.impactText[id];
  if (!Object.keys(clause.impactText).length) delete clause.impactText;
}

const blankClause = () => ({ event: "UNKNOWN", scope: "SELF", qualifiers: [] });

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
    this._baseline = this._computeBaseline();
    this._expanded = new Set();
    this._malice = item.getFlag(MODULE_ID, "malice");
    this._source = parse?.source ?? "none";
    this._confidence = parse?.confidence ?? "";
  }

  _computeBaseline() {
    try {
      if (this._lineType === "feature") return itemFeatureLines(this.item, { withIgnored: true }).find((l) => l.key === this._line.key)?.parse ?? null;
      if (this._lineType === "gain") return itemGainLines(this.item).find((l) => l.key === this._line.key)?.parse ?? null;
      return getParsedTrigger(this.item, { ignoreManual: true });
    } catch (err) {
      console.warn(`${MODULE_ID} | trigger builder could not read the parser's version of ${this.item.name}`, err);
      return null;
    }
  }

  _ownAbilityOptions(current) {
    const list = new Map([["melee-free-strike", L("RangeFreeMelee")], ["ranged-free-strike", L("RangeFreeRanged")]]);
    for (const i of this.item.actor?.items ?? []) {
      const dsid = i.type === "ability" ? i.system?._dsid : null;
      if (dsid && !list.has(dsid)) list.set(dsid, i.name);
    }
    if (current && !list.has(current)) list.set(current, current);
    return [...list].map(([value, name]) => ({ value, label: name, selected: value === current }));
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

  _clauseContext(c, index) {
    const qualifiers = clauseQualifierPills(c, this._triggerText, this._effectText, this._baseline?.clauses?.[index], this._baseline);
    const summary = qualifiers.map((q) => q.text);
    if (c.postRoll) summary.unshift(L("TimingAfterShort"));
    const range = c.range;
    const rangeMode = range === "none" ? "none" : Number.isFinite(range) ? "custom" : range?.char ? "char"
      : range?.ability ? "ability" : range && typeof range === "object" ? "line" : "auto";
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
      scopeOptions: SCOPES.map((sc) => ({ value: sc, label: label(sc), selected: sc === c.scope })),
      rangeOptions: [
        ...(rangeMode === "line" ? [["line", rangeLineLabel(range)]] : []),
        ["auto", L("RangeAuto")], ["none", L("RangeNone")], ["custom", L("RangeCustom")],
        ["char", L("RangeCharOption")], ["ability", L("RangeAbilityOption")],
      ].map(([value, optLabel]) => ({ value, label: optLabel, selected: rangeMode === value })),
      rangeCustom: rangeMode === "custom",
      rangeValue: Number.isFinite(range) ? range : 1,
      rangeChar: rangeMode === "char",
      charOptions: Object.keys(ds.CONFIG?.characteristics ?? {}).map((k) => ({ value: k, label: charLabel(k), selected: range?.char === k })),
      rangeAbility: rangeMode === "ability",
      abilityOptions: rangeMode === "ability" ? this._ownAbilityOptions(range.ability) : [],
      showRangeOn: ["TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "DEALS_DAMAGE"].includes(c.event) || c.rangeOn === "dealer",
      rangeOnDealer: c.rangeOn === "dealer",
      showRangeMin: c.event === "DEALS_DAMAGE" || Number.isFinite(c.rangeMin),
      rangeMin: Number.isFinite(c.rangeMin) ? c.rangeMin : "",
      showOwnerInAbility: c.event === "USES_ABILITY" || !!c.ownerInAbilityRange,
      ownerInAbilityRange: !!c.ownerInAbilityRange,
      qualifiers,
      showTiming: TARGETING_EVENTS.has(c.event) || !!c.postRoll,
      timingOptions: [["before", L("TimingBefore")], ["after", L("TimingAfter")]]
        .map(([value, optLabel]) => ({ value, label: optLabel, selected: (c.postRoll ? "after" : "before") === value })),
    };
  }

  _impactSource(impact, c, index, fromEffect) {
    const base = this._baseline?.clauses?.[index];
    const same = !!base && impact.has(base) && (impact.id !== "hold" || base.event === c.event)
      && impact.keys.every((k) => JSON.stringify(c[k]) === JSON.stringify(base[k]));
    if (!same) return "manual";
    if (impact.keys.some((k) => isBespoke(this._baseline, k)) || this._baseline?.source === "special") return "bespoke";
    return fromEffect ? "effect" : "parser";
  }

  _impactRows() {
    const rows = [];
    const many = this._clauses.length > 1;
    const shown = this._shownEffectText();
    this._clauses.forEach((c, index) => {
      const found = impactFragments(c, this._triggerText, shown);
      for (const impact of IMPACTS) {
        if (!impact.has(c)) continue;
        const source = this._impactSource(impact, c, index, !!found[impact.id] || impact.keys.length > 0);
        const linked = c.impactText?.[impact.id] ?? null;
        const row = `${impact.id}-${index}`;
        const fields = (impact.fields?.(c) ?? []).map((f) => ({ ...f, attrs: fieldAttrs(impact, index, f) }));
        const homes = impact.keys.length && many
          ? this._clauses.map((other, i) => ({ other, i })).filter(({ other, i }) => i === index || (impact.supports(other) && !impact.has(other)))
          : [];
        const clauseOptions = homes.length > 1 ? homes.map(({ i }) => ({
          value: i, label: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: i + 1 }), selected: i === index,
        })) : null;
        rows.push({
          id: impact.id, index, row, icon: impact.icon, source,
          sourceLabel: Q(`Source.${source}`), sourceHint: Q(`SourceHint.${source}`),
          fragment: linked ?? found[impact.id]?.fragment ?? null, linked: !!linked,
          label: impactLabel(impact),
          summary: impact.summary(c),
          hint: impactHint(impact),
          unsupported: impact.supports(c) ? "" : L("Impact.Unsupported", { n: index + 1 }),
          colour: index % 4,
          clauseLabel: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: index + 1 }),
          fields, clauseOptions,
          hasBody: true,
          expanded: this._expanded.has(row),
        });
      }
    });
    return [...this._wholeImpactRows(), ...rows];
  }

  _shownEffectText() {
    const effect = this._line ? (this._lineType === "feature" ? this._line.effect : "") : shownEffect(this.item);
    return effect ? effect[0].toUpperCase() + effect.slice(1) : "";
  }

  _effectSourceHtml() {
    if (this._line) return this._lineType === "feature" && this._line.effect ? `<p>${foundry.utils.escapeHTML(this._line.effect)}</p>` : "";
    const box = document.createElement("div");
    box.innerHTML = [...(this.item.system.effects ?? [])].map((e) => e.description ?? "").join("");
    for (const secret of box.querySelectorAll("section.secret")) secret.remove();
    return box.innerHTML.trim();
  }

  async _effectHtml(rows) {
    const source = this._effectSourceHtml();
    if (!source) return "";
    const enriched = await foundry.applications.ux.TextEditor.implementation.enrichHTML(source, {
      relativeTo: this.item, rollData: this.item.getRollData?.() ?? this.item.actor?.getRollData?.() ?? {}, secrets: false,
    });
    return markFragments(enriched, this._effectPieces(rows));
  }

  _effectPieces(rows) {
    const text = this._shownEffectText();
    if (!text) return [];
    const pieces = rows.filter((r) => r.fragment).map((r) => ({
      fragment: r.fragment, row: r.row, source: r.linked ? "manual" : r.source,
      tooltip: `<strong>${foundry.utils.escapeHTML(r.label)}</strong> (${foundry.utils.escapeHTML(Q(`Source.${r.linked ? "manual" : r.source}`))})`,
    }));
    const recovery = rows.find((r) => r.id === "recovery");
    const spend = text.match(/\bspend a recovery\b/i);
    if (recovery && spend) pieces.push({ fragment: spend[0], row: recovery.row, source: recovery.fixed ? "effect" : "manual", tooltip: foundry.utils.escapeHTML(recovery.label) });
    return pieces;
  }

  _wholeImpactRows() {
    const row = (id, icon, summary, { fields = [], removable = false } = {}) => ({
      id, row: `whole-${id}`, icon, whole: true, fixed: !removable, label: L(`Impact.${id}.Label`), summary,
      source: removable ? "manual" : "effect", sourceLabel: Q(`Source.${removable ? "manual" : "effect"}`), sourceHint: Q(`SourceHint.${removable ? "manual" : "effect"}`),
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
    if (!line) {
      for (const fx of this.item.system?.effects ?? []) {
        if (!String(fx.type ?? "").startsWith("dsct.")) continue;
        const data = fx[fx.type.slice(5)] ?? {};
        const typeLabel = game.i18n.localize(CONFIG.DrawSteel?.SpecialEffect?.[fx.type]?.label ?? ds.CONFIG?.SpecialEffect?.[fx.type]?.label ?? `TYPES.SpecialEffect.${fx.type}`);
        rows.push({
          id: `enhanced-${fx.id}`, row: `whole-enhanced-${fx.id}`, icon: "fa-solid fa-wand-sparkles", whole: true, fixed: true,
          label: data.display || fx.name || typeLabel, summary: data.displayText || typeLabel,
          source: "enhanced", sourceLabel: Q("Source.enhanced"), sourceHint: Q("SourceHint.enhanced"),
          hint: L("Impact.enhanced.Hint"), fields: [], hasBody: true, expanded: this._expanded.has(`whole-enhanced-${fx.id}`),
        });
      }
    }
    if (line?.cost?.amount) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: line.cost.amount, resource: line.cost.resource ?? "" })));
    else if (derived?.epicCost) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: derived.epicCost, resource: actor?.system?.hero?.epic?.label ?? "" })));
    else if (!line && Number(this.item.system?.resource) > 0) rows.push(row("cost", "fa-solid fa-coins", L("Impact.cost.Summary", { n: this.item.system.resource, resource: actor?.system?.coreResource?.name ?? "" })));
    const source = line ? this.item : derived ? actor?.items.get(derived.sourceId) : null;
    if (isConsumable(source)) rows.push(row("consumable", "fa-solid fa-flask", L(getSetting("autoSpendConsumables") ? "Impact.consumable.Auto" : "Impact.consumable.Manual")));
    if (line && defersDeath(line.effect)) rows.push(row("defersDeath", "fa-solid fa-skull", L("Impact.defersDeath.Summary")));
    return rows;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
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
    const impacts = this._impactRows();
    return {
      ...context,
      header: this._headerContext(),
      triggerText: this._triggerText,
      triggerPills,
      effectText: this._shownEffectText(),
      effectHtml: await this._effectHtml(impacts),
      gain: this._lineType === "gain" ? this._gainContext() : null,
      feature: this._lineType === "feature" ? this._featureContext() : null,
      isLine: !!this._line,
      noTriggerText: this._line?.sentence || L("NoTriggerText"),
      statusLine: getSetting("debugMode") ? game.i18n.format("DS_TRIGGERS.Editor.Status", { source: this._source, confidence: this._confidence || "n/a" }) : "",
      isManual: this._line ? !!this.item.getFlag(MODULE_ID, `${this._lineFlag()}.${this._line.key}`) : !!this.item.getFlag(MODULE_ID, "manual"),
      labels: {
        clauses: L("Clauses"), event: L("Event"), scope: L("Scope"), range: L("Range"), timing: L("Timing"),
        qualifiers: L("Qualifiers"), qualifiersNone: L("QualifiersNone"), addQualifier: game.i18n.localize("DS_TRIGGERS.Qualifier.AddPill"),
        rangeOn: L("RangeMeasureDealer"), rangeMin: L("RangeMin"), ownerInAbility: L("RangeOwnerInAbility"),
        howOften: L("HowOften"),
        addClause: L("AddClause"), options: L("RowOptions"), expand: L("RowExpand"),
        impacts: L("Impacts"), clause: L("Clause"), wholeTrigger: L("WholeTrigger"), effect: L("EffectText"), effectHint: L("Impact.EffectHint"),
        addImpact: L("AddImpact"), noImpacts: L("NoImpacts"), noImpactsPossible: L("NoImpactsPossible"),
        linkedText: L("LinkedText"),
        malice: L("Malice"), save: L("Save"), reset: L("Reset"),
      },
      hints: {
        scope: L("ScopeHint"), range: L("RangeHint"), qualifiers: L("QualifiersHint"), timing: L("TimingHint"),
        malice: L("MaliceHint"), howOften: L("HowOftenHint"),
        save: L("SaveHint"), reset: L("ResetHint"),
      },
      clauses: this._clauses.map((c, index) => this._clauseContext(c, index)),
      impacts,
      canAddImpact: this._addableImpacts().length > 0,
      howOftenOptions: this._line ? null : [["", L("HowOftenAny")], ["round", L("HowOftenRound")]]
        .map(([value, optLabel]) => ({ value, label: optLabel, selected: (this._clauses.some((c) => c.oncePerRound) ? "round" : "") === value })),
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
      target = [...clauseEl.querySelectorAll(".dst-qual-pill")].find((p) => p.textContent.trim().toLowerCase().includes(wanted))
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
    richify(this.element, "EditorCategory");
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
      const effectPill = event.target.closest(".dst-effect-pill[data-row]");
      if (effectPill) {
        event.preventDefault();
        this._setExpanded(effectPill.dataset.row, true);
        const li = el.querySelector(`[data-action="toggleRow"][data-row="${effectPill.dataset.row}"]`)?.closest(".expandable-document");
        if (li) {
          li.scrollIntoView({ block: "nearest", behavior: "smooth" });
          void li.offsetWidth;
          li.classList.add("dst-flash");
          setTimeout(() => li.classList.remove("dst-flash"), 1800);
        }
        return;
      }
      const add = event.target.closest("[data-qual-add]");
      const pill = add ? null : event.target.closest(".dst-qual-pill[data-qualifier]");
      if (!add && !pill?.dataset.qualifier) return;
      event.preventDefault();
      this._syncFromDOM();
      this._openQualifierPicker(Number((add ?? pill).dataset.index), pill?.dataset.qualifier || null);
    }, { signal });

    el.querySelector(".dst-editor-effect-text")?.addEventListener("mouseup", (event) => {
      const selection = window.getSelection();
      const picked = selection?.toString().replace(/\s+/g, " ").trim();
      if (!picked || picked.length < 2 || !event.currentTarget.contains(selection.anchorNode)) return;
      this._openLinkMenu(event, picked);
    }, { signal });

    el.addEventListener("change", (event) => {
      const target = event.target;
      if (target.localName === "select" && target.dataset.field !== "malice" && !target.closest("[data-gain-field], [data-feature-field]")) {
        this._syncFromDOM();
        this.render();
      } else if (target.matches?.("[data-rerender]")) {
        this._syncFromDOM();
        this.render();
      }
    }, { signal });
  }

  close(options) {
    this._listenerAbort?.abort();
    return super.close(options);
  }

  _openLinkMenu(event, picked) {
    this._syncFromDOM();
    const many = this._clauses.length > 1;
    const entries = [];
    this._clauses.forEach((c, index) => {
      for (const impact of IMPACTS) {
        if (!impact.has(c)) continue;
        entries.push({
          label: many ? L("Impact.LinkToClause", { impact: impactLabel(impact), n: index + 1 }) : L("Impact.LinkTo", { impact: impactLabel(impact) }),
          icon: impact.icon,
          onClick: () => {
            c.impactText = { ...(c.impactText ?? {}), [impact.id]: picked };
            window.getSelection()?.removeAllRanges();
            this.render();
          },
        });
      }
    });
    if (!entries.length) entries.push({ label: L("Impact.NothingToLink"), icon: "fa-solid fa-circle-info", onClick: () => {} });
    const anchor = event.currentTarget ?? event.target;
    this._openMenu(event, anchor, entries);
  }

  _openQualifierPicker(index, qualifierId) {
    const clause = this._clauses[index];
    if (!clause) return;
    const q = qualifierId ? qualifierById(qualifierId) : null;
    const baseClause = this._baseline?.clauses?.[index];
    const sources = q ? qualifierSources(q, clause, baseClause, this._baseline) : {};
    foundry.applications.instances.get("dst-qualifier-picker")?.close();
    new QualifierPicker({
      clause, event: clause.event, qualifierId, provenance: sources,
      onApply: (id, settings) => {
        writeSettings(qualifierById(id), clause, settings);
        this.render();
      },
      onRemove: (id) => {
        clearQualifier(qualifierById(id), clause);
        this.render();
      },
    }).render({ force: true });
  }

  _syncFromDOM() {
    const el = this.element;
    const clauseAt = (node) => this._clauses[Number(node.dataset.index)];
    for (const input of el.querySelectorAll("input[data-field][data-index], select[data-field][data-index]")) {
      if (input.localName === "multi-select" || ["rangeSelect", "rangeValue", "rangeChar", "rangeAbility", "rangeOn", "rangeMin", "ownerInAbilityRange", "timing", "howOften"].includes(input.dataset.field)) continue;
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
    for (const select of el.querySelectorAll('select[data-field="timing"]')) {
      const clause = clauseAt(select);
      if (!clause) continue;
      if (select.value === "after") clause.postRoll = true;
      else delete clause.postRoll;
    }
    for (const select of el.querySelectorAll('select[data-field="rangeSelect"]')) {
      const clause = clauseAt(select);
      if (!clause || select.value === "line") continue;
      const body = select.closest(".dst-row-body");
      const pick = (f) => body?.querySelector(`[data-field="${f}"]`);
      let next;
      if (select.value === "none") next = "none";
      else if (select.value === "custom") next = pick("rangeValue") ? Math.max(1, Math.floor(Number(pick("rangeValue").value) || 1)) : (Number.isFinite(clause.range) ? clause.range : 1);
      else if (select.value === "char") next = { char: pick("rangeChar")?.value || clause.range?.char || Object.keys(ds.CONFIG?.characteristics ?? {})[0] };
      else if (select.value === "ability") next = { ability: pick("rangeAbility")?.value || clause.range?.ability || "melee-free-strike" };
      if (JSON.stringify(next) === JSON.stringify(clause.range)) continue;
      if (next === undefined) delete clause.range;
      else clause.range = next;
    }
    for (const box of el.querySelectorAll('input[data-field="rangeOn"]')) {
      const clause = clauseAt(box);
      if (!clause || box.checked === (clause.rangeOn === "dealer")) continue;
      if (box.checked) clause.rangeOn = "dealer";
      else delete clause.rangeOn;
    }
    for (const input of el.querySelectorAll('input[data-field="rangeMin"]')) {
      const clause = clauseAt(input);
      if (!clause) continue;
      const n = input.value === "" ? undefined : Math.floor(Number(input.value));
      if (n === clause.rangeMin || (n === undefined && clause.rangeMin === undefined)) continue;
      if (Number.isFinite(n) && n > 0) clause.rangeMin = n;
      else delete clause.rangeMin;
    }
    for (const box of el.querySelectorAll('input[data-field="ownerInAbilityRange"]')) {
      const clause = clauseAt(box);
      if (!clause || box.checked === !!clause.ownerInAbilityRange) continue;
      if (box.checked) clause.ownerInAbilityRange = true;
      else delete clause.ownerInAbilityRange;
    }
    const often = el.querySelector('select[data-field="howOften"]');
    if (often && (often.value === "round") !== this._clauses.some((c) => c.oncePerRound)) {
      for (const c of this._clauses) {
        if (often.value === "round") c.oncePerRound = true;
        else delete c.oncePerRound;
      }
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
      if (field("neverAutoUse")) this._line.neverAutoUse = field("neverAutoUse").checked;
      if (field("once")) this._line.once = field("once").value || null;
      if (field("countdownStart")) {
        const start = Math.max(0, Math.floor(Number(field("countdownStart").value) || 0));
        const next = start ? { start, resource: field("countdownResource")?.value || "victories", by: field("countdownBy")?.value === "amount" ? "amount" : "fixed",
          step: Math.max(1, Math.floor(Number(field("countdownStep")?.value) || 1)) } : null;
        if (JSON.stringify(next) !== JSON.stringify(this._line.countdown ?? null)) { this._line.countdown = next; this._line.countdownEdited = true; }
      }
      if (field("tierLevel") || field("tierMin")) {
        const level = Math.max(0, Math.floor(Number(field("tierLevel")?.value) || 0));
        const min = Math.max(0, Math.floor(Number(field("tierMin")?.value) || 0));
        const before = this._line.tier ?? null;
        if ((before?.level || 0) !== level || (before?.min || 0) !== min) {
          this._line.tier = level || min ? { ...(before ?? {}), level: level || null, min } : null;
          this._line.tierEdited = true;
        }
      }
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
      pruneImpacts(out);
      return out;
    });
  }

  _forgetRows() {
    this._expanded = new Set([...this._expanded].filter((row) => row.startsWith("line-")));
  }

  static #onAddClause() {
    this._syncFromDOM();
    this._clauses.push(blankClause());
    this._expanded.add(`clause-${this._clauses.length - 1}`);
    this.render();
  }

  static #onClauseMenu(event, target) {
    const index = Number(target.dataset.index);
    this._openMenu(event, target, [
      { label: L("DuplicateClause"), icon: "fa-solid fa-copy", onClick: () => {
        this._syncFromDOM();
        this._clauses.splice(index + 1, 0, foundry.utils.deepClone(this._clauses[index]));
        this._forgetRows();
        this._expanded.add(`clause-${index + 1}`);
        this.render();
      } },
      { label: L("RemoveClause"), icon: "fa-solid fa-trash", onClick: () => {
        this._syncFromDOM();
        this._clauses.splice(index, 1);
        if (!this._clauses.length) this._clauses.push(blankClause());
        this._forgetRows();
        this.render();
      } },
    ]);
  }

  static #onAddImpact(event, target) {
    this._syncFromDOM();
    this._openMenu(event, target, [...this._addableImpacts().map(({ impact, index }) => ({
      label: impactLabel(impact), icon: impact.icon,
      onClick: () => {
        impact.add(this._clauses[index]);
        if (impact.fields) this._expanded.add(`${impact.id}-${index}`);
        this.render();
      },
    }))]);
  }

  static #onImpactMenu(event, target) {
    const impact = impactById(target.dataset.impact);
    const index = Number(target.dataset.index);
    if (!impact) return;
    const clause = this._clauses[index];
    this._openMenu(event, target, [
      ...(clause?.impactText?.[impact.id] ? [{
        label: L("Impact.Unlink"), icon: "fa-solid fa-link-slash",
        onClick: () => {
          this._syncFromDOM();
          unlinkImpactText(clause, impact.id);
          this.render();
        },
      }] : []),
      {
        label: L("RemoveImpact"), icon: "fa-solid fa-trash",
        onClick: () => {
          this._syncFromDOM();
          removeImpact(impact, clause);
          unlinkImpactText(clause, impact.id);
          this._expanded.delete(`${impact.id}-${index}`);
          this.render();
        },
      },
    ]);
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
      neverAutoUse: !!line.neverAutoUse,
      neverAutoHint: F("NeverAutoHint"),
      onceOptions: [["round", "OnceRound"], ["turn", "OnceTurn"], ["encounter", "OnceEncounter"], ["", "OnceNone"]].map(([value, key]) => ({
        value, label: F(key), selected: (line.once ?? "") === value,
      })),
      labels: { name: F("Name"), enabled: F("Enabled"), action: F("Action"), once: F("Once"), ignore: F("Ignore"), neverAuto: F("NeverAuto"),
        prereq: F("Prereq"), tierLevel: F("PrereqLevel"), tierMin: F("PrereqResource", { resource: this._resourceLabel() }) },
      tierLevel: line.tier?.level ?? "",
      tierMin: line.tier?.min || "",
      prereqHint: F("PrereqHint"),
      countdown: {
        legend: F("Countdown"), hint: F("CountdownHint"), start: line.countdown?.start || "", step: line.countdown?.step ?? 1,
        labels: { start: F("CountdownStart"), resource: F("CountdownResource"), by: F("CountdownBy"), step: F("CountdownStep") },
        resources: Object.entries(COUNTDOWN_RESOURCES).map(([value, r]) => ({ value, label: game.i18n.localize(r.label), selected: (line.countdown?.resource ?? "victories") === value })),
        byOptions: [["fixed", "CountdownFixed"], ["amount", "CountdownAmount"]].map(([value, key]) => ({ value, label: F(key), selected: (line.countdown?.by ?? "fixed") === value })),
      },
    };
  }

  _resourceLabel() {
    const name = this.item.actor?.items?.find((i) => i.type === "class")?.system?.primary;
    return name ? String(name) : game.i18n.localize("DS_TRIGGERS.Feature.PrereqResourceFallback");
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
    const gates = (line.gates ?? []).map((id) => game.i18n.format(`DS_TRIGGERS.Gain.Gate.${id}`, { base: line.turnDamageBase ?? 5 }));
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
        name: line.customName ?? null, neverAutoUse: !!line.neverAutoUse,
        ...(line.tierEdited ? { tier: line.tier ? { level: line.tier.level ?? null, min: line.tier.min ?? 0 } : null } : {}),
        ...(line.countdownEdited ? { countdown: line.countdown ?? { start: 0 } } : {}),
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
      await this.item.update({ [`flags.${MODULE_ID}.${this._lineFlag()}.${this._line.key}`]: new foundry.data.operators.ForcedDeletion() });
      ui.notifications.info(game.i18n.format("DS_TRIGGERS.Editor.ResetDone", { name: this.item.name }));
      this.close();
      return;
    }
    const update = {
      [`flags.${MODULE_ID}.-=manual`]: null,
      [`flags.${MODULE_ID}.-=trigger`]: null,
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
  if (!isTriggeredAbility(item) && !isMaliceAbility(item) && !isImplicitMaliceTrigger(item) && !derivedInfo(item)) return;
  const anchor = element.querySelector('input[name="system.trigger"]')
    ?? element.querySelector('select[name="system.type"]');
  if (!anchor) return;
  const fields = anchor.closest(".form-fields") ?? anchor.parentElement;
  if (!fields || fields.querySelector(".dst-trigger-edit-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dst-trigger-edit-btn";
  btn.innerHTML = `<i class="fa-solid fa-wrench"></i>`;
  setTip(btn, tip("OpenEditor", { body: game.i18n.localize("DS_TRIGGERS.Editor.OpenTooltip") }));
  btn.addEventListener("click", () => new TriggerEditor(item).render({ force: true }));
  
  const wrap = document.createElement("div");
  wrap.className = "dst-input-wrap";
  anchor.parentNode.insertBefore(wrap, anchor);
  wrap.appendChild(anchor);
  wrap.appendChild(btn);
});
