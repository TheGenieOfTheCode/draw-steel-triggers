import { MODULE_ID } from "../util.mjs";
import { emblemCoinHTML, emblemCoinURI } from "./emblem-coin.mjs";
import { TriggerEditor } from "./trigger-editor.mjs";
import { isTriggeredAbility, isMaliceAbility, getParsedTrigger } from "../triggers/registry.mjs";
import { isDerived } from "../triggers/derived.mjs";
import { clauseMode, scopeResolves } from "../triggers/firing.mjs";
import { setTip, textTip } from "./tips.mjs";

export function computeAutomationLevel(item) {
  if (!isTriggeredAbility(item) && !isMaliceAbility(item) && !isDerived(item)) return null;

  const manual = !!item.getFlag(MODULE_ID, "manual");
  const parse = getParsedTrigger(item);
  if (!parse) return manual ? { level: "manual", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.Manual")] } : null;

  if (parse.source === "malice-implicit") {
    return { level: "full", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.MaliceImplicit")] };
  }
  return parseAutomationLevel(parse, { manual, malice: isMaliceAbility(item) });
}

export function parseAutomationLevel(parse, { manual = false, malice = false } = {}) {
  if (!manual && parse.confidence === "low") {
    return { level: "unknown", detail: [game.i18n.localize("DS_TRIGGERS.Badge.Detail.Unrecognized")] };
  }

  const detail = [];
  let detected = 0;
  for (const clause of parse.clauses) {
    const mode = clauseMode(clause);
    const scopeOk = scopeResolves(clause, malice);
    if (mode && scopeOk) {
      detected++;
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.Detected", {
        event: clause.event, scope: clause.scope,
        mode: game.i18n.localize(`DS_TRIGGERS.Badge.Mode.${mode}`),
      }));
    } else if (!mode) {
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.EventNeedsTier", { event: clause.event }));
    } else {
      detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.ScopeNeedsTier", { scope: clause.scope }));
    }
  }
  if (parse.bespokeEffect) detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.BespokeEffect"));
  if (parse.damageModifying) detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.DamageModifying"));
  if (parse.targetedHalf || parse.clauses.some((c) => c.targetedHalf)) detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.TargetedHalf"));
  const rollMod = parse.clauses.find((c) => c.rollMod)?.rollMod;
  if (rollMod) {
    const effparts = [];
    if (rollMod.banes === 2) effparts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModDoubleBane"));
    else if (rollMod.banes === 1) effparts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModBane"));
    if (rollMod.edges === 2) effparts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModDoubleEdge"));
    else if (rollMod.edges === 1) effparts.push(game.i18n.localize("DS_TRIGGERS.Editor.RollModEdge"));
    if (rollMod.bonus) effparts.push(game.i18n.format("DS_TRIGGERS.Editor.RollModBonus", { n: `${rollMod.bonus > 0 ? "+" : ""}${rollMod.bonus}` }));
    if (rollMod.tierShift) effparts.push(game.i18n.localize(rollMod.tierShift > 0 ? "DS_TRIGGERS.Editor.RollModTierUp" : "DS_TRIGGERS.Editor.RollModTierDown"));
    detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.RollModifying", { effect: effparts.join(" + ") }));
  }
  const redirectMode = parse.redirect ?? parse.clauses.find((c) => c.redirect)?.redirect;
  if (redirectMode) detail.push(game.i18n.format("DS_TRIGGERS.Badge.Detail.Redirect", {
    mode: game.i18n.localize(`DS_TRIGGERS.Badge.RedirectMode.${redirectMode}`),
  }));
  if (parse.flag === "REVISIT") detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.Revisit"));
  if (parse.flag === "EFFECT_TODO") detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.EffectTodo"));
  if (parse.flag === "DSCT_ONLY") detail.push(game.i18n.localize("DS_TRIGGERS.Badge.Detail.DsctOnly"));

  if (manual) {
    detail.unshift(game.i18n.localize("DS_TRIGGERS.Badge.Detail.Manual"));
    return { level: "manual", detail };
  }
  const level = detected === parse.clauses.length && parse.flag === undefined ? "full"
    : detected > 0 ? "partial" : "none";
  return { level, detail };
}

function buildBadge(item) {
  const info = computeAutomationLevel(item);
  if (!info) return null;
  const badge = document.createElement("span");
  badge.className = `dst-auto-badge dst-auto-badge--${info.level}`;
  badge.innerHTML = emblemCoinHTML(info.level, { className: "dst-emblem-img" });
  const title = game.i18n.localize(`DS_TRIGGERS.Badge.Level.${info.level}`);
  setTip(badge, textTip(`<strong>${title}</strong><br>${info.detail.join("<br>")}`, { categoryKey: "Category" }));
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

function buildCoin(item) {
  const info = computeAutomationLevel(item);
  if (!info) return null;
  const coin = document.createElement("button");
  coin.type = "button";
  coin.className = `dst-line-widget dst-coin-widget dst-coin-widget--${info.level}`;
  coin.style.backgroundImage = `url("${emblemCoinURI(info.level === "none" ? "iron" : info.level)}")`;
  const title = game.i18n.localize(`DS_TRIGGERS.Badge.Level.${info.level}`);
  setTip(coin, textTip(`<strong>${title}</strong><br>${info.detail.join("<br>")}`, { categoryKey: "Category" }));
  coin.setAttribute("aria-label", title);
  if (!item.isOwner) coin.disabled = true;
  coin.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    new TriggerEditor(item).render({ force: true });
  });
  return coin;
}

function decoratePlayTrigger(element, item) {
  const text = element.querySelector("dd.trigger");
  if (!text || text.querySelector(".dst-coin-widget")) return;
  const coin = buildCoin(item);
  if (coin) text.prepend(coin);
}

Hooks.on("renderDrawSteelItemSheet", (app, element) => {
  const item = app.document;
  if (item?.type !== "ability") return;
  ensureTriggerRow(app, element, item);
  decoratePlayTrigger(element, item);
  
  const anchor = element.querySelector('input[name="system.trigger"]')
    ?? element.querySelector('select[name="system.type"]');
  if (!anchor) return;
  const fields = anchor.closest(".form-fields") ?? anchor.parentElement;
  if (!fields || fields.querySelector(".dst-auto-badge")) return;
  const badge = buildBadge(item);
  if (!badge) return;
  fields.classList.add("dst-badge-host");
  const ref = anchor.closest(".dst-input-wrap") ?? anchor;
  ref.parentElement.insertBefore(badge, ref);
});
