import { MODULE_ID, getSetting, dbg, emblemHTML } from "../util.mjs";
import { getTriggeredAbilities, isMaliceAbility } from "./registry.mjs";
import { isTriggeredActionSpent } from "./spent-tracking.mjs";
import { enqueuePromptEntries } from "./queue.mjs";
import { maliceChipURI } from "../ui/malice-chip.mjs";

const PROMPT_EVENTS = new Set(["TAKES_DAMAGE", "DIES", "WINDED_OR_DYING"]);

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
    case "GROUP": {
      if (!clause.groupName) return false;
      const kw = clause.groupName;
      
      if (subjectActor.system?.monster?.keywords?.has?.(kw)) return true;
      const name = subjectActor.name.toLowerCase();
      if (name.includes(kw.toLowerCase())) return true;
      const kwLabel = ds.CONFIG.monsters?.keywords?.[kw]?.label;
      return !!kwLabel && name.includes(game.i18n.localize(kwLabel).toLowerCase());
    }
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

export function collectTriggerMatches(event, subjectActor = null, subjectToken = null) {
  const defeated = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  const subjectDisposition = subjectToken?.disposition ?? null;
  const matches = [];

  const candidates = candidateEntries().sort((a, b) => (b.actor === subjectActor) - (a.actor === subjectActor));
  const maliceSeen = new Set();

  for (const { actor, disposition } of candidates) {
    if (actor.statuses?.has(defeated)) continue;
    const spent = isTriggeredActionSpent(actor);
    for (const entry of getTriggeredAbilities(actor)) {
      if (entry.item.system.restricted) continue;
      if (!canAffordCost(actor, entry.item)) continue;
      const malice = isMaliceAbility(entry.item);
      if (spent && !entry.free && !malice) continue;
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
      matches.push({ actor, item: entry.item, free: entry.free, malice, clause, parse: entry.parse });
    }
  }
  return matches;
}

export function dispatchTriggerEvent({ event, subjectActor = null, subjectToken = null, causeLabel = "" }) {
  if (!game.users.activeGM?.isSelf) return;

  let matches = collectTriggerMatches(event, subjectActor, subjectToken);
  if (!matches.length) return;

  
  
  if (PROMPT_EVENTS.has(event) && getSetting("damagePrompts")) {
    const prompts = matches.filter((m) =>
      !m.malice && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
    if (prompts.length) enqueuePromptEntries(prompts, { event, causeLabel });
    matches = matches.filter((m) => !prompts.includes(m));
  }

  if (!matches.length) return;
  if (!getSetting("chatReminders")) return;

  
  if (event === "TURN_START" && subjectActor) {
    const maliceMatches = matches.filter((m) => m.malice);
    if (maliceMatches.length) {
      _sendMaliceCard(maliceMatches, subjectActor);
      matches = matches.filter((m) => !m.malice);
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
      content: `<div class="dst-reminder"><p class="dst-reminder-header"><span class="dst-emblem">${emblemHTML()}</span>${game.i18n.localize("DS_TRIGGERS.Reminder.Header")}</p><p>${causeLabel}</p><ul>${items}</ul></div>`,
      whisper: group.recipients,
      speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
      flags: { [MODULE_ID]: { reminder: { event } } },
    });
  }
}

function _neutralizeStatusLinks(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const el of div.querySelectorAll('.roll-link[data-type="status"], .roll-link[data-type="custom"]')) {
    el.removeAttribute("data-type");
    el.classList.add("dst-inert-link");
  }
  return div.innerHTML;
}

