import { dispatchTriggerEvent, triggersLive } from "../dispatch.mjs";
import { isPrimaryGM, dbg } from "../../util.mjs";
import { usedFromMessage, targetsOf } from "./ability-use.mjs";

const SOURCES = new Map();

export function registerFormChanges(source, entries) {
  SOURCES.set(source, (entries ?? []).filter((e) => e?.name || e?.dsid));
}

const norm = (name) => String(name ?? "").toLowerCase().replace(/[’]/g, "'").replace(/\s*\([^)]*\)\s*$/, "").trim();

function modeOf(item) {
  if (!item) return null;
  const dsid = item.system?._dsid || item.dsid;
  const name = norm(item.name);
  for (const list of SOURCES.values()) {
    for (const entry of list) {
      if ((entry.dsid && entry.dsid === dsid) || (entry.name && norm(entry.name) === name)) return entry.mode ?? "self";
    }
  }
  return null;
}

const tokenOf = (actor) => actor.token ?? actor.getActiveTokens?.()[0]?.document ?? null;

function fire(actor, token, ability) {
  token ??= tokenOf(actor);
  dbg(`${actor.name} changed form through ${ability.name}`);
  dispatchTriggerEvent({
    event: "FORM_CHANGES",
    subjectActor: actor,
    subjectToken: token,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.FormChanges", { name: token?.name ?? actor.name, ability: ability.name }),
  });
}

Hooks.on("createChatMessage", (message) => {
  if (!SOURCES.size || !isPrimaryGM() || !triggersLive()) return;
  const used = usedFromMessage(message);
  const mode = modeOf(used?.item);
  if (mode === "self") fire(used.actor, used.token, used.item);
  else if (mode === "targets") {
    const targets = targetsOf(message).filter((t) => t.actor);
    if (!targets.length) fire(used.actor, used.token, used.item);
    for (const target of targets) fire(target.actor, target, used.item);
  }
});

const recent = new Set();

Hooks.on("createActiveEffect", (effect) => {
  if (!SOURCES.size || effect.disabled || !effect.origin || !isPrimaryGM() || !triggersLive()) return;
  const actor = effect.parent?.documentName === "Actor" ? effect.parent : null;
  const ability = fromUuidSync(effect.origin, { strict: false });
  if (!actor || ability?.documentName !== "Item" || modeOf(ability) !== "effect") return;
  
  const key = `${actor.uuid}|${ability.uuid}`;
  if (recent.has(key)) return;
  recent.add(key);
  setTimeout(() => recent.delete(key), 2000);
  fire(actor, null, ability);
});
