import { itemGainLines, effectiveLine, resourceName, gainsActive, namedGainLines } from "../triggers/resource-gains.mjs";
import { TriggerEditor } from "./trigger-editor.mjs";
import { FEATURE_ITEM_TYPES, itemEffectiveLines, lineAutomationLevel, featureTriggersActive } from "../triggers/feature-triggers.mjs";
import { parseAutomationLevel } from "./badge.mjs";
import { emblemCoinURI } from "./emblem-coin.mjs";
import { MODULE_ID } from "../util.mjs";

const WIDGET_KINDS = new Set(["trigger", "upgrade"]);
const L = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.Gain.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.Gain.${key}`));

function normalized(raw) {
  let out = "";
  const map = [];
  let space = false;
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i];
    if (/\s/.test(c)) {
      if (space) continue;
      c = " ";
      space = true;
    } else space = false;
    if (c === "’" || c === "‘") c = "'";
    out += c.toLowerCase();
    map.push(i);
  }
  return { out, map };
}

function textNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  return { text, nodes };
}

function sentenceStart(root, sentence, from) {
  const { text, nodes } = textNodes(root);
  const { out, map } = normalized(text);
  const probe = normalized(sentence).out.slice(0, 48).trim();
  if (!probe) return null;
  const at = out.indexOf(probe, from);
  if (at < 0) return null;
  const raw = map[at];
  const hit = nodes.findLast((n) => n.start <= raw);
  return hit ? { node: hit.node, offset: raw - hit.start, at } : null;
}

function stateOf(line) {
  if (!gainsActive()) return { cls: "off", tip: L("WidgetOff") };
  if (line.optional && !line.enabled) return { cls: "optional", tip: L("WidgetOptional") };
  if (!line.automated) return { cls: "manual", tip: L("WidgetManual", { why: line.manual?.join(", ") || L("ManualGeneric") }) };
  if (!line.enabled) return { cls: "off", tip: L("WidgetOff") };
  return { cls: "auto", tip: L("WidgetAuto") };
}

function widgetFor(item, line) {
  const button = document.createElement("button");
  button.type = "button";
  const { cls, tip } = stateOf(line);
  button.className = `dst-line-widget dst-line-widget--${cls}`;
  const token = game.modules.get("draw-steel-ctlib")?.api?.resourceTokenURI?.("heroic");
  if (token) button.style.backgroundImage = `url("${token}")`;
  else button.classList.add("dst-line-widget--emblem");
  button.dataset.lineKey = line.key;
  const name = namedGainLines(item.actor).find((e) => e.line.key === line.key)?.line.name ?? "";
  const head = name ? `<strong>${foundry.utils.escapeHTML(name)}</strong><br>` : "";
  button.dataset.tooltip = head + (line.kind === "upgrade" && line.upgradeOf
    ? `${tip}<br>${L("WidgetUpgrade", { base: line.upgradeOf })}` : tip);
  button.setAttribute("aria-label", name ? `${name}. ${tip}` : tip);
  if (!item.isOwner) button.disabled = true;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fresh = itemGainLines(item).find((l) => l.key === line.key);
    if (fresh) new TriggerEditor(item, { line: effectiveLine(item, fresh) }).render({ force: true });
  });
  return button;
}

function coinWidgetFor(item, line) {
  const button = document.createElement("button");
  button.type = "button";
  const info = lineAutomationLevel(line, parseAutomationLevel);
  button.className = `dst-line-widget dst-coin-widget dst-coin-widget--${info.level}`;
  button.style.backgroundImage = `url("${emblemCoinURI(info.level === "none" ? "iron" : info.level)}")`;
  button.dataset.lineKey = line.key;
  const F = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.Feature.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.Feature.${key}`));
  const why = !featureTriggersActive() ? F("WidgetOff")
    : line.covered ? F("WidgetCovered", { name: line.covered })
      : !line.enabled ? F("WidgetDisabled")
        : line.manual?.length ? F("WidgetManual", { why: line.manual.map((m) => F(`Manual.${m}`)).join(", ") })
          : game.i18n.localize(`DS_TRIGGERS.Badge.Level.${info.level}`);
  const action = line.action === "triggered" ? F("ActionTriggered") : line.action === "freeTriggered" ? F("ActionFree") : F("ActionNone");
  button.dataset.tooltip = `<strong>${foundry.utils.escapeHTML(line.name)}</strong> (${action})<br>${why}`
    + (info.detail?.length && line.enabled ? `<br>${info.detail.join("<br>")}` : "");
  button.setAttribute("aria-label", `${line.name}. ${why}`);
  if (!item.isOwner) button.disabled = true;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fresh = itemEffectiveLines(item).find((l) => l.key === line.key);
    if (fresh) new TriggerEditor(item, { line: { ...fresh, lineType: "feature" } }).render({ force: true });
  });
  return button;
}