async function _sendMaliceCard(matches, subjectActor) {
  matches.sort((a, b) => (a.item.system.resource ?? 999) - (b.item.system.resource ?? 999));
  const L = (k) => game.i18n.localize(`DS_TRIGGERS.MaliceCard.${k}`);
  const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;

  const rows = (await Promise.all(matches.map(async (m) => {
    const sys = m.item.system;
    const cost = Number.isFinite(sys.resource) ? sys.resource : "";
    const actionType = sys.type;
    let typeTag = "";
    if (actionType && actionType !== "none") {
      const shortKey = actionType === "triggered" ? "DS_TRIGGERS.Reminder.Triggered"
        : actionType === "freeTriggered" ? "DS_TRIGGERS.Reminder.Free"
          : ds.CONFIG.abilities.types[actionType]?.label;
      if (shortKey) typeTag = `<span class="dst-malice-type-tag">${game.i18n.localize(shortKey)}</span>`;
    }
    const link = `<a class="dst-ability-link" data-item-uuid="${m.item.uuid}" data-tooltip="${game.i18n.localize("DS_TRIGGERS.Reminder.LinkTooltip")}"><strong>${m.item.name}</strong></a>`;

    
    
    const enrich = async (text) => {
      if (!text) return "";
      const html = await TE.enrichHTML(text, { relativeTo: m.item }).catch(() => text);
      return _neutralizeStatusLinks(html);
    };
    let labels = null;
    try { labels = sys.formattedLabels ?? null; } catch { labels = null; }

    
    const actionLabel = actionType && !["none", "triggered", "freeTriggered"].includes(actionType)
      ? game.i18n.localize(ds.CONFIG.abilities.types[actionType]?.label ?? "") : "";
    const kwPills = [...(sys.keywords ?? [])].map((k) => {
      const kwLabel = ds.CONFIG.abilities.keywords?.[k]?.label;
      const label = kwLabel ? game.i18n.localize(kwLabel) : k.charAt(0).toUpperCase() + k.slice(1);
      return `<span class="dst-kw-badge">${label}</span>`;
    }).join("");
    const kwRow = kwPills || actionLabel
      ? `<div class="dst-malice-embed-kw"><span class="dst-kw-badges">${kwPills}</span><span class="dst-malice-embed-action">${actionLabel}</span></div>`
      : "";

    const distIcons = { melee: "fa-sword", ranged: "fa-bow-arrow", meleeRanged: "fa-swords", self: "fa-user" };
    const dtParts = [];
    if (labels?.distance) dtParts.push(`<span><i class="fa-solid ${distIcons[sys.distance?.type] ?? "fa-ruler-combined"}"></i> ${labels.distance}</span>`);
    if (labels?.target) dtParts.push(`<span><i class="fa-solid fa-bullseye"></i> ${game.i18n.localize(labels.target)}</span>`);
    const dtRow = dtParts.length ? `<div class="dst-malice-embed-dt">${dtParts.join("")}</div>` : "";

    const before = [];
    const after = [];
    for (const eff of sys.effects?.sortedContents ?? []) {
      const text = await enrich(eff.description ?? "");
      if (!text) continue;
      (eff.before ? before : after).push(`<div class="dst-malice-embed-effect"><strong>${eff.label ?? ""}</strong>${text}</div>`);
    }

    let tiers = "";
    if (sys.power?.roll?.enabled) {
      const tierLines = await Promise.all([1, 2, 3].map(async (tier) => {
        const text = await enrich(await sys.powerRollText(tier));
        return text ? `<div class="dst-malice-embed-tier"><span class="dst-tier-badge dst-tier-badge--${tier}">${["&le;11", "12&ndash;16", "17+"][tier - 1]}</span><span>${text}</span></div>` : "";
      }));
      tiers = `<div class="dst-malice-embed-tiers">${tierLines.join("")}</div>`;
    }

    return `<div class="dst-malice-feature">
      <div class="dst-malice-feature-head">
        <a class="dst-malice-expand" data-tooltip="${L("ExpandTooltip")}"><i class="fa-solid fa-chevron-right dst-malice-chevron"></i></a>
        ${link}${typeTag}
        <span class="dst-malice-feature-cost"><img class="dst-malice-chip" src="${maliceChipURI()}" alt="">${cost} ${game.i18n.localize("DS_TRIGGERS.Reminder.Malice")}</span>
      </div>
      <div class="dst-malice-feature-embed dst-collapsed">${kwRow}${dtRow}${before.join("")}${tiers}${after.join("")}</div>
    </div>`;
  }))).join("");

  const recipients = new Set(game.users.filter((u) => u.isGM).map((u) => u.id));
  for (const m of matches) {
    for (const u of game.users) if (m.actor.testUserPermission(u, "OWNER")) recipients.add(u.id);
  }

  ChatMessage.create({
    content: `<div class="dst-malice-card">
      <header class="dst-malice-card-hdr">${L("Header")}</header>
      <div class="dst-malice-card-title"><span class="dst-emblem">${emblemHTML()}</span>${game.i18n.format("DS_TRIGGERS.MaliceCard.Title", { name: subjectActor.name })}</div>
      <p class="dst-malice-card-intro">${game.i18n.format("DS_TRIGGERS.MaliceCard.Intro", { name: subjectActor.name })}</p>
      ${rows}
    </div>`,
    whisper: [...recipients],
    speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
    flags: { [MODULE_ID]: { reminder: { event: "MALICE_MENU" } } },
  });
}

document.addEventListener("click", async (event) => {
  const expand = event.target.closest(".dst-malice-expand");
  if (expand) {
    const embed = expand.closest(".dst-malice-feature")?.querySelector(".dst-malice-feature-embed");
    if (!embed) return;
    embed.classList.toggle("dst-collapsed");
    expand.querySelector("i")?.classList.toggle("dst-malice-chevron--open", !embed.classList.contains("dst-collapsed"));
    return;
  }
  const link = event.target.closest(".dst-ability-link");
  if (!link) return;
  const item = await fromUuid(link.dataset.itemUuid).catch(() => null);
  if (!item) {
    ui.notifications.warn("DS_TRIGGERS.Reminder.MissingAbility", { localize: true });
    return;
  }
  if (event.shiftKey) {
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
