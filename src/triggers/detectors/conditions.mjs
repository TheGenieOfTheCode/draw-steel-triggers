import { dispatchTriggerEvent } from "../dispatch.mjs";
import { getSetting, dbg, isPrimaryGM } from "../../util.mjs";

const SAVE_OR_EOT = new Set(["save", "turnEnd"]);

function _actorOf(effect) {
  const parent = effect.parent;
  if (parent?.documentName === "Actor") return parent;
  if (parent?.documentName === "Item") return parent.actor ?? null;
  return null;
}

function _sourcesOf(effect) {
  const out = new Set();
  for (const change of effect.system?.changes ?? []) {
    if (/^system\.statuses\.[\w-]+\.sources$/.test(change.key ?? "") && change.value) out.add(change.value);
  }
  if (effect.origin) {
    const doc = fromUuidSync(effect.origin, { strict: false });
    const actor = doc?.documentName === "Actor" ? doc : doc?.actor ?? null;
    if (actor) out.add(actor.uuid);
  }
  return [...out];
}

function _nameOf(uuids) {
  for (const uuid of uuids) {
    const doc = fromUuidSync(uuid, { strict: false });
    if (doc?.name) return doc.name;
  }
  return null;
}

function _statusLabel(status) {
  const name = CONFIG.statusEffects?.find((s) => s.id === status)?.name;
  return name ? game.i18n.localize(name) : status;
}

function _live() {
  if (!isPrimaryGM()) return false;
  if (!getSetting("chatReminders") && !getSetting("conditionPrompts")) return false;
  return !!game.combat?.started;
}

const DSCT = "draw-steel-combat-tools";

function _dsctGrab(effect) {
  const grab = effect.flags?.[DSCT]?.grab;
  if (!grab?.grabbedId || !grab?.grabberId) return null;
  const grabbed = canvas.tokens?.get(grab.grabbedId)?.actor ?? null;
  const grabber = canvas.tokens?.get(grab.grabberId)?.actor ?? _actorOf(effect);
  if (!grabbed || !grabber) return null;
  return { grabbed, grabbedToken: canvas.tokens.get(grab.grabbedId).document, grabber };
}

function _gained(effect) {
  if (!_live() || effect.disabled || effect.isSuppressed) return;
  if (effect.flags?.[DSCT]?.grabbed) return;
  const grab = _dsctGrab(effect);
  if (grab) {
    dbg(`condition gained: ${grab.grabbed.name} is grabbed by ${grab.grabber.name} (Combat Tools grab)`);
    dispatchTriggerEvent({
      event: "CONDITION_GAIN",
      subjectActor: grab.grabbed,
      subjectToken: grab.grabbedToken,
      eventContext: { expiry: "combatEnd", sourceActorUuids: [grab.grabber.uuid], effectName: "grabbed", condition: "grabbed" },
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.ConditionGainBy", { name: grab.grabbed.name, condition: _statusLabel("grabbed"), by: grab.grabber.name }),
    });
    return;
  }
  const actor = _actorOf(effect);
  if (!actor) return;
  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const sources = _sourcesOf(effect);
  const by = _nameOf(sources);
  const expiry = effect.duration?.expiry ?? null;
  const context = { expiry, sourceActorUuids: sources, effectName: effect.name.toLowerCase() };
  const statuses = [...(effect.statuses ?? [])];

  if (statuses.length) {
    for (const status of statuses) {
      dbg(`condition gained: ${actor.name} is ${status}${by ? ` (from ${by})` : ""}, ends on ${expiry ?? "nothing"}`);
      dispatchTriggerEvent({
        event: "CONDITION_GAIN",
        subjectActor: actor,
        subjectToken: token,
        eventContext: { ...context, condition: status },
        causeLabel: by
          ? game.i18n.format("DS_TRIGGERS.Reminder.ConditionGainBy", { name: actor.name, condition: _statusLabel(status), by })
          : game.i18n.format("DS_TRIGGERS.Reminder.ConditionGain", { name: actor.name, condition: _statusLabel(status) }),
      });
    }
    return;
  }
  if (!SAVE_OR_EOT.has(expiry)) return;
  dbg(`effect gained: ${actor.name} is under ${effect.name}, ends on ${expiry}`);
  dispatchTriggerEvent({
    event: "CONDITION_GAIN",
    subjectActor: actor,
    subjectToken: token,
    eventContext: { ...context, condition: null },
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.EffectGain", { name: actor.name, effect: effect.name }),
  });
}

function _ended(effect) {
  if (!_live()) return;
  if (effect.flags?.[DSCT]?.grabbed) return;
  const grab = _dsctGrab(effect);
  if (grab) {
    dbg(`grab ended: ${grab.grabber.name} no longer holds ${grab.grabbed.name} (Combat Tools grab)`);
    dispatchTriggerEvent({
      event: "GRAB_ENDS",
      subjectActor: grab.grabbed,
      subjectToken: grab.grabbedToken,
      eventContext: { expiry: "combatEnd", sourceActorUuids: [grab.grabber.uuid], effectName: "grabbed", condition: "grabbed" },
      causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.GrabEndsBy", { name: grab.grabbed.name, by: grab.grabber.name }),
    });
    return;
  }
  const actor = _actorOf(effect);
  if (!actor) return;
  const token = actor.getActiveTokens(true, true)[0] ?? null;
  const sources = _sourcesOf(effect);
  const context = { expiry: effect.duration?.expiry ?? null, sourceActorUuids: sources, effectName: effect.name.toLowerCase() };
  const statuses = [...(effect.statuses ?? [])];

  if (statuses.includes("grabbed")) {
    const by = _nameOf(sources);
    dbg(`grab ended: ${actor.name} is no longer grabbed${by ? ` by ${by}` : ""}`);
    dispatchTriggerEvent({
      event: "GRAB_ENDS",
      subjectActor: actor,
      subjectToken: token,
      eventContext: { ...context, condition: "grabbed" },
      causeLabel: by
        ? game.i18n.format("DS_TRIGGERS.Reminder.GrabEndsBy", { name: actor.name, by })
        : game.i18n.format("DS_TRIGGERS.Reminder.GrabEnds", { name: actor.name }),
    });
  }
  dbg(`effect ended: ${effect.name} on ${actor.name}`);
  dispatchTriggerEvent({
    event: "EFFECT_ENDS",
    subjectActor: actor,
    subjectToken: token,
    eventContext: context,
    causeLabel: game.i18n.format("DS_TRIGGERS.Reminder.EffectEnds", { name: actor.name, effect: effect.name }),
  });
}

Hooks.on("createActiveEffect", (effect) => _gained(effect));
Hooks.on("deleteActiveEffect", (effect) => _ended(effect));
Hooks.on("updateActiveEffect", (effect, changed) => {
  if (changed.disabled === false) _gained(effect);
  else if (changed.disabled === true) _ended(effect);
});
