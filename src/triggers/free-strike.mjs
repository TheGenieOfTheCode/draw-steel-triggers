import { MODULE_ID, getSetting } from "../util.mjs";
import { enqueuePromptEntries } from "./queue.mjs";

const L = (key) => game.i18n.localize(`DS_TRIGGERS.FreeStrike.${key}`);

export async function freeStrike(actor, kind = "") {
  if (actor && actor.type !== "hero" && actor.system?.performFreeStrike) return actor.system.performFreeStrike();
  const strikes = (actor?.items ?? []).filter((i) => ["melee-free-strike", "ranged-free-strike"].includes(i.system?._dsid)
    && (!kind || i.system._dsid === `${kind}-free-strike`));
  if (!strikes.length) return ui.notifications.warn(L("None"));
  let pick = strikes[0];
  if (strikes.length > 1) {
    const id = await foundry.applications.api.DialogV2.wait({ window: { title: L("Title") },
      buttons: strikes.map((i) => ({ action: i.id, label: i.name })), rejectClose: false }).catch(() => null);
    pick = strikes.find((i) => i.id === id);
    if (!pick) return null;
  }
  return ds.helpers.macros.rollItemMacro(pick.uuid);
}

const strikeMessage = (actor) => new Promise((resolve) => {
  const done = (m) => { Hooks.off("createChatMessage", hook); clearTimeout(timer); resolve(m); };
  const hook = Hooks.on("createChatMessage", (m) => {
    if (m.speaker?.actor === actor.id && [...(m.system?.parts?.contents ?? [])].some((p) => p.type === "abilityUse")) done(m);
  });
  const timer = setTimeout(() => done(null), 60000);
});

function striker(a, message) {
  if (a.dataset.by !== "target") return fromUuidSync(a.dataset.actorUuid ?? "") ?? message?.speakerActor;
  const listed = (message?.flags?.["draw-steel-target-damage"]?.state?.targets ?? []).map((t) => fromUuidSync(t.tokenUuid)?.actor).filter(Boolean);
  const targets = listed.length ? listed : [...game.user.targets].map((t) => t.actor).filter(Boolean);
  return targets.length === 1 ? targets[0] : null;
}

async function onFreeStrike(event) {
  event.preventDefault();
  const a = event.currentTarget;
  const message = game.messages.get(a.closest("[data-message-id]")?.dataset.messageId);
  const actor = striker(a, message) ?? canvas.tokens.controlled[0]?.actor ?? game.user.character;
  if (!actor) return ui.notifications.warn(L("None"));
  const made = a.dataset.type ? strikeMessage(actor) : null;
  await freeStrike(actor, a.dataset.kind);
  const strike = await made;
  const modifiers = game.modules.get("draw-steel-combat-tools")?.api?.globalModifiers;
  if (strike && modifiers?.addDamage) await modifiers.addDamage(strike, [{ kind: "type", value: a.dataset.type, label: a.dataset.source ?? "" }]);
}

Hooks.once("init", () => {
  CONFIG.TextEditor.enrichers.push({
    id: "dst.freestrike",
    pattern: /\[\[\/freestrike(?<config>[^\]]*)\]\](?:\{(?<label>[^}]+)\})?/gi,
    enricher: async (match, options) => {
      const words = (match.groups.config ?? "").trim().split(/\s+/).filter(Boolean);
      const a = document.createElement("a");
      a.className = "dst-free-strike content-link";
      a.dataset.kind = words.find((w) => /^(melee|ranged)$/i.test(w))?.toLowerCase() ?? "";
      a.dataset.type = words.find((w) => w.startsWith("type="))?.slice(5) ?? "";
      a.dataset.by = words.find((w) => w.startsWith("by="))?.slice(3) ?? "";
      const owner = options?.relativeTo;
      if (owner?.actor && a.dataset.by !== "target") a.dataset.actorUuid = owner.actor.uuid;
      if (owner?.name) a.dataset.source = owner.name;
      a.innerHTML = '<i class="fa-solid fa-hand-back-fist" inert></i> ';
      a.append(match.groups.label ?? L("Link"));
      return a;
    },
    onRender: (element) => element.querySelector("a.dst-free-strike")?.addEventListener("click", onFreeStrike),
  });
});

export function offerFreeStrike({ striker, target, causeLabel = "", meta = null }) {
  const actor = striker?.actor ?? striker;
  const item = actor?.items?.find((i) => i.system?._dsid === "melee-free-strike");
  const targetUuid = target?.document?.uuid ?? target?.uuid ?? null;
  if (!item || !targetUuid) return null;
  const [entry] = enqueuePromptEntries([{ actor, item, _subjectTokenUuid: targetUuid, _meta: meta }], { event: "OPPORTUNITY_ATTACK", causeLabel, subjectTokenUuid: targetUuid });
  return entry?.id ?? null;
}

export async function postFreeStrikeCard(actor) {
  const strike = actor.system.freeStrike;
  const title = game.i18n.localize("DRAW_STEEL.Actor.npc.FreeStrike.DialogTitle");
  const roll = new ds.rolls.DamageRoll(String(strike.value), { type: strike.type, flavor: ds.CONFIG.damageTypes[strike.type]?.label });
  await roll.evaluate();
  return ChatMessage.implementation.create({
    title,
    speaker: ChatMessage.implementation.getSpeaker({ actor, token: actor.token ?? undefined }),
    type: "standard",
    "system.parts": [{ rolls: [roll], flavor: title, type: "roll" }],
    flags: { core: { canPopout: true }, [MODULE_ID]: { freeStrike: true } },
  });
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) return;
  libWrapper.register(MODULE_ID, "ds.data.Actor.NPCModel.prototype.performFreeStrike", async function (wrapped, ...args) {
    if (!game.user.isGM || !getSetting("freeStrikeCards")) return wrapped(...args);
    if (await game.modules.get("draw-steel-combat-tools")?.api?.squadFreeStrike?.(this.parent)) return;
    await postFreeStrikeCard(this.parent);
  }, "MIXED");
});
