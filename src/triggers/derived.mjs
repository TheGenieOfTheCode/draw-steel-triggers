import { MODULE_ID, dbg, isPrimaryGM, getSetting, executeAsDirector } from "../util.mjs";
import { FEATURE_ACTOR_TYPES, itemEffectiveLines, itemFeatureLines, featureTriggersActive, ignoreLine, isLineSource, lineCost, linePool } from "./feature-triggers.mjs";
import { enricherText, asOwner, abilityEffectHTML } from "../parser/feature-triggers.mjs";
import { parseTrigger } from "../parser/trigger-parser.mjs";
import { prerequisites } from "../ui/feature-card.mjs";
import { cardContent, facesIn, postSystemCard } from "../ui/system-card.mjs";
import { remindConsumable } from "./consumables.mjs";

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

function effectHTML(source, line, useMacro = null) {
  let effect = esc(cap(line.effect ?? "").replace(/\bdamage damage\b/g, "damage"));
  const html = source.type === "ability" ? abilityEffectHTML(source) : source.system?.description?.value;
  const placed = [];
  const hold = (markup) => `\u0000${placed.push(markup) - 1}\u0000`;
  for (const m of String(html ?? "").matchAll(ENRICHER)) {
    const text = esc(enricherText(m[1], m[2]));
    const at = text ? effect.toLowerCase().indexOf(text.toLowerCase()) : -1;
    if (at >= 0) effect = effect.slice(0, at) + hold(m[0]) + effect.slice(at + text.length);
  }
  if (useMacro) effect = effect.replace(THIS_ABILITY, (words) => hold(`@UUID[${useMacro.uuid}]{${words}}`));
  return `<p>${effect.replace(/\u0000(\d+)\u0000/g, (_m, i) => placed[Number(i)])}</p>`;
}

const SCOPE_TARGETS = { SELF: { type: "self" }, ALLY: { type: "ally", value: 1 }, ENEMY: { type: "enemy", value: 1 },
  ANY: { type: "creature", value: 1 }, GROUP: { type: "creature", value: 1 }, SELF_OR_ALLY: { type: "selfOrAlly" }, OBJECT: { type: "object", value: 1 } };

const EFFECT_TARGETS = [
  [/\b(?:that|the triggering|the) enem(?:y|ies)\b/i, "ENEMY"],
  [/\b(?:that|the triggering) all(?:y|ies)\b/i, "ALLY"],
  [/\b(?:that|the triggering) creatures?\b/i, null],
];

function reachOf(parse, effect = "") {
  const clause = parse?.clauses?.find((c) => c.event && c.event !== "UNKNOWN") ?? null;
  let scope = clause?.scope;
  const named = EFFECT_TARGETS.find(([rx]) => rx.test(effect));
  if (named) {
    const other = clause?.sourceScope ?? clause?.victimScope ?? (scope && scope !== "SELF" ? scope : null);
    scope = named[1] ?? other ?? "ANY";
  }
  const target = SCOPE_TARGETS[scope] ?? { type: "special" };
  const range = Number.isFinite(clause?.range) && clause.range > 0 ? clause.range : null;
  const distance = clause?.rangeMin ? { type: "special" }
    : range === 1 ? { type: "melee", primary: "1" }
    : range ? { type: "ranged", primary: String(range) }
      : target.type === "self" ? { type: "self" } : { type: "special" };
  return { distance, target };
}

const THIS_ABILITY = /(?<=\buses? )this ability\b/i;
const useCommand = (source) => `ds.helpers.macros.rollItemMacro("${source.uuid}");`;

