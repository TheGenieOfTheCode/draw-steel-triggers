import { MODULE_ID } from "../util.mjs";
import { getParsedTrigger, clearParseCache, isMaliceAbility, isImplicitMaliceTrigger, isTriggeredAbility, triggerEffectText } from "../triggers/registry.mjs";
import { explainAbilityFilters, explainClauseFlags, annotateTrigger } from "../parser/trigger-parser.mjs";
import { heroGainLines, namedGainLines } from "../triggers/resource-gains.mjs";
import { tierText, ignoreFeature } from "../triggers/feature-triggers.mjs";

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
  through: ["through", "throughScope"],
  victimNotMentor: ["victimNotMentor"],
  entersSpace: ["entersSpace"],
};

function describeFilter(id, fields) {
  switch (id) {
    case "range": return L("QualEffectRange", { n: fields.range });
    case "abilityType": return L("QualEffectType", { type: fields.abilityType });
    case "abilityCostMax": return L("QualEffectCost", { n: fields.abilityCostMax });
    case "abilityCategory": return L({ heroic: "QualEffectHeroic", signature: "QualEffectSignature" }[fields.abilityCategory] ?? "QualEffectNonHeroic");
    case "abilityKeywords": return L("QualEffectKeywords", { keywords: fields.abilityKeywords.join(" or ") });
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
    case "through": return fields.throughScope
      ? L("QualEffectThroughSide", { side: String(fields.throughScope).toLowerCase() })
      : L("QualEffectThrough");
    case "victimNotMentor": return L("QualEffectNotMentor");
    case "entersSpace": return L("QualEffectEntersSpace");
    default: return L("QualEffectNone");
  }
}

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

  for (const f of clause.event === "USES_ABILITY" ? explainAbilityFilters(triggerText, effectText) : []) {
    pills.push({
      id: f.id, text: f.fragment,
      tooltip: describeFilter(f.id, f.fields) + (f.from === "effect" ? ` ${L("QualFromEffect")}` : ""),
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
  if (rest) pills.push({ id: "", text: rest, tooltip: L("QualEffectNone"), enforced: false, disabled: false });

  return pills;
}

const EVENT_GROUPS = [
  ["Common", [
    "TAKES_DAMAGE", "DEALS_DAMAGE", "DIES", "WINDED_OR_DYING",
    "TARGETED_BY_STRIKE", "TARGETED_BY_ABILITY", "MAKES_STRIKE", "POWER_ROLL", "MOVES", "FORCE_MOVED",
    "TURN_START", "TURN_END", "CONDITION_GAIN", "USES_ABILITY",
  ]],
  ["Rare", [
    "FORCE_MOVES", "ROUND_START", "POWER_ROLL_RESULT", "ZONE_ENTER", "ZONE_TURN_START",
    "EFFECT_ENDS", "SAVING_THROW", "REGAINS_STAMINA", "LOSES_STAMINA", "MARKED",
  ]],
  ["Bespoke", [
    "RESOURCE_GAIN", "STAMINA_BELOW", "MECHANISM", "NARRATIVE",
    "GRAB_ENDS", "RESISTS_POTENCY", "TEST_FAILED", "UNKNOWN",
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

const ROLL_MOD_VALUES = {
  banes1: { banes: 1 }, banes2: { banes: 2 },
  edges1: { edges: 1 }, edges2: { edges: 2 },
};

const ROLL_MOD_EVENTS = new Set([...TARGETING_EVENTS, "MAKES_STRIKE", "POWER_ROLL"]);

function _rollModValue(mod) {
  if (!mod) return "";
  if (mod.banes === 2) return "banes2";
  if (mod.banes === 1) return "banes1";
  if (mod.edges === 2) return "edges2";
  if (mod.edges === 1) return "edges1";
  return "";
}

const label = (v) => v.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export class TriggerEditor extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-trigger-editor",
    classes: ["draw-steel", "dst-trigger-editor"],
    window: { minimizable: true, resizable: true },
    position: { width: 500, height: 560 },
    actions: {
      addClause: TriggerEditor.#onAddClause,
      removeClause: TriggerEditor.#onRemoveClause,
      saveOverride: TriggerEditor.#onSaveOverride,
      resetParser: TriggerEditor.#onResetParser,
      ignoreFeature: TriggerEditor.#onIgnoreFeature,
    },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/trigger-editor.hbs` },
  };

  
  constructor(item, { line = null, ...options } = {}) {
    super(line ? { ...options, id: "dst-trigger-editor-line", position: { width: 500, height: Math.min(800, window.innerHeight - 40) } } : options);
    this.item = item;
    this._line = line;
    this._lineType = line ? (line.lineType ?? "gain") : null;
    this._triggerText = line ? (line.trigger ? `${line.trigger}.` : "") : (item.system.trigger ?? "");
    this._effectText = line ? (line.effect ?? "") : triggerEffectText(item);
    const parse = line ? line.parse : getParsedTrigger(item);
    this._clauses = (parse?.clauses ?? [{ event: "UNKNOWN", scope: "SELF", qualifiers: [] }])
      .map((c) => foundry.utils.deepClone(c));
    const keywordIds = new Set(Object.keys(ds.CONFIG.monsters?.keywords ?? {}));
    for (const clause of this._clauses) {
      clause._customs = clause.groupName && !keywordIds.has(clause.groupName) ? [clause.groupName] : [];
    }
    
    this._pristine = foundry.utils.deepClone(this._clauses);
    this._malice = item.getFlag(MODULE_ID, "malice");
    this._source = parse?.source ?? "none";
    this._confidence = parse?.confidence ?? "";
  }

  get title() {
    if (this._line) return game.i18n.format("DS_TRIGGERS.Editor.Title", { name: this._shownName() });
    return game.i18n.format("DS_TRIGGERS.Editor.Title", { name: this.item.name });
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(`DS_TRIGGERS.Editor.${k}`);
    const keywords = Object.entries(ds.CONFIG.monsters?.keywords ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const damageTypes = Object.entries(ds.CONFIG.damageTypes ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }));
    const annotated = annotateTrigger(this._triggerText, this._line ? { effectText: this._effectText } : {
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
    return {
      triggerText: this._triggerText,
      triggerPills,
      gain: this._lineType === "gain" ? this._gainContext() : null,
      feature: this._lineType === "feature" ? this._featureContext() : null,
      isLine: !!this._line,
      noTriggerText: L("NoTriggerText"),
      statusLine: game.i18n.format("DS_TRIGGERS.Editor.Status", {
        source: this._source, confidence: this._confidence || "n/a",
      }),
      isManual: this._line ? !!this.item.getFlag(MODULE_ID, `${this._lineFlag()}.${this._line.key}`) : !!this.item.getFlag(MODULE_ID, "manual"),
      removeTooltip: L("RemoveClause"),
      labels: {
        event: L("Event"), scope: L("Scope"), range: L("Range"),
        qualifiers: L("Qualifiers"), qualifiersNone: L("QualifiersNone"),
        damageTypes: L("DamageTypes"), condition: L("Condition"), conditionAny: L("ConditionAny"),
        abilityDsid: L("AbilityDsid"), groupName: L("GroupName"), groupNone: L("GroupNone"),
        customPh: L("CustomPh"), customEllipsis: L("CustomEllipsis"),
        edgeRequired: L("EdgeRequired"), ownerUnacted: L("OwnerUnacted"), anyHeroUnacted: L("AnyHeroUnacted"), turnLock: L("TurnLock"),
        availability: L("Availability"),
        holdDamage: L("HoldDamage"), targetedHalf: L("TargetedHalf"), excludeSelfTarget: L("ExcludeSelfTarget"),
        postRoll: L("PostRoll"), halfOnUse: L("HalfOnUse"), rollMod: L("RollMod"), redirect: L("Redirect"),
        effectsHeader: L("EffectsHeader"),
        addClause: L("AddClause"), malice: L("Malice"), save: L("Save"), reset: L("Reset"),
      },
      hints: {
        scope: L("ScopeHint"), range: L("RangeHint"), qualifiers: L("QualifiersHint"),
        damageTypes: L("DamageTypesHint"), condition: L("ConditionHint"), abilityDsid: L("AbilityDsidHint"),
        groupName: L("GroupNameHint"), checks: L("ChecksHint"), malice: L("MaliceHint"),
        holdDamage: L("HoldDamageHint"), targetedHalf: L("TargetedHalfHint"), excludeSelfTarget: L("ExcludeSelfTargetHint"),
        postRoll: L("PostRollHint"), halfOnUse: L("HalfOnUseHint"), rollMod: L("RollModHint"), redirect: L("RedirectHint"),
        save: L("SaveHint"), reset: L("ResetHint"),
      },
      clauses: this._clauses.map((c, index) => ({
        index,
        legend: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: index + 1 }),
        eventGroups: EVENT_GROUPS.map(([key, list]) => ({
          label: L(`EventGroup${key}`),
          options: list.map((e) => ({
            value: e, label: label(e),
            selected: e === (c.event === "WOULD_TAKE_DAMAGE" ? "TAKES_DAMAGE" : c.event),
          })),
        })),
        eventHint: game.i18n.localize(`DS_TRIGGERS.Editor.EventDesc.${c.event === "WOULD_TAKE_DAMAGE" ? "TAKES_DAMAGE" : c.event}`),
        scopeOptions: SCOPES.map((s) => ({ value: s, label: label(s), selected: s === c.scope })),
        rangeOptions: [
          ["auto", L("RangeAuto")], ["none", L("RangeNone")], ["custom", L("RangeCustom")],
        ].map(([value, optLabel]) => ({
          value, label: optLabel,
          selected: (c.range === "none" ? "none" : Number.isFinite(c.range) ? "custom" : "auto") === value,
        })),
        rangeCustom: Number.isFinite(c.range),
        rangeValue: Number.isFinite(c.range) ? c.range : 1,
        qualifiers: qualifierPills(c, this._triggerText, this._effectText, this._pristine?.[index]),
        showDamageTypes: DAMAGE_EVENTS.has(c.event),
        showCondition: c.event === "CONDITION_GAIN",
        conditionOptions: [...new Set([...CONDITIONS, ...(c.condition ? [c.condition] : [])])]
          .map((value) => ({ value, label: conditionLabel(value), selected: c.condition === value })),
        showHold: c.event === "TAKES_DAMAGE" || c.event === "WOULD_TAKE_DAMAGE",
        holdChecked: c.event === "WOULD_TAKE_DAMAGE",
        showTargetedHalf: TARGETING_EVENTS.has(c.event),
        targetedHalf: !!c.targetedHalf,
        excludeSelfTarget: !!c.excludeSelfTarget,
        showPostRoll: TARGETING_EVENTS.has(c.event),
        showRollMod: ROLL_MOD_EVENTS.has(c.event),
        showEffects: TARGETING_EVENTS.has(c.event) || ROLL_MOD_EVENTS.has(c.event)
          || c.event === "TAKES_DAMAGE" || c.event === "WOULD_TAKE_DAMAGE",
        showHalfOnUse: TARGETING_EVENTS.has(c.event) && !!c.postRoll,
        postRoll: !!c.postRoll,
        halfOnUse: !!c.halfOnUse,
        rollModOptions: [
          ["", L("RollModNone")], ["banes1", L("RollModBane")], ["banes2", L("RollModDoubleBane")],
          ["edges1", L("RollModEdge")], ["edges2", L("RollModDoubleEdge")],
        ].map(([value, optLabel]) => ({ value, label: optLabel, selected: _rollModValue(c.rollMod) === value })),
        redirectOptions: [
          ["", L("RedirectNone")], ["self", L("RedirectSelf")], ["reflect", L("RedirectReflect")],
          ["chooser", L("RedirectChooser")], ["swap", L("RedirectSwap")], ["after", L("RedirectAfter")],
        ].map(([value, optLabel]) => ({ value, label: optLabel, selected: (c.redirect ?? "") === value })),
        showGroup: c.scope === "GROUP",
        damageTypeOptions: damageTypes.map((d) => ({ ...d, active: (c.damageTypes ?? []).includes(d.value) })),
        groupOptions: keywords.map((k) => ({ ...k, active: c.groupName === k.value })),
        customOptions: (c._customs ?? []).filter(Boolean).map((value) => ({
          value, active: c.groupName === value,
        })),
        customPending: !!c._customPending,
        abilityDsid: c.abilityDsid ?? "",
        edgeRequired: !!c.edgeRequired,
        ownerUnacted: !!c.ownerUnacted,
        anyHeroUnacted: !!c.anyHeroUnacted,
        turnLock: !!c.turnLock,
        turnEvent: c.event === "TURN_START" || c.event === "TURN_END",
      })),
      maliceOptions: [
        { value: "default", label: L("MaliceDefault"), selected: this._malice === undefined },
        { value: "true", label: L("MaliceAlways"), selected: this._malice === true },
        { value: "false", label: L("MaliceNever"), selected: this._malice === false },
      ],
    };
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

  _onRender(_context, _options) {
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
        for (const old of this.element.querySelectorAll(".dst-flash")) old.classList.remove("dst-flash");
        const indexes = String(ttPill.dataset.indexes ?? ttPill.dataset.index).split(",").map(Number);
        indexes.forEach((index, i) => this._flashControl(index, ttPill.dataset.field, ttPill.textContent.trim(), { scroll: i === 0 }));
        return;
      }
      const pill = event.target.closest("[data-qual-toggle]");
      if (!pill) return;
      event.preventDefault();
      this._syncFromDOM();
      const clause = this._clauses[Number(pill.dataset.index)];
      if (!clause) return;

      const id = pill.dataset.qualToggle;
      if (!id) return;
      const off = new Set(clause.filtersOff ?? []);
      if (off.has(id)) off.delete(id);
      else off.add(id);
      if (off.size) clause.filtersOff = [...off];
      else delete clause.filtersOff;
      this._applyFilters(clause);
      this.render();
    }, { signal });

    el.addEventListener("change", (event) => {
      const eventSel = event.target.closest('select[data-field="event"]');
      if (eventSel) {
        const clauseEl = eventSel.closest(".dst-editor-clause");
        const wrap = clauseEl?.querySelector(".dst-damage-wrap");
        if (wrap) wrap.hidden = !DAMAGE_EVENTS.has(eventSel.value);
        const conditionWrap = clauseEl?.querySelector(".dst-condition-wrap");
        if (conditionWrap) conditionWrap.hidden = eventSel.value !== "CONDITION_GAIN";
        const desc = clauseEl?.querySelector(".dst-event-desc");
        if (desc) desc.textContent = game.i18n.localize(`DS_TRIGGERS.Editor.EventDesc.${eventSel.value}`);
        const holdWrap = clauseEl?.querySelector(".dst-hold-wrap");
        if (holdWrap) holdWrap.hidden = eventSel.value !== "TAKES_DAMAGE";
        const targeting = TARGETING_EVENTS.has(eventSel.value);
        const rollMod = ROLL_MOD_EVENTS.has(eventSel.value);
        const halfWrap = clauseEl?.querySelector(".dst-half-wrap");
        if (halfWrap) halfWrap.hidden = !targeting;
        const exclWrap = clauseEl?.querySelector(".dst-exclself-wrap");
        if (exclWrap) exclWrap.hidden = !targeting;
        const postRollWrap = clauseEl?.querySelector(".dst-postroll-wrap");
        if (postRollWrap) postRollWrap.hidden = !targeting;
        const redirectWrap = clauseEl?.querySelector(".dst-redirect-wrap");
        if (redirectWrap) redirectWrap.hidden = !targeting;
        const rollModWrap = clauseEl?.querySelector(".dst-rollmod-wrap");
        if (rollModWrap) rollModWrap.hidden = !rollMod;
        const holdable = eventSel.value === "TAKES_DAMAGE";
        const effectsHeader = clauseEl?.querySelector(".dst-effects-header");
        if (effectsHeader) effectsHeader.hidden = !targeting && !rollMod && !holdable;
        const sub = clauseEl?.querySelector(".dst-postroll-sub");
        if (sub) sub.hidden = !targeting || !clauseEl?.querySelector('input[data-field="postRoll"]')?.checked;
        return;
      }
      const postRollToggle = event.target.closest('input[data-field="postRoll"]');
      if (postRollToggle) {
        const sub = postRollToggle.closest(".dst-editor-clause")?.querySelector(".dst-postroll-sub");
        if (sub) sub.hidden = !postRollToggle.checked;
        return;
      }
      const rangeSel = event.target.closest('select[data-field="rangeSelect"]');
      if (rangeSel) {
        const input = rangeSel.closest(".form-fields")?.querySelector('input[data-field="rangeValue"]');
        if (input) input.hidden = rangeSel.value !== "custom";
        return;
      }
      const scopeSel = event.target.closest('select[data-field="scope"]');
      if (scopeSel) {
        const wrap = scopeSel.closest(".dst-editor-clause")?.querySelector(".dst-group-wrap");
        if (wrap) wrap.hidden = scopeSel.value !== "GROUP";
        return;
      }
      const select = event.target.closest('select[data-field="groupSelect"]');
      if (select) {
        const clause = this._clauses[Number(select.dataset.index)];
        if (select.value === "__custom__") {
          this._syncFromDOM();
          clause._customPending = true;
          this.render();
        }
        return;
      }
      const input = event.target.closest(".dst-custom-input");
      if (input) {
        const value = input.value.trim();
        this._syncFromDOM();
        const clause = this._clauses[Number(input.dataset.index)];
        clause._customPending = false;
        if (value) {
          if (!clause._customs.includes(value)) clause._customs.push(value);
          clause.groupName = value;
        }
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
      "abilityCostScales", "abilityTargetCount", "abilityTargetSide", "abilityPotency"]) delete clause[k];

    for (const f of clause.event === "USES_ABILITY" ? explainAbilityFilters(this._triggerText, this._effectText) : []) {
      if (!off.has(f.id)) Object.assign(clause, f.fields);
    }

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
    for (const input of el.querySelectorAll("[data-field][data-index]")) {
      
      
      if (input.localName === "multi-select" || input.dataset.field === "groupSelect"
        || input.dataset.field === "rollModSelect" || input.dataset.field === "redirectSelect"
        || input.dataset.field === "rangeSelect" || input.dataset.field === "rangeValue") continue;
      const clause = this._clauses[Number(input.dataset.index)];
      if (!clause) continue;
      const field = input.dataset.field;
      if (input.type === "checkbox") {
        if (input.checked) clause[field] = true;
        else delete clause[field];
      } else if (field === "event" || field === "scope") {
        clause[field] = input.value;
      } else {
        if (input.value.trim()) clause[field] = input.value.trim();
        else delete clause[field];
      }
    }
    
    
    for (const box of el.querySelectorAll("input[data-hold-toggle]")) {
      const clause = this._clauses[Number(box.dataset.index)];
      if (!clause) continue;
      if (clause.event === "TAKES_DAMAGE" && box.checked) clause.event = "WOULD_TAKE_DAMAGE";
      else if (clause.event === "WOULD_TAKE_DAMAGE" && !box.checked) clause.event = "TAKES_DAMAGE";
    }
    for (const ms of el.querySelectorAll('multi-select[data-field="damageTypes"]')) {
      const clause = this._clauses[Number(ms.dataset.index)];
      if (!clause) continue;
      const value = Array.from(ms.value ?? []);
      if (value.length) clause.damageTypes = value;
      else delete clause.damageTypes;
    }
    for (const select of el.querySelectorAll('select[data-field="rollModSelect"]')) {
      const clause = this._clauses[Number(select.dataset.index)];
      if (!clause) continue;
      const mod = ROLL_MOD_VALUES[select.value] ?? null;
      if (mod) clause.rollMod = { ...mod };
      else delete clause.rollMod;
    }
    for (const select of el.querySelectorAll('select[data-field="rangeSelect"]')) {
      const clause = this._clauses[Number(select.dataset.index)];
      if (!clause) continue;
      if (select.value === "none") clause.range = "none";
      else if (select.value === "custom") {
        const input = select.closest(".form-fields")?.querySelector('input[data-field="rangeValue"]');
        clause.range = Math.max(1, Math.floor(Number(input?.value) || 1));
      } else delete clause.range;
    }
    for (const select of el.querySelectorAll('select[data-field="redirectSelect"]')) {
      const clause = this._clauses[Number(select.dataset.index)];
      if (!clause) continue;
      if (select.value) clause.redirect = select.value;
      else delete clause.redirect;
    }
    for (const select of el.querySelectorAll('select[data-field="groupSelect"]')) {
      const clause = this._clauses[Number(select.dataset.index)];
      if (!clause) continue;
      if (select.value === "__custom__") continue;
      if (select.value) clause.groupName = select.value;
      else delete clause.groupName;
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
      if (amount?.value.trim()) this._line.amount = amount.value.trim().replace(/s+/g, "");
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
      if (!TARGETING_EVENTS.has(out.event)) {
        delete out.targetedHalf;
        delete out.postRoll;
        delete out.halfOnUse;
        delete out.redirect;
        delete out.excludeSelfTarget;
      }
      if (!ROLL_MOD_EVENTS.has(out.event)) delete out.rollMod;
      if (out.event !== "DEALS_DAMAGE") delete out.victimScope;
      if (out.event !== "TAKES_DAMAGE" && !TARGETING_EVENTS.has(out.event)) delete out.dealerScope;
      if (!out.postRoll) delete out.halfOnUse;
      return out;
    });
  }

  static #onAddClause() {
    this._syncFromDOM();
    this._clauses.push({ event: "UNKNOWN", scope: "SELF", qualifiers: [], _customs: [] });
    this.render();
  }

  static #onRemoveClause(_event, target) {
    this._syncFromDOM();
    this._clauses.splice(Number(target.dataset.index), 1);
    if (!this._clauses.length) this._clauses.push({ event: "UNKNOWN", scope: "SELF", qualifiers: [], _customs: [] });
    this.render();
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
      effect: line.effect ? line.effect[0].toUpperCase() + line.effect.slice(1) : "",
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
      labels: { name: F("Name"), enabled: F("Enabled"), action: F("Action"), once: F("Once"), effect: F("Effect"), ignore: F("Ignore") },
    };
  }

  _shownName() {
    const line = this._line;
    if (line.customName) return line.customName;
    if (this._lineType === "feature") return line.name ?? this.item.name;
    return namedGainLines(this.item.actor).find((e) => e.line.key === line.key)?.line.name ?? line.trigger ?? this.item.name;
  }

  _gainContext() {
    const line = this._line;
    const saved = this.item.getFlag(MODULE_ID, `gainLines.${line.key}`)?.name ?? "";
    line.customName ??= saved || null;
    const folded = this.item.actor ? heroGainLines(this.item.actor).find((e) => e.line.key === line.key)?.line : null;
    const gates = (line.gates ?? []).map((id) => game.i18n.localize(`DS_TRIGGERS.Gain.Gate.${id}`));
    return {
      legend: game.i18n.localize("DS_TRIGGERS.Gain.Legend"),
      sentence: line.sentence,
      name: line.customName ?? "",
      namePlaceholder: line.customName ? "" : this._shownName(),
      enabled: !!line.enabled,
      amount: line.amount,
      manualWhy: line.manual?.length ? game.i18n.format("DS_TRIGGERS.Gain.ManualWhy", { why: line.manual.join(", ") }) : "",
      checks: gates.length ? game.i18n.format("DS_TRIGGERS.Gain.Checks", { list: gates.join(", ") }) : "",
      upgradedBy: folded?.upgradedBy ? game.i18n.format("DS_TRIGGERS.Gain.Upgraded", { amount: folded.amount, name: folded.upgradedBy }) : "",
      onceOptions: [["round", "OnceRound"], ["encounter", "OnceEncounter"], ["", "OnceNone"]].map(([value, key]) => ({
        value, label: game.i18n.localize(`DS_TRIGGERS.Gain.${key}`), selected: (line.once ?? "") === value,
      })),
      labels: {
        name: game.i18n.localize("DS_TRIGGERS.Gain.Name"),
        enabled: game.i18n.localize("DS_TRIGGERS.Gain.Enabled"),
        amount: game.i18n.localize("DS_TRIGGERS.Gain.Amount"),
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
