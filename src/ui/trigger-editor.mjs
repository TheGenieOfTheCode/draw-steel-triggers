import { MODULE_ID } from "../util.mjs";
import { getParsedTrigger, clearParseCache, isMaliceAbility, isImplicitMaliceTrigger, isTriggeredAbility, triggerEffectText } from "../triggers/registry.mjs";
import { explainAbilityFilters, explainClauseFlags } from "../parser/trigger-parser.mjs";

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
};

function describeFilter(id, fields) {
  switch (id) {
    case "range": return L("QualEffectRange", { n: fields.range });
    case "abilityType": return L("QualEffectType", { type: fields.abilityType });
    case "abilityCostMax": return L("QualEffectCost", { n: fields.abilityCostMax });
    case "abilityCategory": return L(fields.abilityCategory === "heroic" ? "QualEffectHeroic" : "QualEffectNonHeroic");
    case "abilityCostScales": return L("QualEffectScales");
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
    default: return L("QualEffectNone");
  }
}

function qualifierPills(clause, item) {
  const off = new Set(clause.filtersOff ?? []);
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

  for (const f of explainAbilityFilters(item?.system?.trigger ?? "", item ? triggerEffectText(item) : "")) {
    pills.push({
      id: f.id, text: f.fragment,
      tooltip: describeFilter(f.id, f.fields) + (f.from === "effect" ? ` ${L("QualFromEffect")}` : ""),
      enforced: true, disabled: off.has(f.id), fromEffect: f.from === "effect",
    });
    consumed.push(f.fragment);
  }

  
  for (const f of explainClauseFlags(clause, item?.system?.trigger ?? "", item ? triggerEffectText(item) : "")) {
    pills.push({
      id: f.id, text: f.fragment,
      tooltip: describeFilter(f.id, clause) + (f.from === "effect" ? ` ${L("QualFromEffect")}` : ""),
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
    "EFFECT_ENDS", "SAVING_THROW", "REGAINS_STAMINA", "MARKED",
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
    },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/trigger-editor.hbs` },
  };

  constructor(item, options = {}) {
    super(options);
    this.item = item;
    const parse = getParsedTrigger(item);
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
    return game.i18n.format("DS_TRIGGERS.Editor.Title", { name: this.item.name });
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(`DS_TRIGGERS.Editor.${k}`);
    const keywords = Object.entries(ds.CONFIG.monsters?.keywords ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const damageTypes = Object.entries(ds.CONFIG.damageTypes ?? {})
      .map(([value, cfg]) => ({ value, label: game.i18n.localize(cfg.label ?? value) }));
    return {
      triggerText: this.item.system.trigger ?? "",
      noTriggerText: L("NoTriggerText"),
      statusLine: game.i18n.format("DS_TRIGGERS.Editor.Status", {
        source: this._source, confidence: this._confidence || "n/a",
      }),
      isManual: !!this.item.getFlag(MODULE_ID, "manual"),
      removeTooltip: L("RemoveClause"),
      labels: {
        event: L("Event"), scope: L("Scope"), range: L("Range"),
        qualifiers: L("Qualifiers"), qualifiersNone: L("QualifiersNone"),
        damageTypes: L("DamageTypes"),
        abilityDsid: L("AbilityDsid"), groupName: L("GroupName"), groupNone: L("GroupNone"),
        customPh: L("CustomPh"), customEllipsis: L("CustomEllipsis"),
        edgeRequired: L("EdgeRequired"), ownerUnacted: L("OwnerUnacted"), anyHeroUnacted: L("AnyHeroUnacted"),
        availability: L("Availability"),
        holdDamage: L("HoldDamage"), targetedHalf: L("TargetedHalf"), excludeSelfTarget: L("ExcludeSelfTarget"),
        postRoll: L("PostRoll"), halfOnUse: L("HalfOnUse"), rollMod: L("RollMod"), redirect: L("Redirect"),
        effectsHeader: L("EffectsHeader"),
        addClause: L("AddClause"), malice: L("Malice"), save: L("Save"), reset: L("Reset"),
      },
      hints: {
        scope: L("ScopeHint"), range: L("RangeHint"), qualifiers: L("QualifiersHint"),
        damageTypes: L("DamageTypesHint"), abilityDsid: L("AbilityDsidHint"),
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
        qualifiers: qualifierPills(c, this.item),
        showDamageTypes: DAMAGE_EVENTS.has(c.event),
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
      })),
      maliceOptions: [
        { value: "default", label: L("MaliceDefault"), selected: this._malice === undefined },
        { value: "true", label: L("MaliceAlways"), selected: this._malice === true },
        { value: "false", label: L("MaliceNever"), selected: this._malice === false },
      ],
    };
  }

  _onRender(_context, _options) {
    const titleEl = this.element.querySelector(".window-header .window-title");
    if (titleEl) titleEl.innerHTML = `<img class="dst-window-emblem" src="modules/${MODULE_ID}/icons/emblem.svg" alt="">${this.title}`;
    this._listenerAbort?.abort();
    this._listenerAbort = new AbortController();
    const { signal } = this._listenerAbort;
    const el = this.element;

    
    el.addEventListener("click", (event) => {
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
    for (const k of ["abilityDsid", "abilityType", "abilityCostMax", "abilityCategory",
      "abilityCostScales", "abilityTargetCount", "abilityTargetSide"]) delete clause[k];

    for (const f of explainAbilityFilters(this.item?.system?.trigger ?? "", this.item ? triggerEffectText(this.item) : "")) {
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

  static async #onSaveOverride() {
    this._syncFromDOM();
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

  static async #onResetParser() {
    this._syncFromDOM();
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