async function ensureUseMacro(source) {
  const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  const owners = game.users.filter((u) => !u.isGM && source.actor?.testUserPermission(u, "OWNER")).map((u) => u.id);
  let macro = game.macros.find((m) => m.command === useCommand(source)) ?? null;
  if (!macro) {
    if (!game.user.can("MACRO_SCRIPT")) return null;
    macro = await Macro.implementation.create({
      name: source.name, type: "script", img: source.img, command: useCommand(source),
      ...(game.user.isGM ? { ownership: { default: 0, ...Object.fromEntries(owners.map((id) => [id, LIMITED])) } } : {}),
      flags: { "draw-steel": { itemMacro: true }, [MODULE_ID]: { useMacro: true } },
    });
    if (!macro) return null;
  }
  const missing = owners.filter((id) => (macro.ownership[id] ?? macro.ownership.default ?? 0) < LIMITED);
  if (missing.length) {
    const ownership = Object.fromEntries(missing.map((id) => [id, LIMITED]));
    if (game.user.isGM) await macro.update({ ownership });
    else executeAsDirector(_socket, "useMacroOwnership", macro.uuid, ownership);
  }
  return macro;
}

async function grantUseMacro(uuid, ownership) {
  const macro = await fromUuid(uuid);
  if (macro?.documentName !== "Macro" || !macro.getFlag(MODULE_ID, "useMacro")) return;
  const LIMITED = CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED;
  await macro.update({ ownership: Object.fromEntries(Object.keys(ownership ?? {}).filter((id) => game.users.get(id)).map((id) => [id, LIMITED])) });
}

function effectsUpdate(item, effects) {
  const DEL = foundry.data?.operators?.ForcedDeletion;
  const out = foundry.utils.deepClone(effects);
  for (const key of Object.keys(item._source.system?.effects ?? {})) {
    if (!(key in out)) out[key] = DEL ? new DEL() : null;
  }
  return out;
}

const effectsMatch = (item, effects) => {
  const have = item._source.system?.effects ?? {};
  return Object.keys(have).length === Object.keys(effects).length
    && Object.entries(effects).every(([key, e]) => have[key]?.description === e.description && have[key]?.name === e.name);
};

function specFor(source, line, useMacro = null) {
  const prereqs = prerequisites(source, line.tier);
  const effects = {
    after00000000000: { _id: "after00000000000", type: "base", name: "", img: null, sort: 1, before: false, description: effectHTML(source, line, useMacro) },
  };
  if (prereqs.length) {
    const label = game.i18n.localize(`DS_TRIGGERS.Card.${prereqs.length > 1 ? "Prerequisites" : "Prerequisite"}`);
    effects.before0000000000 = { _id: "before0000000000", type: "base", name: label, img: null, sort: 0, before: true,
      description: `<p>${prereqs.map((c, i) => esc(i ? `${game.i18n.localize("DS_TRIGGERS.Card.And")} ${c}` : cap(c))).join(", ")}</p>` };
  }
  const system = {
    type: line.action ?? "none",
    resource: linePool(source.actor, line) === "system.hero.primary.value" ? lineCost(source.actor, line) : null,
    trigger: line.trigger,
    story: line.flavor ?? "",
    keywords: [],
    ...reachOf(line.parse, line.effect),
    _dsid: line.key,
    effects,
  };
  const flag = {
    sourceId: source.id, sourceName: source.name, sourceDsid: String(source.system?._dsid ?? "").toLowerCase(),
    lineKey: line.key, exclusive: line.exclusive ?? null, once: line.once ?? null, tier: line.tier ?? null, family: line.family ?? null,
    epicCost: linePool(source.actor, line) === "system.hero.epic.value" ? lineCost(source.actor, line) : null,
    spendsRecovery: /^spend a recovery\.?$/i.test(String(line.effect ?? "").trim()) || null,
    hash: "", edited: false,
  };
  const out = { name: line.name, type: "ability", img: source.img, system, flags: { [MODULE_ID]: { [FLAG]: flag } } };
  if (line.overridden && line.parse?.source === "manual") {
    Object.assign(out.flags[MODULE_ID], { manual: true, trigger: { clauses: line.parse.clauses } });
  }
  
  Hooks.callAll("draw-steel-triggers.derivedSpec", out, { source, line });
  const others = Object.fromEntries(Object.entries(out.flags).filter(([scope]) => scope !== MODULE_ID));
  flag.hash = JSON.stringify({ name: out.name, img: out.img, system: out.system, once: line.once ?? null, tier: line.tier ?? null, epic: flag.epicCost, recovery: flag.spendsRecovery, others });
  flag.contributed = Object.keys(others);
  return out;
}

