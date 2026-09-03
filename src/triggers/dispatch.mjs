import { MODULE_ID, getSetting, dbg } from "../util.mjs";
import { getTriggeredAbilities, isMaliceAbility } from "./registry.mjs";

const BASE_SCOPES = new Set(["SELF", "ALLY", "ENEMY", "ANY", "GROUP", "SELF_OR_ALLY"]);

function scopeMatches(clause, ownerActor, ownerDisposition, subjectActor, subjectDisposition) {
  if (!subjectActor) return true;
  if (!BASE_SCOPES.has(clause.scope)) return false;
  const isSelf = ownerActor === subjectActor;
  const sameSide = ownerDisposition != null && subjectDisposition != null
    ? ownerDisposition === subjectDisposition
    : ownerActor.hasPlayerOwner === subjectActor.hasPlayerOwner;
  switch (clause.scope) {
    case "SELF": return isSelf;
    case "ALLY": return !isSelf && sameSide;
    case "SELF_OR_ALLY": return isSelf || sameSide;
    case "ENEMY": return !isSelf && !sameSide;
    case "ANY": return true;
    case "GROUP": return !!clause.groupName && subjectActor.name.toLowerCase().includes(clause.groupName.toLowerCase());
    default: return false;
  }
}

function candidateEntries() {
  const seen = new Set();
  const entries = [];
  const addActor = (actor, disposition) => {
    if (!actor || seen.has(actor.id)) return;
    seen.add(actor.id);
    entries.push({ actor, disposition });
  };
  if (game.combat?.started) {
    for (const combatant of game.combat.combatants) {
      addActor(combatant.actor, combatant.token?.disposition ?? null);
    }
  } else {
    for (const token of canvas.tokens?.placeables ?? []) {
      addActor(token.actor, token.document.disposition);
    }
  }
  return entries;
}

function inSameCombatGroup(actorA, actorB) {
  const combat = game.combat;
  if (!combat) return false;
  const groupA = combat.combatants.find(c => c.actor === actorA)?.group;
  if (!groupA) return false;
  return combat.combatants.find(c => c.actor === actorB)?.group === groupA;
}

function canAffordCost(actor, item) {
  const cost = item.system.resource;
  if (!Number.isFinite(cost) || cost <= 0) return true;
  const coreRes = actor.system.coreResource;
  if (!coreRes) return true;
  const current = foundry.utils.getProperty(coreRes.target, coreRes.path) ?? 0;
  return current >= cost;
}

