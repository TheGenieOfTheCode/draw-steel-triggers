
const lib = () => game.modules.get("draw-steel-ctlib")?.api;

const esc = (value) => foundry.utils.escapeHTML(String(value ?? ""));

export function tip(key, { title, category, body, html, data = {} } = {}) {
  const prefix = `DS_TRIGGERS.Tip.${key}`;
  const loc = (part) => (game.i18n.has(`${prefix}.${part}`) ? game.i18n.format(`${prefix}.${part}`, data) : "");
  const spec = lib()?.tipFrom?.(prefix, { title, category, body, data })
    ?? { title: title ?? loc("title"), category: category ?? loc("category"), body: body ?? loc("body") };
  return html ? { ...spec, html } : spec;
}

const plain = (spec) => [spec.title, spec.body || (spec.html ? spec.html.replace(/<[^>]+>/g, " ").trim() : "")].filter(Boolean).join(": ");

export function tipAttrs(spec) {
  const rich = lib()?.tipAttrs;
  return rich ? rich(spec) : `data-tooltip="${esc(plain(spec))}"`;
}

export function setTip(el, spec) {
  const rich = lib()?.setTip;
  if (rich) return rich(el, spec);
  el.dataset.tooltip = plain(spec);
  return el;
}

export function textTip(text, { label = "", categoryKey = "" } = {}) {
  const category = categoryKey ? game.i18n.localize(`DS_TRIGGERS.Tip.${categoryKey}`) : "";
  return lib()?.textTip?.(text, { label, category }) ?? { title: label, body: String(text ?? "").replace(/<[^>]+>/g, " ").trim() };
}

export function richify(root, categoryKey) {
  const content = root?.querySelector?.(".window-content") ?? root;
  setTimeout(() => lib()?.richifyTooltips?.(content, { category: game.i18n.localize(`DS_TRIGGERS.Tip.${categoryKey}`) }), 0);
}