function place(container, sentence, from, widget) {
  const start = sentenceStart(container, sentence, from);
  if (!start) return from;
  const anchor = start.offset > 0 ? start.node.splitText(start.offset) : start.node;
  anchor.parentNode.insertBefore(widget, anchor);
  return start.at + 1;
}

export function decorate(container, item) {
  if (!container || !item?.actor) return;
  if (container.closest("[contenteditable='true']") || container.querySelector("[contenteditable='true']")) return;
  if (resourceName(item.actor)) {
    let from = 0;
    for (const line of itemGainLines(item).filter((l) => WIDGET_KINDS.has(l.kind))) {
      if (container.querySelector(`.dst-line-widget[data-line-key="${line.key}"]`)) continue;
      from = place(container, line.sentence, from, widgetFor(item, effectiveLine(item, line)));
    }
  }
  if (item.actor.type !== "hero") return;
  let from = 0;
  for (const line of itemEffectiveLines(item)) {
    if (container.querySelector(`.dst-line-widget[data-line-key="${line.key}"]`)) continue;
    from = place(container, line.sentence, from, coinWidgetFor(item, line));
  }
}

const descriptionOf = (element) => element.querySelector("section[data-tab='description']") ?? element;

function decorateRows(root) {
  for (const row of root.querySelectorAll("li[data-document-uuid] .document-description")) {
    if (!row.textContent.trim()) continue;
    const uuid = row.closest("li[data-document-uuid]").dataset.documentUuid;
    const item = fromUuidSync(uuid);
    if (FEATURE_ITEM_TYPES.has(item?.type)) decorate(row, item);
  }
}

export function redecorate(item) {
  for (const app of foundry.applications.instances.values()) {
    const doc = app.document;
    if (doc !== item && doc !== item?.actor) continue;
    for (const w of app.element?.querySelectorAll(`.dst-line-widget[data-line-key]`) ?? []) {
      if (!doc.items || w.closest(`li[data-document-uuid="${item.uuid}"]`)) w.remove();
    }
    if (doc === item) decorate(descriptionOf(app.element), item);
    else decorateRows(app.element);
  }
}

Hooks.on("updateItem", (item, changes) => {
  if (!FEATURE_ITEM_TYPES.has(item.type) || !foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
  redecorate(item);
});

Hooks.on("renderApplicationV2", (app, element) => {
  const doc = app.document;
  if (!doc || !element) return;
  if (doc.documentName === "Item" && FEATURE_ITEM_TYPES.has(doc.type)) {
    decorate(descriptionOf(element), doc);
    return;
  }
  if (doc.documentName !== "Actor" || doc.type !== "hero") return;
  decorateRows(element);
  if (element._dstLineObserver) return;
  
  element._dstLineObserver = new MutationObserver((records) => {
    if (records.some((r) => r.target.closest?.(".document-description") || [...r.addedNodes].some((n) => n.querySelector?.(".document-description")))) {
      decorateRows(element);
    }
  });
  element._dstLineObserver.observe(element, { childList: true, subtree: true });
});
