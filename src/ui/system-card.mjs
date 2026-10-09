import { MODULE_ID } from "../util.mjs";
import { featureLineEmbed } from "./feature-card.mjs";

const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const ctlib = () => game.modules.get("draw-steel-ctlib")?.api ?? null;

export function speakerFor(kind) {
  if (!kind) return { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") };
  return { alias: game.i18n.format("DS_TRIGGERS.Card.SpeakerKind", { kind: game.i18n.localize(`DS_TRIGGERS.Card.Kind.${kind}`) }) };
}

export function postSystemCard({ title, flavor = title, kind = null, content = "", parts = null, whisper = null, speaker = null, flags = {}, rolls = null, id = null }) {
  const Msg = ds.documents.DrawSteelChatMessage;
  const data = {
    type: "standard",
    title,
    content,
    "system.parts": parts ?? [{ type: "content", ...(flavor ? { flavor } : {}) }],
    speaker: speaker ?? speakerFor(kind),
    flags: foundry.utils.mergeObject({ core: { canPopout: true } }, flags),
  };
  if (whisper) data.whisper = whisper;
  if (rolls) data.rolls = rolls;
  if (id) data._id = id;
  return Msg.create(data, id ? { keepId: true } : {});
}

export function cardContent({ head = "", event = "", intro = "", body = "", buttons = "" } = {}) {
  const eventLine = event ? `<p class="dst-card-event"><strong>${esc(game.i18n.localize("DS_TRIGGERS.Card.Event"))}:</strong> ${event}</p>` : "";
  const sep = (eventLine || intro) && body ? `<hr class="dst-card-sep">` : "";
  return `<div class="dst-system-card">${head}${eventLine}${intro ? `<p class="dst-card-intro dst-card-event">${intro}</p>` : ""}${sep}${body}${buttons
    ? `<footer class="message-part-buttons dst-card-buttons">${buttons}</footer>` : ""}</div>`;
}

export const cardPill = (label, { cls = "", img = "" } = {}) =>
  `<span class="dst-card-pill${cls ? ` ${cls}` : ""}">${img ? `<img class="dst-card-pill-chip" src="${img}" alt="">` : ""}${esc(label)}</span>`;

export function actionPill(item) {
  const type = item?.system?.type;
  const key = type === "triggered" ? "DS_TRIGGERS.Reminder.Triggered"
    : type === "freeTriggered" ? "DS_TRIGGERS.Reminder.Free"
      : !type || type === "none" ? "DS_TRIGGERS.Reminder.NoAction"
        : ds.CONFIG.abilities.types[type]?.label;
  return key ? cardPill(game.i18n.localize(key), { cls: "dst-card-action" }) : "";
}

const tokenDocOf = (thing) => {
  if (!thing) return null;
  if (thing.documentName === "Token") return thing;
  if (thing.document?.documentName === "Token") return thing.document;
  if (thing.documentName === "Actor") {
    if (thing.token) return thing.token;
    const tokens = thing.getActiveTokens?.(false, true) ?? [];
    return tokens.find((t) => t.parent === canvas.scene) ?? tokens[0] ?? null;
  }
  return null;
};

export function faceHTML(thing, { named = false } = {}) {
  const lib = ctlib();
  const doc = tokenDocOf(thing);
  const face = doc && lib?.faceFromToken ? lib.faceFromToken(doc) : null;
  if (!face?.src) return "";
  const chain = lib.faceChainHTML([face], { className: "dst-card-faces" });
  if (!named) return chain;
  const short = face.name.trim().split(/\s+/).at(-1);
  return `<span class="dst-face-pair">${chain}<span class="dst-face-name"><span class="dst-name-full">${esc(face.name)}</span><span class="dst-name-short">${esc(short)}</span></span></span>`;
}

export const withFaces = (text, things = []) => facesIn(esc(text), things);

export function facesIn(html, things = []) {
  const faces = new Map();
  for (const thing of things.flat()) {
    const doc = tokenDocOf(thing);
    const name = doc?.name ?? thing?.name;
    if (!name || faces.has(name)) continue;
    const face = faceHTML(doc, { named: true });
    if (face) faces.set(name, face);
  }
  const names = [...faces.keys()].sort((a, b) => b.length - a.length);
  names.forEach((n, i) => { html = html.split(esc(n)).join(`\u0000${i}\u0000`); });
  names.forEach((n, i) => { html = html.split(`\u0000${i}\u0000`).join(faces.get(n)); });
  return html;
}

async function embedFor(item) {
  if (!item) return "";
  if (item.featureLine && !item.featureLine.derived && item.feature) return featureLineEmbed(item.feature, item.featureLine.key);
  const el = await item.toEmbed?.({ caption: false })?.catch?.(() => null);
  return el?.outerHTML ?? "";
}

function compactEmbed(html, { item, name, owner, pills, action = true }) {
  const host = document.createElement("div");
  host.innerHTML = html;
  const embed = host.querySelector("document-embed");
  if (!embed) return "";
  embed.classList.add("dst-compact");
  const sys = item && !item.featureLine ? item.system : null;
  const mark = (selector) => embed.querySelectorAll(selector).forEach((el) => el.classList.add("dst-default"));
  if (sys) {
    if (!(sys.keywords?.size ?? sys.keywords?.length)) mark("dt.keywords, dd.keywords");
    if (!sys.type || sys.type === "none") mark("dt.type, dd.type");
    if (sys.distance?.type === "special") mark("dt.distance, dd.distance");
    if (sys.target?.type === "special") mark("dt.target, dd.target");
  }
  if ((pills ?? []).some((p) => p.includes("dst-card-pill--malice"))) mark("section.metadata > p.resource");
  const meta = embed.querySelector(":scope > section.metadata");
  const fields = meta ? [...meta.querySelectorAll(":scope > p, :scope > dl > dt, :scope > dl > dd")] : [];
  if (fields.length && fields.every((el) => el.classList.contains("dst-default"))) meta.classList.add("dst-default");
  const h5 = embed.querySelector(":scope > h5");
  if (h5) {
    const tip = esc(game.i18n.localize("DS_TRIGGERS.Reminder.LinkTooltip"));
    const title = item
      ? `<a class="dst-ability-link" data-item-uuid="${item.uuid}" data-tooltip="${tip}">${esc(name ?? h5.textContent.trim())}</a>`
      : esc(name ?? h5.textContent.trim());
    const tail = [action ? actionPill(item) : "", ...(pills ?? []), owner ? faceHTML(owner, { named: true }) : ""].filter(Boolean).join("");
    h5.innerHTML = `<i class="fa-solid fa-caret-down dst-card-caret" inert></i>${title}${tail ? `<span class="dst-card-tail">${tail}</span>` : ""}`;
  }
  return embed.outerHTML;
}

export async function abilityRowsHTML(rows) {
  const items = await Promise.all(rows.map(async (r) => {
    const embed = await embedFor(r.item);
    const attrs = Object.entries(r.attrs ?? {}).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    if (!embed) return `<li class="dst-card-row"${attrs}><strong>${esc(r.name ?? r.item?.name)}</strong></li>`;
    return `<li class="dst-card-row"${attrs}>${compactEmbed(embed, r)}</li>`;
  }));
  return `<ul class="dst-card-list">${items.join("")}</ul>`;
}

document.addEventListener("click", (event) => {
  const embed = event.target.closest?.(".dst-card-row > document-embed");
  if (!embed) return;
  if (event.target.closest("a, button, input, select, [data-ctlib-face]")) return;
  const compact = embed.classList.contains("dst-compact");
  if (!compact && !event.target.closest("h5")) return;
  event.preventDefault();
  event.stopPropagation();
  embed.classList.toggle("dst-compact", !compact);
  const h5 = embed.querySelector(":scope > h5");
  if (h5) fitNames(h5);
}, true);

function wraps(line) {
  const probe = line.cloneNode(true);
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;width:auto;left:-9999px;top:0";
  line.parentElement.append(probe);
  const single = probe.getBoundingClientRect().height;
  probe.remove();
  return line.getBoundingClientRect().height > single * 1.5;
}

function fitNames(line) {
  if (!line.isConnected || !line.getBoundingClientRect().width || !line.querySelector(".dst-face-name, .ctlib-faces")) return;
  const height = () => line.getBoundingClientRect().height;
  line.classList.remove("dst-names-short", "dst-small-faces");
  line.classList.add("dst-names-none");
  let multiline = false;
  if (line.tagName === "P") {
    line.classList.add("dst-small-faces");
    multiline = wraps(line);
    if (!multiline) line.classList.remove("dst-small-faces");
  }
  if (multiline || !line.querySelector(".dst-face-name")) {
    line.classList.remove("dst-names-none");
    return;
  }
  const bare = height();
  line.classList.remove("dst-names-none");
  if (height() <= bare + 1) return;
  line.classList.add("dst-names-short");
  if (height() <= bare + 1) return;
  line.classList.replace("dst-names-short", "dst-names-none");
}

const _widths = new WeakMap();
const _fitter = new ResizeObserver((entries) => {
  for (const { target } of entries) {
    const width = Math.round(target.getBoundingClientRect().width);
    if (_widths.get(target) === width) continue;
    _widths.set(target, width);
    target.querySelectorAll(".dst-card-event, .dst-card-row > document-embed > h5").forEach(fitNames);
  }
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.flags?.[MODULE_ID]) return;
  html.querySelectorAll?.(".dst-card-faces").forEach((chain) => ctlib()?.activateFaces?.(chain));
  if (html.querySelector?.(".dst-face-name, .dst-card-event .ctlib-faces")) _fitter.observe(html);
});
