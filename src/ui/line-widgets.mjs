import { itemGainLines, effectiveLine, resourceName, gainsActive } from "../triggers/resource-gains.mjs";
import { TriggerEditor } from "./trigger-editor.mjs";

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
  button.dataset.tooltip = line.kind === "upgrade" && line.upgradeOf
    ? `${tip}<br>${L("WidgetUpgrade", { base: line.upgradeOf })}` : tip;
  button.setAttribute("aria-label", tip);
  if (!item.isOwner) button.disabled = true;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const fresh = itemGainLines(item).find((l) => l.key === line.key);
    if (fresh) new TriggerEditor(item, { line: effectiveLine(item, fresh) }).render({ force: true });
  });
  return button;
}

export function decorate(container, item) {
  if (!container || !item?.actor || !resourceName(item.actor)) return;
  if (container.closest("[contenteditable='true']") || container.querySelector("[contenteditable='true']")) return;
  const lines = itemGainLines(item).filter((l) => WIDGET_KINDS.has(l.kind));
  let from = 0;
  for (const line of lines) {
    if (container.querySelector(`.dst-line-widget[data-line-key="${line.key}"]`)) continue;
    const start = sentenceStart(container, line.sentence, from);
    if (!start) continue;
    from = start.at + 1;
    const anchor = start.offset > 0 ? start.node.splitText(start.offset) : start.node;
    anchor.parentNode.insertBefore(widgetFor(item, effectiveLine(item, line)), anchor);
  }
}

const descriptionOf = (element) => element.querySelector("section[data-tab='description']") ?? element;

function decorateRows(root) {
  for (const row of root.querySelectorAll("li[data-document-uuid] .document-description")) {
    if (!row.textContent.trim()) continue;
    const uuid = row.closest("li[data-document-uuid]").dataset.documentUuid;
    const item = fromUuidSync(uuid);
    if (item?.type === "feature" || item?.type === "subclass") decorate(row, item);
  }
}

Hooks.on("renderApplicationV2", (app, element) => {
  const doc = app.document;
  if (!doc || !element) return;
  if (doc.documentName === "Item" && (doc.type === "feature" || doc.type === "subclass")) {
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