function otherFlags(spec, item = null) {
  const DEL = foundry.data?.operators?.ForcedDeletion;
  const now = Object.fromEntries(Object.entries(spec.flags ?? {})
    .filter(([scope]) => scope !== MODULE_ID).map(([scope, data]) => [`flags.${scope}`, data]));
  for (const scope of item?.getFlag(MODULE_ID, FLAG)?.contributed ?? []) {
    if (!(`flags.${scope}` in now)) now[`flags.${scope}`] = DEL ? new DEL() : null;
  }
  return now;
}

const _parseCache = new Map();

export function derivedParse(item) {
  if (item.getFlag(MODULE_ID, "manual")) {
    const stored = item.getFlag(MODULE_ID, "trigger");
    if (stored?.clauses?.length) return { clauses: stored.clauses, confidence: "high", source: "manual" };
  }
  const text = String(item.system?.trigger ?? "").trim().replace(/[.!]+$/, "");
  
  const d = derivedInfo(item);
  const source = d && !d.edited ? sourceOf(item) : null;
  const line = source ? itemFeatureLines(source, { withIgnored: true }).find((l) => l.key === d.lineKey) : null;
  if (line?.parse && line.trigger.replace(/[.!]+$/, "") === text) return line.parse;
  const ownerName = item.actor && item.actor.type !== "hero" ? item.actor.name : "";
  const effectText = (item.system?.effects?.contents ?? []).map((e) => e.description ?? "").join(" ").replace(/<[^>]+>/g, " ");
  const cached = _parseCache.get(item.uuid);
  if (cached && cached.text === text && cached.ownerName === ownerName && cached.effectText === effectText) return cached.result;
  const result = parseTrigger(`${ownerName ? asOwner(text, ownerName) : text}.`, { effectText, ownerName, side: ownerName ? "monster" : "hero" });
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
      if (!isLineSource(item)) continue;
      for (const line of itemEffectiveLines(item)) {
        if (!line.enabled || line.watch === "parked") continue;
        const useMacro = item.type === "ability" && THIS_ABILITY.test(line.effect ?? "") ? await ensureUseMacro(item) : null;
        want.set(`${item.id}|${line.key}`, specFor(item, line, useMacro));
      }
    }
    const have = new Map();
    for (const item of actor.items) {
      const d = derivedInfo(item);
      if (d) have.set(`${d.sourceId}|${d.lineKey}`, item);
    }
    const creates = [...want].filter(([k]) => !have.has(k)).map(([, spec]) => spec);
    const updates = [];
    const deletes = [];
    for (const [k, item] of have) {
      const d = derivedInfo(item);
      const spec = want.get(k);
      if (!spec) {
        if (!d.edited) deletes.push(item.id);
        continue;
      }
      if (d.edited || (d.hash === spec.flags[MODULE_ID][FLAG].hash && effectsMatch(item, spec.system.effects))) continue;
      updates.push({ _id: item.id, name: item.getFlag(MODULE_ID, NAME_FLAG) ?? spec.name, img: item.getFlag(MODULE_ID, IMG_FLAG) ?? spec.img, system: { ...spec.system, effects: effectsUpdate(item, spec.system.effects) },
        [`flags.${MODULE_ID}.${FLAG}`]: spec.flags[MODULE_ID][FLAG], ...otherFlags(spec, item) });
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
  const useMacro = source.type === "ability" && THIS_ABILITY.test(line.effect ?? "") ? await ensureUseMacro(source) : null;
  const spec = specFor(source, line, useMacro);
  const DEL = foundry.data?.operators?.ForcedDeletion;
  await item.update({
    name: item.getFlag(MODULE_ID, NAME_FLAG) ?? spec.name, img: item.getFlag(MODULE_ID, IMG_FLAG) ?? spec.img, system: { ...spec.system, effects: effectsUpdate(item, spec.system.effects) },
    [`flags.${MODULE_ID}.${FLAG}`]: spec.flags[MODULE_ID][FLAG], ...otherFlags(spec, item),
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

const isSource = (item) => isLineSource(item) && item.parent?.documentName === "Actor";

Hooks.once("ready", () => {
  for (const actor of game.actors) if (actor.type === "hero") queueSync(actor);
});
Hooks.on("createCombatant", (combatant) => queueSync(combatant.actor));
Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  const use = Array.from(message.system?.parts?.contents ?? []).find((p) => p.type === "abilityUse");
  const ability = use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null;
  const info = derivedInfo(ability);
  const actor = ability?.actor;
  const added = ability?.getFlag(MODULE_ID, "useImpacts");
  if (!actor || (!info && !added?.spendsRecovery)) return;
  if (!info) return spendRecoveryFor(actor, ability);
  const cost = Number(info.epicCost) || 0;
  if (cost) {
    const held = Number(actor.system?.hero?.epic?.value ?? 0);
    actor.update({ "system.hero.epic.value": Math.max(0, held - cost) }).catch(() => {});
    dbg(`${actor.name} spent ${cost} ${actor.system?.hero?.epic?.label ?? "epic"} on ${ability.name}`);
  }
  remindConsumable(actor, actor.items.get(info.sourceId));
  if (info.spendsRecovery || added?.spendsRecovery) spendRecoveryFor(actor, ability);
});

function spendRecoveryFor(actor, ability) {
  if (typeof actor.system?.spendRecovery !== "function") return;
  actor.system.spendRecovery().catch((err) => console.warn(`${MODULE_ID} | ${ability.name} could not spend a Recovery`, err));
}
Hooks.on("createItem", (item) => { if (isSource(item)) queueSync(item.parent); });
Hooks.on("deleteItem", (item) => { if (isSource(item)) queueSync(item.parent); });
Hooks.on("updateItem", (item, changes) => {
  if (isSource(item) && (foundry.utils.hasProperty(changes, "system.description") || foundry.utils.hasProperty(changes, "system.effects") || "name" in changes
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.featureLines`))) queueSync(item.parent);
});
Hooks.on("renderApplicationV2", (app) => {
  const doc = app.document;
  if (doc?.documentName === "Actor" && FEATURE_ACTOR_TYPES.has(doc.type)) queueSync(doc);
});
Hooks.on("dst.ignoredFeaturesChanged", () => {
  for (const actor of game.actors) if (actor.items.some(isDerived)) queueSync(actor);
});

export function refreshDerived() {
  for (const actor of game.actors) if (actor.type === "hero" || actor.items.some(isDerived)) queueSync(actor);
}
Hooks.on("draw-steel-triggers.derivedNamesChanged", refreshDerived);

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
  _socket?.register("useMacroOwnership", (uuid, ownership) => grantUseMacro(uuid, ownership));
});

async function ignoreDeleted({ dsid, line, name, ability, actorName, actorUuid = null, userName }) {
  await ignoreLine({ dsid, line, name });
  const sentence = game.i18n.format("DS_TRIGGERS.Derived.DeletedWhisper", { user: esc(userName), ability: esc(ability), actor: esc(actorName), name: esc(name) });
  await postSystemCard({
    title: game.i18n.localize("DS_TRIGGERS.Derived.DeletedTitle"),
    flavor: null,
    kind: "Derived",
    content: cardContent({ intro: facesIn(sentence, [actorUuid ? fromUuidSync(actorUuid) : null].filter(Boolean)) }),
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    flags: { [MODULE_ID]: { notice: "derivedDeleted" } },
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
    ability: item.name, actorName: item.parent?.name ?? "", actorUuid: item.parent?.uuid ?? null, userName: game.user.name };
  if (game.user.isGM) ignoreDeleted(payload);
  else executeAsDirector(_socket, "derivedDeleted", payload);
});
