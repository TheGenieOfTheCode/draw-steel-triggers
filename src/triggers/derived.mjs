import { MODULE_ID, dbg, isPrimaryGM, getSetting } from "../util.mjs";
import { FEATURE_ITEM_TYPES, FEATURE_ACTOR_TYPES, itemEffectiveLines, featureTriggersActive, ignoreLine } from "./feature-triggers.mjs";
import { enricherText, asOwner } from "../parser/feature-triggers.mjs";
import { parseTrigger } from "../parser/trigger-parser.mjs";
import { prerequisites } from "../ui/feature-card.mjs";

const FLAG = "derived";
const ONCE_FLAG = "derivedOnce";
const NAME_FLAG = "derivedName";
const IMG_FLAG = "derivedImg";
const SYNC = { dstDerivedSync: true };
const ENRICHER = /\[\[([^\]]*)\]\](?:\{([^}]*)\})?/g;
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

export const derivedInfo = (item) => (item?.type === "ability" ? item.getFlag(MODULE_ID, FLAG) ?? null : null);
export const isDerived = (item) => !!derivedInfo(item);
export const derivedOnce = (item) => {
  const own = item.getFlag(MODULE_ID, ONCE_FLAG);
  return own === undefined ? derivedInfo(item)?.once ?? null : own || null;
};

export function derivedFor(actor, sourceId, lineKey) {
  return actor?.items?.find((i) => {
    const d = derivedInfo(i);
    return d && d.sourceId === sourceId && d.lineKey === lineKey;
  }) ?? null;
}

export const sourceOf = (item) => {
  const d = derivedInfo(item);
  return d ? item.actor?.items?.get(d.sourceId) ?? null : null;
};

function effectHTML(source, line) {
  let effect = esc(cap(line.effect ?? "").replace(/\bdamage damage\b/g, "damage"));
  for (const m of String(source.system?.description?.value ?? "").matchAll(ENRICHER)) {
    const text = esc(enricherText(m[1], m[2]));
    const at = text ? effect.toLowerCase().indexOf(text.toLowerCase()) : -1;
    if (at >= 0) effect = effect.slice(0, at) + m[0] + effect.slice(at + text.length);
  }
  return `<p>${effect}</p>`;
}

const SCOPE_TARGETS = { SELF: { type: "self" }, ALLY: { type: "ally", value: 1 }, ENEMY: { type: "enemy", value: 1 },
  ANY: { type: "creature", value: 1 }, GROUP: { type: "creature", value: 1 }, SELF_OR_ALLY: { type: "selfOrAlly" }, OBJECT: { type: "object", value: 1 } };

function reachOf(parse) {
  const clause = parse?.clauses?.find((c) => c.event && c.event !== "UNKNOWN") ?? null;
  const target = SCOPE_TARGETS[clause?.scope] ?? { type: "special" };
  const range = Number.isFinite(clause?.range) && clause.range > 0 ? clause.range : null;
  const distance = range === 1 ? { type: "melee", primary: "1" }
    : range ? { type: "ranged", primary: String(range) }
      : target.type === "self" ? { type: "self" } : { type: "special" };
  return { distance, target };
}

function specFor(source, line) {
  const prereqs = prerequisites(source, line.tier);
  const effects = {
    after00000000000: { _id: "after00000000000", type: "base", name: "", img: null, sort: 1, before: false, description: effectHTML(source, line) },
  };
  if (prereqs.length) {
    const label = game.i18n.localize(`DS_TRIGGERS.Card.${prereqs.length > 1 ? "Prerequisites" : "Prerequisite"}`);
    effects.before0000000000 = { _id: "before0000000000", type: "base", name: label, img: null, sort: 0, before: true,
      description: `<p>${prereqs.map((c, i) => esc(i ? `${game.i18n.localize("DS_TRIGGERS.Card.And")} ${c}` : cap(c))).join(", ")}</p>` };
  }
  const system = {
    type: line.action ?? "none",
    trigger: line.trigger,
    story: line.flavor ?? "",
    keywords: [],
    ...reachOf(line.parse),
    _dsid: line.key,
    effects,
  };
  const content = { name: line.name, img: source.img, system, once: line.once ?? null, tier: line.tier ?? null };
  const flag = {
    sourceId: source.id, sourceName: source.name, sourceDsid: String(source.system?._dsid ?? "").toLowerCase(),
    lineKey: line.key, once: line.once ?? null, tier: line.tier ?? null, family: line.family ?? null,
    hash: JSON.stringify(content), edited: false,
  };
  const out = { name: line.name, type: "ability", img: source.img, system, flags: { [MODULE_ID]: { [FLAG]: flag } } };
  if (line.overridden && line.parse?.source === "manual") {
    Object.assign(out.flags[MODULE_ID], { manual: true, trigger: { clauses: line.parse.clauses } });
  }
  return out;
}

