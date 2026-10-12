import { MODULE_ID } from "../util.mjs";
import { QUALIFIERS, QUALIFIER_GROUPS, qualifierById, readSettings, formValue, parseFormValue, ruleFits, qualifierFits, CONDITIONS } from "./qualifier-library.mjs";

const L = (k, data) => data
  ? game.i18n.format(`DS_TRIGGERS.Qualifier.${k}`, data)
  : game.i18n.localize(`DS_TRIGGERS.Qualifier.${k}`);
const has = (k) => game.i18n.has(`DS_TRIGGERS.Qualifier.${k}`);

export const eventLabel = (e) => String(e).replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export const conditionLabel = (id) => {
  const status = Array.isArray(CONFIG.statusEffects) ? CONFIG.statusEffects.find((s) => s.id === id) : CONFIG.statusEffects?.[id];
  return status?.name ? game.i18n.localize(status.name) : eventLabel(id);
};

export function optionLabel(rule, value) {
  const v = String(value);
  if (rule.key === "victimCondition" || rule.key === "ownerLacks" || rule.key === "condition") return conditionLabel(v);
  if (rule.key === "damageTypes") return game.i18n.localize(ds.CONFIG.damageTypes?.[v]?.label ?? v);
  if (rule.key === "abilityKeywords") return game.i18n.localize(ds.CONFIG.abilities?.keywords?.[v]?.label ?? v);
  if (rule.key === "abilityType") return game.i18n.localize(ds.CONFIG.abilities?.types?.[v]?.label ?? v);
  if (rule.key === "organization") return game.i18n.localize(ds.CONFIG.monsters?.organizations?.[v]?.label ?? eventLabel(v));
  const scoped = `Option.${rule.key}.${v}`;
  if (has(scoped)) return L(scoped);
  if (has(`Option.${v}`)) return L(`Option.${v}`);
  return eventLabel(v);
}

function ruleOptions(rule) {
  if (rule.input === "keywords") return Object.keys(ds.CONFIG.abilities?.keywords ?? {});
  if (rule.input === "damageTypes") return Object.keys(ds.CONFIG.damageTypes ?? {});
  if (rule.input === "abilityType") return Object.keys(ds.CONFIG.abilities?.types ?? {});
  return typeof rule.options === "function" ? rule.options() : [];
}

let _abilityIndex = null;
export async function compendiumAbilities() {
  if (_abilityIndex) return _abilityIndex;
  const seen = new Map();
  for (const pack of game.packs) {
    if (pack.documentName !== "Item") continue;
    const index = await pack.getIndex({ fields: ["system._dsid", "type"] }).catch(() => null);
    for (const e of index ?? []) {
      if (!["ability", "feature", "treasure", "perk", "ancestryTrait", "complication"].includes(e.type)) continue;
      const dsid = e.system?._dsid;
      if (dsid && !seen.has(dsid)) seen.set(dsid, e.name);
    }
  }
  _abilityIndex = [...seen].map(([value, name]) => ({ value, label: name })).sort((a, b) => a.label.localeCompare(b.label));
  return _abilityIndex;
}

const BLANK_EFFECT = () => ({ on: "subject", has: true, kind: "condition", value: "bleeding", by: "anyone" });