export function dispatchTriggerEvent({ event, subjectActor = null, subjectToken = null, causeLabel = "" }) {
  if (!game.users.activeGM?.isSelf) return;
  if (!getSetting("chatReminders")) return;

  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const subjectDisposition = subjectToken?.disposition ?? null;
  const matches = [];

  
  const candidates = candidateEntries().sort((a, b) => (b.actor === subjectActor) - (a.actor === subjectActor));
  const maliceSeen = new Set();

  for (const { actor, disposition } of candidates) {
    if (actor.statuses?.has(defeated)) continue;
    for (const entry of getTriggeredAbilities(actor)) {
      if (entry.item.system.restricted) continue;
      if (!canAffordCost(actor, entry.item)) continue;
      const malice = isMaliceAbility(entry.item);
      if (malice && subjectActor && subjectActor !== actor && !inSameCombatGroup(actor, subjectActor)) continue;
      if (malice) {
        if (maliceSeen.has(entry.item.name)) continue;
        maliceSeen.add(entry.item.name);
      }
      
      const clause = entry.parse?.clauses?.find(c =>
        c.event === event && (malice || scopeMatches(c, actor, disposition, subjectActor, subjectDisposition)));
      if (!clause) continue;
      
      if (clause.ownerUnacted && game.combat?.started) {
        const combatant = game.combat.combatants.find(c => c.actor === actor);
        if (combatant && !(combatant.initiative > 0)) continue;
      }
      if (clause.anyHeroUnacted && game.combat?.started) {
        if (!game.combat.combatants.some(c => c.actor?.type === "hero" && c.initiative > 0)) continue;
      }
      matches.push({ actor, item: entry.item, free: entry.free, malice });
    }
  }

  if (!matches.length) return;
  dbg(`event ${event} matched ${matches.length} abilities`, { causeLabel, matches });

  
  const groups = new Map();
  for (const match of matches) {
    const recipients = game.users.filter(u => u.isGM || match.actor.testUserPermission(u, "OWNER")).map(u => u.id);
    const key = recipients.sort().join(".");
    if (!groups.has(key)) groups.set(key, { recipients, matches: [] });
    groups.get(key).matches.push(match);
  }

  for (const group of groups.values()) {
    
    group.matches.sort((a, b) => {
      if (a.malice !== b.malice) return a.malice ? 1 : -1;
      if (!a.malice) return 0;
      return (a.item.system.resource ?? 999) - (b.item.system.resource ?? 999);
    });
    const items = group.matches.map(m => {
      let freeTag = m.free ? ` <span class="dst-free">${game.i18n.localize("DS_TRIGGERS.Reminder.Free")}</span>` : "";
      if (m.malice) {
        const cost = Number.isFinite(m.item.system.resource) ? ` ${m.item.system.resource}` : "";
        freeTag += ` <span class="dst-malice">${game.i18n.localize("DS_TRIGGERS.Reminder.Malice")}${cost}</span>`;
        const actionType = m.item.system.type;
        let typeLabel = null;
        if (actionType === "triggered") typeLabel = game.i18n.localize("DS_TRIGGERS.Reminder.Triggered");
        else if (actionType === "freeTriggered") typeLabel = game.i18n.localize("DS_TRIGGERS.Reminder.Free");
        else if (actionType && actionType !== "none") typeLabel = game.i18n.localize(ds.CONFIG.abilities.types[actionType]?.label ?? "");
        if (typeLabel) freeTag += ` <span class="dst-free">${typeLabel}</span>`;
      }
      const link = `<a class="dst-ability-link" data-item-uuid="${m.item.uuid}" data-tooltip="${game.i18n.localize("DS_TRIGGERS.Reminder.LinkTooltip")}"><strong>${m.item.name}</strong></a>`;
      const trigger = m.item.system.trigger || (m.malice ? game.i18n.localize("DS_TRIGGERS.Reminder.ImplicitMaliceTrigger") : "");
      
      let ownerPart = "";
      if (m.actor !== subjectActor) {
        const name = m.actor.name.length > 20 ? m.actor.name.slice(0, 19).trimEnd() + "…" : m.actor.name;
        ownerPart = ` (${name})`;
      }
      return `<li>${link}${ownerPart}${freeTag}<br><em>${trigger}</em></li>`;
    }).join("");
    ChatMessage.create({
      content: `<div class="dst-reminder"><p class="dst-reminder-header">${game.i18n.localize("DS_TRIGGERS.Reminder.Header")}</p><p>${causeLabel}</p><ul>${items}</ul></div>`,
      whisper: group.recipients,
      speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
      flags: { [MODULE_ID]: { reminder: { event } } },
    });
  }
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.getFlag(MODULE_ID, "reminder")) return;
  for (const link of html.querySelectorAll(".dst-ability-link")) {
    link.addEventListener("click", async (clickEvent) => {
      const item = await fromUuid(link.dataset.itemUuid).catch(() => null);
      if (!item) {
        ui.notifications.warn("DS_TRIGGERS.Reminder.MissingAbility", { localize: true });
        return;
      }
      if (clickEvent.shiftKey) {
        await ds.documents.DrawSteelChatMessage.create({
          content: `@Embed[${item.uuid} caption=false]`,
          type: "standard",
          "system.parts": [{ type: "content" }],
          speaker: ds.documents.DrawSteelChatMessage.getSpeaker({ actor: item.actor }),
          title: item.name,
          flags: { core: { canPopout: true } },
        });
      } else {
        await item.system.use();
      }
    });
  }
});