const _parseCache = new Map();

export function derivedParse(item) {
  if (item.getFlag(MODULE_ID, "manual")) {
    const stored = item.getFlag(MODULE_ID, "trigger");
    if (stored?.clauses?.length) return { clauses: stored.clauses, confidence: "high", source: "manual" };
  }
  const text = String(item.system?.trigger ?? "").trim().replace(/[.!]+$/, "");
  const ownerName = item.actor && item.actor.type !== "hero" ? item.actor.name : "";
  const effectText = (item.system?.effects?.contents ?? []).map((e) => e.description ?? "").join(" ").replace(/<[^>]+>/g, " ");
  const cached = _parseCache.get(item.uuid);
  if (cached && cached.text === text && cached.ownerName === ownerName && cached.effectText === effectText) return cached.result;
  const result = parseTrigger(`${ownerName ? asOwner(text, ownerName) : text}.`, { effectText, ownerName });
  _parseCache.set(item.uuid, { text, ownerName, effectText, result });
  return result;
}

const baseActor = (actor) => (actor?.isToken ? game.actors.get(actor.id) ?? null : actor);

function responsible(actor) {
  if (!actor || !FEATURE_ACTOR_TYPES.has(actor.type) || actor.pack) return false;
  if (game.users.activeGM) return isPrimaryGM();
  const owners = game.users.filter((u) => u.active && actor.testUserPermission(u, "OWNER")).sort((a, b) => a.id.localeCompare(b.id));
  return !!owners[0]?.isSelf;
}

const _timers = new Map();
const _running = new Set();

export const derivedActive = () => getSetting("derivedTriggers") !== false && featureTriggersActive();

export function queueSync(actor) {
  const base = baseActor(actor);
  if (!derivedActive() || !responsible(base)) return;
  clearTimeout(_timers.get(base.id));
  _timers.set(base.id, setTimeout(() => {
    _timers.delete(base.id);
    syncActor(base).catch((err) => console.warn(`${MODULE_ID} | derived trigger sync failed for ${base.name}`, err));
  }, 300));
}

export async function syncActor(actor) {
  if (_running.has(actor.id)) return queueSync(actor);
  _running.add(actor.id);
  try {
    const want = new Map();
    for (const item of actor.items) {
      if (!FEATURE_ITEM_TYPES.has(item.type)) continue;
      for (const line of itemEffectiveLines(item)) {
        if (!line.enabled) continue;
        want.set(`${item.id}|${line.key}`, specFor(item, line));
      }
    }
    const have = new Map();
    for (const item of actor.items) {
      const d = derivedInfo(item);
      if (d) have.set(`${d.sourceId}|${d.lineKey}`, item);
    }
    const creates = [...want].filter(([k]) => !have.has(k)).map(([, spec]) => spec);
    const FR = foundry.data?.operators?.ForcedReplacement;
    const updates = [];
    const deletes = [];
    for (const [k, item] of have) {
      const d = derivedInfo(item);
      const spec = want.get(k);
      if (!spec) {
        if (!d.edited) deletes.push(item.id);
        continue;
      }
      if (d.edited || d.hash === spec.flags[MODULE_ID][FLAG].hash) continue;
      updates.push({ _id: item.id, name: item.getFlag(MODULE_ID, NAME_FLAG) ?? spec.name, img: item.getFlag(MODULE_ID, IMG_FLAG) ?? spec.img, system: { ...spec.system, effects: FR ? new FR(spec.system.effects) : spec.system.effects },
        [`flags.${MODULE_ID}.${FLAG}`]: spec.flags[MODULE_ID][FLAG] });
    }
    if (creates.length) await actor.createEmbeddedDocuments("Item", creates, SYNC);
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, SYNC);
    if (deletes.length) await actor.deleteEmbeddedDocuments("Item", deletes, SYNC);
    if (creates.length || updates.length || deletes.length) dbg(`derived triggers on ${actor.name}: +${creates.length} ~${updates.length} -${deletes.length}`);
  } finally {
    _running.delete(actor.id);
  }
}

