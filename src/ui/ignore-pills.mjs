import { MODULE_ID } from "../util.mjs";
import { generateDSID } from "../parser/trigger-parser.mjs";
import { FEATURE_ITEM_TYPES, ignoredList, ignoreFeature, unignoreFeature } from "../triggers/feature-triggers.mjs";

const L = (key, data) => (data ? game.i18n.format(`DS_TRIGGERS.Settings.FeatureIgnore.${key}`, data) : game.i18n.localize(`DS_TRIGGERS.Settings.FeatureIgnore.${key}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const MAX_SUGGESTIONS = 8;

let _index = null;

function typeLabel(type) {
  const key = CONFIG.Item.typeLabels?.[type];
  return key ? game.i18n.localize(key) : type;
}

async function featureIndex() {
  if (_index) return _index;
  const byDsid = new Map();
  const add = (name, type, dsid) => {
    if (!name || !FEATURE_ITEM_TYPES.has(type)) return;
    const id = String(dsid || generateDSID(name)).toLowerCase();
    if (!byDsid.has(id)) byDsid.set(id, { dsid: id, name, type: typeLabel(type), lower: name.toLowerCase() });
  };
  for (const item of game.items) add(item.name, item.type, item.system?._dsid);
  await Promise.all(game.packs.filter((p) => p.documentName === "Item").map(async (pack) => {
    try {
      const index = await pack.getIndex({ fields: ["system._dsid"] });
      for (const e of index) add(e.name, e.type, e.system?._dsid);
    } catch {}
  }));
  _index = [...byDsid.values()].sort((a, b) => a.name.localeCompare(b.name));
  return _index;
}

function suggestionsFor(query, index) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ignored = new Set(ignoredList().map((e) => e.dsid));
  const open = index.filter((e) => !ignored.has(e.dsid) && e.lower.includes(q));
  open.sort((a, b) => (b.lower.startsWith(q) - a.lower.startsWith(q)) || a.name.localeCompare(b.name));
  return open.slice(0, MAX_SUGGESTIONS);
}

function renderPills(host) {
  const list = ignoredList().sort((a, b) => a.name.localeCompare(b.name));
  host.innerHTML = `${list.map((e) => `<button type="button" class="dst-ignore-pill" data-dsid="${esc(e.dsid)}" data-tooltip="${esc(L("PillTooltip", { dsid: e.dsid }))}" aria-label="${esc(L("PillAria", { name: e.name }))}"><span>${esc(e.name)}</span><i class="fa-solid fa-xmark"></i></button>`).join("")}
    <button type="button" class="dst-ignore-pill dst-ignore-add" data-tooltip="${esc(L("AddTooltip"))}" aria-label="${esc(L("AddTooltip"))}"><i class="fa-solid fa-plus"></i></button>
    ${list.length ? "" : `<span class="dst-ignore-empty">${esc(L("Empty"))}</span>`}`;
}

function openAdd(host, button) {
  const wrap = document.createElement("span");
  wrap.className = "dst-ignore-field";
  const listId = `dst-ignore-suggest-${foundry.utils.randomID()}`;
  wrap.innerHTML = `<input type="text" class="dst-ignore-input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${listId}" placeholder="${esc(L("AddPlaceholder"))}" aria-label="${esc(L("AddPlaceholder"))}"><ul class="dst-ignore-suggest" id="${listId}" role="listbox" hidden></ul>`;
  button.replaceWith(wrap);
  const input = wrap.querySelector("input");
  const menu = wrap.querySelector("ul");
  input.focus();

  let options = [];
  let active = -1;
  let done = false;
  let index = null;
  featureIndex().then((i) => { index = i; if (input.value) draw(); });

  const draw = () => {
    options = index ? suggestionsFor(input.value, index) : [];
    active = options.length ? Math.min(Math.max(active, 0), options.length - 1) : -1;
    menu.innerHTML = options.map((o, n) => `<li role="option" id="${listId}-${n}" data-n="${n}" aria-selected="${n === active}"${n === active ? ' class="active"' : ""}><span>${esc(o.name)}</span><small>${esc(o.type)}</small></li>`).join("");
    menu.hidden = !options.length;
    input.setAttribute("aria-expanded", String(!!options.length));
    if (active >= 0) input.setAttribute("aria-activedescendant", `${listId}-${active}`);
    else input.removeAttribute("aria-activedescendant");
  };

  const finish = async (pick) => {
    if (done) return;
    done = true;
    if (pick) await ignoreFeature({ dsid: pick.dsid, name: pick.name });
    else {
      const value = input.value.trim();
      if (value) {
        const known = index?.find((e) => e.lower === value.toLowerCase() || e.dsid === value.toLowerCase());
        await ignoreFeature(known ?? { dsid: generateDSID(value), name: value.replace(/\s+/g, " ") });
      }
    }
    renderPills(host);
  };
  const cancel = () => { if (!done) { done = true; renderPills(host); } };

  input.addEventListener("input", () => { active = 0; draw(); });
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && options.length) { event.preventDefault(); active = (active + 1) % options.length; draw(); }
    else if (event.key === "ArrowUp" && options.length) { event.preventDefault(); active = (active - 1 + options.length) % options.length; draw(); }
    else if (event.key === "Enter") { event.preventDefault(); finish(active >= 0 ? options[active] : null); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
  });
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const li = event.target.closest("li[data-n]");
    if (li) finish(options[Number(li.dataset.n)]);
  });
  input.addEventListener("blur", () => cancel());
}

Hooks.on("renderSettingsConfig", (_app, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const input = root?.querySelector(`[name="${MODULE_ID}.featureIgnore"]`);
  if (!input) return;
  const fields = input.closest(".form-fields") ?? input.parentElement;
  const group = input.closest(".form-group");
  if (!fields || !group) return;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "dst-ignore-toggle";
  const host = document.createElement("div");
  host.className = "dst-ignore-pills";
  host.hidden = true;
  const label = () => {
    const text = host.hidden ? L("Show", { n: ignoredList().length }) : L("Hide");
    toggle.innerHTML = `<i class="fa-solid ${host.hidden ? "fa-eye" : "fa-eye-slash"}"></i>`;
    toggle.dataset.tooltip = text;
    toggle.setAttribute("aria-label", text);
    toggle.setAttribute("aria-pressed", String(!host.hidden));
  };
  input.remove();
  fields.replaceChildren(toggle);
  group.insertAdjacentElement("afterend", host);
  label();

  toggle.addEventListener("click", () => {
    host.hidden = !host.hidden;
    if (!host.hidden) renderPills(host);
    label();
  });
  host.addEventListener("click", async (event) => {
    const add = event.target.closest(".dst-ignore-add");
    if (add) { openAdd(host, add); return; }
    const pill = event.target.closest(".dst-ignore-pill[data-dsid]");
    if (!pill) return;
    await unignoreFeature(pill.dataset.dsid);
  });
  const refresh = () => {
    if (!host.isConnected) { Hooks.off("dst.ignoredFeaturesChanged", hookId); return; }
    if (!host.hidden && !host.querySelector(".dst-ignore-input")) renderPills(host);
    label();
  };
  const hookId = Hooks.on("dst.ignoredFeaturesChanged", refresh);
});

Hooks.on("createItem", () => { _index = null; });
