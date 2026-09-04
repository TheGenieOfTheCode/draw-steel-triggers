import { MODULE_ID } from "../util.mjs";
import { getParsedTrigger, clearParseCache, isMaliceAbility, isImplicitMaliceTrigger, isTriggeredAbility } from "../triggers/registry.mjs";

const EVENT_GROUPS = [
  ["Common", [
    "TAKES_DAMAGE", "WOULD_TAKE_DAMAGE", "DEALS_DAMAGE", "DIES", "WINDED_OR_DYING",
    "TARGETED_BY_STRIKE", "MAKES_STRIKE", "POWER_ROLL", "MOVES", "FORCE_MOVED",
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
        event: L("Event"), scope: L("Scope"),
        qualifiers: L("Qualifiers"), qualifiersPh: L("QualifiersPh"),
        damageTypes: L("DamageTypes"),
        abilityDsid: L("AbilityDsid"), groupName: L("GroupName"), groupNone: L("GroupNone"),
        customPh: L("CustomPh"), customEllipsis: L("CustomEllipsis"),
        edgeRequired: L("EdgeRequired"), ownerUnacted: L("OwnerUnacted"), anyHeroUnacted: L("AnyHeroUnacted"),
        availability: L("Availability"),
        holdDamage: L("HoldDamage"), targetedHalf: L("TargetedHalf"),
        addClause: L("AddClause"), malice: L("Malice"), save: L("Save"), reset: L("Reset"),
      },
      hints: {
        scope: L("ScopeHint"), qualifiers: L("QualifiersHint"),
        damageTypes: L("DamageTypesHint"), abilityDsid: L("AbilityDsidHint"),
        groupName: L("GroupNameHint"), checks: L("ChecksHint"), malice: L("MaliceHint"),
        holdDamage: L("HoldDamageHint"), targetedHalf: L("TargetedHalfHint"),
        save: L("SaveHint"), reset: L("ResetHint"),
      },
      clauses: this._clauses.map((c, index) => ({
        index,
        legend: game.i18n.format("DS_TRIGGERS.Editor.ClauseLegend", { n: index + 1 }),
        eventGroups: EVENT_GROUPS.map(([key, list]) => ({
          label: L(`EventGroup${key}`),
          options: list.map((e) => ({ value: e, label: label(e), selected: e === c.event })),
        })),
        eventHint: game.i18n.localize(`DS_TRIGGERS.Editor.EventDesc.${c.event}`),
        scopeOptions: SCOPES.map((s) => ({ value: s, label: label(s), selected: s === c.scope })),
        qualifiers: (c.qualifiers ?? []).join(", "),
        showDamageTypes: DAMAGE_EVENTS.has(c.event),
        showHold: c.event === "TAKES_DAMAGE" || c.event === "WOULD_TAKE_DAMAGE",
        holdChecked: c.event === "WOULD_TAKE_DAMAGE",
        showTargetedHalf: c.event === "TARGETED_BY_STRIKE",
        targetedHalf: !!c.targetedHalf,
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

    el.addEventListener("change", (event) => {
      const eventSel = event.target.closest('select[data-field="event"]');
      if (eventSel) {
        const clauseEl = eventSel.closest(".dst-editor-clause");
        const wrap = clauseEl?.querySelector(".dst-damage-wrap");
        if (wrap) wrap.hidden = !DAMAGE_EVENTS.has(eventSel.value);
        const desc = clauseEl?.querySelector(".dst-event-desc");
        if (desc) desc.textContent = game.i18n.localize(`DS_TRIGGERS.Editor.EventDesc.${eventSel.value}`);
        const holdWrap = clauseEl?.querySelector(".dst-hold-wrap");
        if (holdWrap) {
          holdWrap.hidden = eventSel.value !== "TAKES_DAMAGE" && eventSel.value !== "WOULD_TAKE_DAMAGE";
          const box = holdWrap.querySelector("input");
          if (box) box.checked = eventSel.value === "WOULD_TAKE_DAMAGE";
        }
        const halfWrap = clauseEl?.querySelector(".dst-half-wrap");
        if (halfWrap) halfWrap.hidden = eventSel.value !== "TARGETED_BY_STRIKE";
        return;
      }
      const holdToggle = event.target.closest("input[data-hold-toggle]");
      if (holdToggle) {
        
        const sel = holdToggle.closest(".dst-editor-clause")?.querySelector('select[data-field="event"]');
        if (sel) {
          sel.value = holdToggle.checked ? "WOULD_TAKE_DAMAGE" : "TAKES_DAMAGE";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
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

  _syncFromDOM() {
    const el = this.element;
    for (const input of el.querySelectorAll("[data-field][data-index]")) {
      
      
      if (input.localName === "multi-select" || input.dataset.field === "groupSelect") continue;
      const clause = this._clauses[Number(input.dataset.index)];
      if (!clause) continue;
      const field = input.dataset.field;
      if (input.type === "checkbox") {
        if (input.checked) clause[field] = true;
        else delete clause[field];
      } else if (field === "qualifiers") {
        const list = input.value.split(",").map((s) => s.trim()).filter(Boolean);
        if (list.length) clause[field] = list;
        else delete clause[field];
      } else if (field === "event" || field === "scope") {
        clause[field] = input.value;
      } else {
        if (input.value.trim()) clause[field] = input.value.trim();
        else delete clause[field];
      }
    }
    for (const ms of el.querySelectorAll('multi-select[data-field="damageTypes"]')) {
      const clause = this._clauses[Number(ms.dataset.index)];
      if (!clause) continue;
      const value = Array.from(ms.value ?? []);
      if (value.length) clause.damageTypes = value;
      else delete clause.damageTypes;
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
      if (out.event !== "TARGETED_BY_STRIKE") delete out.targetedHalf;
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