export class QualifierPicker extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-qualifier-picker",
    classes: ["draw-steel", "dst-qualifier-picker"],
    window: { minimizable: false, resizable: true, title: "DS_TRIGGERS.Qualifier.WindowTitle" },
    position: { width: 520, height: "auto" },
    form: { handler: null, closeOnSubmit: false, submitOnChange: false },
    actions: {
      apply: QualifierPicker.#onApply,
      remove: QualifierPicker.#onRemove,
      cancel: QualifierPicker.#onCancel,
      addEffect: QualifierPicker.#onAddEffect,
      removeEffect: QualifierPicker.#onRemoveEffect,
    },
  };

  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/trigger-editor/qualifier-picker.hbs` } };

  constructor({ clause, event, qualifierId = null, provenance = {}, onApply, onRemove } = {}) {
    super({});
    this.clause = clause;
    this.event = event;
    this.editing = !!qualifierId;
    this.qualifierId = qualifierId ?? (QUALIFIERS.find((q) => qualifierFits(q, event)) ?? QUALIFIERS[0]).id;
    this.provenance = provenance;
    this.onApplyCb = onApply;
    this.onRemoveCb = onRemove;
    this._loadSettings();
  }

  _loadSettings() {
    const q = qualifierById(this.qualifierId);
    this.settings = readSettings(q, this.clause);
    this._effects = foundry.utils.deepClone(this.settings.effects ?? []);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const q = qualifierById(this.qualifierId);
    const abilityList = await compendiumAbilities();
    this._lists = {
      abilities: abilityList,
      keywords: Object.entries(ds.CONFIG.monsters?.keywords ?? {}).map(([v, cfg]) => ({ value: v, label: game.i18n.localize(cfg.label ?? v) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
    const display = (list, value) => this._lists[list].find((o) => o.value === value)?.label ?? value ?? "";
    const groups = QUALIFIER_GROUPS.map((g) => ({
      label: L(`Group.${g}`),
      options: QUALIFIERS.filter((x) => x.group === g).map((x) => ({
        value: x.id, label: L(`${x.id}.Label`), selected: x.id === q.id, fits: qualifierFits(x, this.event),
      })),
    })).filter((g) => g.options.length);

    const rules = q.rules.map((rule) => {
      const fits = ruleFits(rule, this.event);
      const value = formValue(rule, this.settings[rule.key]);
      const locked = !!rule.lockedBy && this.clause[rule.lockedBy] !== undefined;
      const prov = this.settings[rule.key] !== undefined ? this.provenance[rule.key] : null;
      const out = {
        key: rule.key, kind: rule.kind, fits, locked, value,
        label: L(`${q.id}.Rule.${rule.key}`),
        note: locked ? L("LockedGroups") : !fits ? L("NeedsEvents", { events: rule.events.map(eventLabel).join(", ") }) : "",
        provenance: prov, provenanceLabel: prov ? L(`Source.${prov}`) : "", provenanceHint: prov ? L(`SourceHint.${prov}`) : "",
        isCheck: rule.kind === "check", isNumber: rule.kind === "number", isText: rule.kind === "text",
        isSelect: rule.kind === "select", isMulti: rule.kind === "multi",
        isOwnerEffect: rule.kind === "ownerEffect", isEffects: rule.kind === "effects",
      };
      if (out.isSelect || out.isMulti) {
        const chosen = new Set([].concat(value ?? []).map(String));
        out.options = ruleOptions(rule).map((o) => ({ value: String(o), label: optionLabel(rule, o), selected: chosen.has(String(o)) }));
      }
      if (rule.input === "ability") Object.assign(out, { combo: "abilities", display: display("abilities", value), placeholder: L("AbilityPh") });
      if (rule.input === "keyword") Object.assign(out, { combo: "keywords", display: display("keywords", value), placeholder: L("KeywordPh") });
      if (out.isOwnerEffect) {
        out.onOptions = ["", "victim", "dealer"].map((v) => ({ value: v, label: L(`Option.ownerEffectOn.${v || "subject"}`), selected: (value?.on ?? "") === v }));
      }
      if (out.isEffects) out.value = this._effects.map((e) => ({ ...this._effectRow(e), display: e.kind === "ability" ? display("abilities", e.value) : e.value }));
      return out;
    });

    return {
      ...context,
      editing: this.editing,
      groups,
      current: {
        description: L(`${q.id}.Hint`),
        examples: has(`${q.id}.Examples`) ? L(`${q.id}.Examples`) : "",
        unchecked: !!q.unchecked,
        fits: qualifierFits(q, this.event),
        misfit: L("Misfit", { event: eventLabel(this.event) }),
        rules,
      },
      canApply: qualifierFits(q, this.event),
      labels: {
        qualifier: L("Pick"), examples: L("ExamplesLabel"), settings: L("Settings"), none: L("None"),
        notThisEvent: L("NotThisEvent"), unchecked: L("Unchecked"), apply: L("Apply"), remove: L("Remove"), cancel: L("Cancel"),
        addEffect: L("AddEffect"), removeEffect: L("RemoveEffect"), effectLabelPh: L("EffectLabelPh"),
      },
    };
  }

  _effectRow(e) {
    const opt = (list, cur, prefix) => list.map((v) => ({ value: String(v), label: L(`${prefix}.${v}`), selected: String(cur) === String(v) }));
    return {
      onOptions: opt(["subject", "victim", "dealer", "through", "owner"], e.on, "Effect.on"),
      hasOptions: opt(["true", "false"], String(e.has !== false), "Effect.has"),
      kindOptions: opt(["condition", "ability", "name", "mark"], e.kind, "Effect.kind"),
      byOptions: opt(["anyone", "self", "ALLY", "ENEMY", "FRIENDLY", "NEUTRAL", "HOSTILE", "SECRET"], e.by ?? "anyone", "Effect.by"),
      isCondition: e.kind === "condition" || e.kind === "mark",
      valueOptions: (e.kind === "mark" ? ["insubstantial"] : CONDITIONS).map((v) => ({
        value: v, label: e.kind === "mark" ? L(`Effect.mark.${v}`) : conditionLabel(v), selected: e.value === v,
      })),
      value: e.value ?? "",
      combo: e.kind === "ability" ? "abilities" : null,
      placeholder: e.kind === "ability" ? L("AbilityPh") : L("EffectNamePh"),
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    this._abort?.abort();
    this._abort = new AbortController();
    const { signal } = this._abort;
    this._wireCombos(signal);
    this.element.addEventListener("change", (event) => {
      const t = event.target;
      if (t.name === "qualifier") {
        this.qualifierId = t.value;
        this._loadSettings();
        this.render();
      } else if (t.matches?.("[data-rerender]")) {
        this._syncEffects();
        const i = Number(t.closest("[data-effect-index]")?.dataset.effectIndex);
        if (this._effects[i]) this._effects[i].value = this._effects[i].kind === "condition" ? "bleeding" : this._effects[i].kind === "mark" ? "insubstantial" : "";
        this.render();
      }
    }, { signal });
  }

  _wireCombos(signal) {
    for (const box of this.element.querySelectorAll(".dst-combo")) {
      const text = box.querySelector(".dst-combo-text");
      const hidden = box.querySelector("input[type=hidden]");
      const list = box.querySelector(".dst-combo-list");
      const options = this._lists?.[box.dataset.combo] ?? [];
      let shown = [];
      let active = -1;
      const mark = () => list.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === active));
      const show = () => {
        const q = text.value.trim().toLowerCase();
        const rank = (o) => {
          const name = o.label.toLowerCase();
          if (!q || name.startsWith(q)) return 0;
          if (name.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 1;
          if (name.includes(q)) return 2;
          return o.value.toLowerCase().includes(q) ? 3 : 9;
        };
        shown = options.map((o) => ({ o, r: rank(o) })).filter((x) => x.r < 9)
          .sort((a, b) => a.r - b.r || a.o.label.localeCompare(b.o.label)).slice(0, 80).map((x) => x.o);
        list.replaceChildren(...shown.map((o) => {
          const li = document.createElement("li");
          li.dataset.value = o.value;
          li.setAttribute("role", "option");
          const name = document.createElement("span");
          name.textContent = o.label;
          const id = document.createElement("small");
          id.textContent = o.value;
          li.append(name, id);
          return li;
        }));
        list.hidden = !shown.length;
        active = -1;
      };
      const choose = (o) => {
        if (!o) return;
        text.value = o.label;
        hidden.value = o.value;
        list.hidden = true;
      };
      const settle = () => {
        const q = text.value.trim().toLowerCase();
        const hit = options.find((o) => o.label.toLowerCase() === q || o.value.toLowerCase() === q);
        hidden.value = hit ? hit.value : text.value.trim();
        if (hit) text.value = hit.label;
      };
      text.addEventListener("focus", show, { signal });
      text.addEventListener("input", show, { signal });
      text.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (list.hidden) show();
          active = Math.max(0, Math.min(shown.length - 1, active + (event.key === "ArrowDown" ? 1 : -1)));
          mark();
          list.querySelectorAll("li")[active]?.scrollIntoView({ block: "nearest" });
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (active >= 0) choose(shown[active]);
          else { settle(); list.hidden = true; }
        } else if (event.key === "Escape" && !list.hidden) {
          event.preventDefault();
          event.stopPropagation();
          list.hidden = true;
        }
      }, { signal });
      text.addEventListener("blur", () => { settle(); list.hidden = true; }, { signal });
      list.addEventListener("mousedown", (event) => {
        const li = event.target.closest("li");
        if (!li) return;
        event.preventDefault();
        choose(shown.find((o) => o.value === li.dataset.value));
      }, { signal });
    }
  }

  _syncEffects() {
    const rows = [...this.element.querySelectorAll("[data-effect-index]")];
    this._effects = rows.map((row) => {
      const get = (f) => row.querySelector(`[name$=".${f}"]`)?.value ?? "";
      return { on: get("on"), has: get("has") !== "false", kind: get("kind"), value: get("value").trim(), by: get("by") };
    });
  }

  _collect() {
    const q = qualifierById(this.qualifierId);
    const out = {};
    for (const rule of q.rules) {
      let raw;
      const el = this.element.querySelector(`[name="rule.${rule.key}"]`);
      if (rule.kind === "check") raw = !!el?.checked;
      else if (rule.kind === "multi") raw = Array.from(el?.value ?? []);
      else if (rule.kind === "ownerEffect") {
        raw = { label: this.element.querySelector(`[name="rule.${rule.key}.label"]`)?.value ?? "", on: this.element.querySelector(`[name="rule.${rule.key}.on"]`)?.value || undefined };
      } else if (rule.kind === "effects") {
        this._syncEffects();
        raw = this._effects.map((e) => ({ on: e.on, ...(e.has ? {} : { has: false }), kind: e.kind, value: e.value, ...(e.by && e.by !== "anyone" ? { by: e.by } : {}) }));
      } else raw = el?.value ?? "";
      if (el?.disabled) {
        if (this.settings[rule.key] !== undefined) out[rule.key] = this.settings[rule.key];
        continue;
      }
      const v = parseFormValue(rule, raw);
      if (v !== undefined) out[rule.key] = v;
    }
    return out;
  }

  static #onApply() {
    const settings = this._collect();
    this.onApplyCb?.(this.qualifierId, settings);
    this.close();
  }

  static #onRemove() {
    this.onRemoveCb?.(this.qualifierId);
    this.close();
  }

  static #onCancel() {
    this.close();
  }

  static #onAddEffect() {
    this._syncEffects();
    this._effects.push(BLANK_EFFECT());
    this.render();
  }

  static #onRemoveEffect(_event, target) {
    this._syncEffects();
    this._effects.splice(Number(target.dataset.index), 1);
    this.render();
  }

  close(options) {
    this._abort?.abort();
    return super.close(options);
  }
}
