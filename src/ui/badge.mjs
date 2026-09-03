import { MODULE_ID, emblemHTML } from "../util.mjs";
import { isTriggeredAbility, isMaliceAbility, getParsedTrigger } from "../triggers/registry.mjs";

const BASE_EVENTS = new Set(["TURN_START", "TURN_END", "ROUND_START", "TAKES_DAMAGE", "DIES", "WINDED_OR_DYING", "REGAINS_STAMINA"]);
const BASE_SCOPES = new Set(["SELF", "ALLY", "ENEMY", "ANY", "GROUP", "SELF_OR_ALLY"]);

export function computeAutomationLevel(item) {
  if (!isTriggeredAbility(item) && !isMaliceAbility(item)) return null;

  if (item.getFlag(MODULE_ID, "manual")) {
    return { level: "manual", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.Manual")] };
  }

  const parse = getParsedTrigger(item);
  if (!parse) return null;

  if (parse.source === "malice-implicit") {
    return { level: "full", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.MaliceImplicit")] };
  }
  if (parse.confidence === "low") {
    return { level: "unknown", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.Unrecognized")] };
  }

  const detail = [];
  let detected = 0;
  for (const clause of parse.clauses) {
    const eventOk = BASE_EVENTS.has(clause.event);
    const scopeOk = BASE_SCOPES.has(clause.scope) || isMaliceAbility(item);
    if (eventOk && scopeOk) {
      detected++;
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.Detected", { event: clause.event, scope: clause.scope }));
    } else if (!eventOk) {
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.EventNeedsTier", { event: clause.event }));
    } else {
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.ScopeNeedsTier", { scope: clause.scope }));
    }
  }
  if (parse.flag === "REVISIT") detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.Revisit"));
  if (parse.flag === "DSCT_ONLY") detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.DsctOnly"));

  const level = detected === parse.clauses.length && parse.flag === undefined ? "full"
    : detected > 0 ? "partial" : "none";
  return { level, detail };
}

function buildBadge(item) {
  const info = computeAutomationLevel(item);
  if (!info) return null;
  const badge = document.createElement("span");
  badge.className = `dst-auto-badge dst-auto-badge--${info.level}`;
  badge.innerHTML = emblemHTML();
  const title = game.i18n.localize(`DS_TRIGGERS.Badge.Level.${info.level}`);
  badge.dataset.tooltip = `<strong>${title}</strong><br>${info.detail.join("<br>")}`;
  badge.dataset.tooltipDirection = "UP";
  return badge;
}

function ensureTriggerRow(app, element, item) {
  if (element.querySelector('input[name="system.trigger"]')) return;
  if (!isMaliceAbility(item)) return;
  const typeGroup = element.querySelector('select[name="system.type"]')?.closest(".form-group");
  if (!typeGroup) return;
  const after = element.querySelector('input[name="system.resource"]')?.closest(".form-group") ?? typeGroup;
  const row = document.createElement("div");
  row.className = "form-group";
  const fieldLabel = item.system.schema.fields.trigger?.label;
  const labelText = fieldLabel ? game.i18n.localize(fieldLabel) : game.i18n.localize("DS_TRIGGERS.Editor.TriggerLabel");
  row.innerHTML = `<label>${labelText}</label><div class="form-fields"><input type="text" name="system.trigger"></div>`;
  const input = row.querySelector("input");
  input.value = item.system.trigger ?? "";
  input.placeholder = game.i18n.localize("DS_TRIGGERS.Reminder.ImplicitMaliceTrigger");
  input.disabled = !app.isEditable;
  after.insertAdjacentElement("afterend", row);
}

Hooks.on("renderDrawSteelItemSheet", (app, element) => {
  const item = app.document;
  if (item?.type !== "ability") return;
  ensureTriggerRow(app, element, item);
  
  const anchor = element.querySelector('input[name="system.trigger"]')
    ?? element.querySelector('select[name="system.type"]');
  if (!anchor) return;
  const fields = anchor.closest(".form-fields") ?? anchor.parentElement;
  if (!fields || fields.querySelector(".dst-auto-badge")) return;
  const badge = buildBadge(item);
  if (!badge) return;
  fields.classList.add("dst-badge-host");
  fields.insertBefore(badge, anchor);
});