export function onDerivedSetting(on) {
  if (on) for (const actor of game.actors) if (actor.type === "hero") queueSync(actor);
  for (const app of foundry.applications.instances.values()) {
    if (app.document?.documentName === "Actor" && FEATURE_ACTOR_TYPES.has(app.document.type)) app.render();
  }
}

function markDerivedRows(element) {
  const on = derivedActive();
  for (const row of element.querySelectorAll("li[data-document-uuid]")) {
    const item = fromUuidSync(row.dataset.documentUuid);
    const d = derivedInfo(item);
    if (!d) continue;
    row.hidden = !on;
    if (!on || row.querySelector(".dst-derived-tag")) continue;
    const line = row.querySelector(".name .keywords");
    if (!line) continue;
    const tag = document.createElement("span");
    tag.className = "dst-derived-tag";
    tag.textContent = L("From", { source: d.sourceName });
    if (line.textContent.trim() === "—") line.replaceChildren(tag);
    else line.append(" · ", tag);
  }
}

Hooks.on("renderApplicationV2", (app, element) => {
  const doc = app.document;
  if (doc?.documentName !== "Actor" || !element || !doc.items.some(isDerived)) return;
  markDerivedRows(element);
});

export async function resyncDerived(item) {
  const source = sourceOf(item);
  const d = derivedInfo(item);
  const line = source ? itemEffectiveLines(source).find((l) => l.key === d.lineKey) : null;
  if (!line) return false;
  const spec = specFor(source, line);
  const FR = foundry.data?.operators?.ForcedReplacement;
  const DEL = foundry.data?.operators?.ForcedDeletion;
  await item.update({
    name: item.getFlag(MODULE_ID, NAME_FLAG) ?? spec.name, img: item.getFlag(MODULE_ID, IMG_FLAG) ?? spec.img, system: { ...spec.system, effects: FR ? new FR(spec.system.effects) : spec.system.effects },
    [`flags.${MODULE_ID}.${FLAG}`]: spec.flags[MODULE_ID][FLAG],
    ...Object.fromEntries(["manual", "trigger", ONCE_FLAG].map((k) => (DEL ? [`flags.${MODULE_ID}.${k}`, new DEL()] : [`flags.${MODULE_ID}.-=${k}`, null]))),
  }, SYNC);
  _parseCache.delete(item.uuid);
  return true;
}

Hooks.once("setup", () => {
  const proto = CONFIG.Item.dataModels.ability?.prototype;
  if (!proto?.getSheetContext) return;
  const wrap = async function (wrapped, context, ...rest) {
    const out = await wrapped(context, ...rest);
    if (isDerived(this.parent)) context.triggeredAction = true;
    return out;
  };
  if (game.modules.get("lib-wrapper")?.active) {
    libWrapper.register(MODULE_ID, "CONFIG.Item.dataModels.ability.prototype.getSheetContext", wrap, "WRAPPER");
  } else {
    const original = proto.getSheetContext;
    proto.getSheetContext = function (context, ...rest) { return wrap.call(this, original.bind(this), context, ...rest); };
  }
});

const isSource = (item) => FEATURE_ITEM_TYPES.has(item?.type) && item.parent?.documentName === "Actor";

Hooks.once("ready", () => {
  for (const actor of game.actors) if (actor.type === "hero") queueSync(actor);
});
Hooks.on("createCombatant", (combatant) => queueSync(combatant.actor));
Hooks.on("createItem", (item) => { if (isSource(item)) queueSync(item.parent); });
Hooks.on("deleteItem", (item) => { if (isSource(item)) queueSync(item.parent); });
Hooks.on("updateItem", (item, changes) => {
  if (isSource(item) && (foundry.utils.hasProperty(changes, "system.description") || "name" in changes
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.featureLines`))) queueSync(item.parent);
});
Hooks.on("renderApplicationV2", (app) => {
  const doc = app.document;
  if (doc?.documentName === "Actor" && FEATURE_ACTOR_TYPES.has(doc.type)) queueSync(doc);
});
Hooks.on("dst.ignoredFeaturesChanged", () => {
  for (const actor of game.actors) if (actor.items.some(isDerived)) queueSync(actor);
});

Hooks.on("preUpdateItem", (item, changes, options, userId) => {
  if (!isDerived(item) || options.dstDerivedSync || userId !== game.user.id) return;
  if ("name" in changes) foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${NAME_FLAG}`, changes.name);
  if ("img" in changes) foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${IMG_FLAG}`, changes.img);
  if (!("system" in changes)) return;
  foundry.utils.setProperty(changes, `flags.${MODULE_ID}.${FLAG}.edited`, true);
});

const L = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.Derived.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.Derived.${k}`));

Hooks.on("renderDrawSteelItemSheet", (app, element) => {
  const item = app.document;
  const d = derivedInfo(item);
  if (!d || element.querySelector(".dst-derived-note")) return;
  const note = document.createElement("p");
  note.className = "dst-derived-note";
  note.innerHTML = `<i class="fa-solid fa-link" inert></i> ${L("From", { source: `<a class="dst-derived-source">${esc(d.sourceName)}</a>` })}`
    + (d.edited ? ` · <span class="dst-derived-edited">${L("Edited")}</span> · <a class="dst-derived-resync" data-tooltip="${esc(L("ResyncTip"))}">${L("Resync")}</a>` : "");
  note.querySelector(".dst-derived-source")?.addEventListener("click", () => sourceOf(item)?.sheet.render({ force: true }));
  note.querySelector(".dst-derived-resync")?.addEventListener("click", async () => {
    if (!item.isOwner) return;
    if (await resyncDerived(item)) ui.notifications.info(L("Resynced", { name: item.name }));
  });
  const host = element.querySelector("dd.trigger")?.closest("dl") ?? element.querySelector('input[name="system.trigger"]')?.closest(".form-group");
  if (host) host.before(note);
  else element.querySelector(".window-content")?.prepend(note);
});

let _socket = null;
Hooks.once("socketlib.ready", () => {
  _socket = socketlib.registerModule(MODULE_ID);
  _socket?.register("derivedDeleted", (payload) => ignoreDeleted(payload));
});

async function ignoreDeleted({ dsid, line, name, ability, actorName, userName }) {
  await ignoreLine({ dsid, line, name });
  await ChatMessage.create({
    content: `<p>${game.i18n.format("DS_TRIGGERS.Derived.DeletedWhisper", { user: esc(userName), ability: esc(ability), actor: esc(actorName), name: esc(name) })}</p>`,
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    speaker: { alias: game.i18n.localize("DS_TRIGGERS.Derived.Speaker") },
  });
}

export function ignoreName(sourceName, lineName) {
  if (!lineName || lineName === sourceName) return sourceName;
  if (lineName.startsWith(`${sourceName} `)) return `${sourceName}: ${game.i18n.format("DS_TRIGGERS.Derived.Line", { n: lineName.slice(sourceName.length + 1) })}`;
  return `${sourceName}: ${lineName}`;
}

Hooks.on("deleteItem", (item, options, userId) => {
  const d = derivedInfo(item);
  if (!d || options.dstDerivedSync || userId !== game.user.id) return;
  if (!item.parent?.items?.get(d.sourceId)) return;
  const payload = { dsid: d.sourceDsid || d.sourceName, line: d.lineKey, name: ignoreName(d.sourceName, item.name),
    ability: item.name, actorName: item.parent?.name ?? "", userName: game.user.name };
  if (game.user.isGM) ignoreDeleted(payload);
  else _socket?.executeAsGM("derivedDeleted", payload);
});
