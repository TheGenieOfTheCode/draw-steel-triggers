import { MODULE_ID, getSetting, isPrimaryGM } from "../util.mjs";
import { abilityRowsHTML, cardContent, cardPill, faceHTML, postSystemCard } from "../ui/system-card.mjs";
import { computeAutomationLevel, parseAutomationLevel } from "../ui/badge.mjs";
import { featureTriggersActive, isLineSource, itemAllLines } from "./feature-triggers.mjs";
import { derivedFor } from "./derived.mjs";
import { anyLineEmbed } from "../ui/feature-card.mjs";

const POSTED_FLAG = "trackByHandPosted";
const L = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.TrackByHand.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.TrackByHand.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

const EFFECT_BY_HAND = new Set([
  "calling-the-shots-a-rival-uses-an-ability-against-an-enemy",
  "frontal-assault-you-or-any-ally-deals-damage-a-target-marked-by-you",
  "houndgun-and-houndblade-a-target-is-made-bleeding-this-way",
]);

const SUMMONS = /\b(?:summon\w*|companions?|rampage|illusory|doubles?|call forth|minions?|deathcount)\b/i;
const REASONS = [
  ["Area", /\b(?:areas?|zones?|auras?|portals?|burst)\b/i],
  ["Choice", /\b(?:chosen|choice|bound to|linked|hybrid form|direction|rivals?)\b/i],
  ["Summons", SUMMONS],
];

function reasonOf(line) {
  const why = String(line.later ?? "");
  const hit = REASONS.find(([, rx]) => rx.test(why));
  if (hit) return hit[0];
  if (/^\d+\.\d+$/.test(why) && SUMMONS.test(`${line.trigger ?? ""} ${line.sentence ?? ""}`)) return "Summons";
  return null;
}

const levelPill = (level) => cardPill(L(`Level.${level}`), { cls: `dst-hand-pill dst-hand-pill--${level}` });
const reasonPill = (reason) => cardPill(L(`Reason.${reason}`), { cls: "dst-hand-pill dst-hand-pill--reason" });

const lineLevel = (line) => (line.parse?.confidence !== "high" ? "unknown" : parseAutomationLevel(line.parse)?.level ?? "unknown");

export function handRows(actor) {
  const rows = new Map();
  const add = (key, row) => { if (!rows.has(key)) rows.set(key, row); };
  for (const item of actor.items) {
    if (item.type !== "ability") continue;
    const level = computeAutomationLevel(item)?.level;
    if (["none", "unknown", "partial"].includes(level)) add(`a:${item.id}`, { item, pills: [levelPill(level)] });
    else if (level === "full" && EFFECT_BY_HAND.has(item.getFlag(MODULE_ID, "derived")?.lineKey)) add(`a:${item.id}`, { item, pills: [levelPill("effect")] });
  }
  if (!featureTriggersActive()) return [...rows.values()];
  for (const item of actor.items) {
    if (!isLineSource(item)) continue;
    for (const line of itemAllLines(item)) {
      if (line.kind === "later") {
        const passive = /passive effect/i.test(String(line.later ?? ""));
        const reason = passive ? null : reasonOf(line);
        const pills = [reason ? reasonPill(reason) : levelPill(passive ? "passive" : "later")];
        add(`l:${item.id}:${pills.join("")}`, { item, name: item.name, pills, line });
      } else if (line.kind === "trigger" && !derivedFor(actor, item.id, line.key)) {
        const level = lineLevel(line);
        const pick = ["none", "unknown", "partial"].includes(level) ? level : level === "full" && EFFECT_BY_HAND.has(line.key) ? "effect" : null;
        if (pick) add(`t:${item.id}:${pick}`, { item, name: item.name, pills: [levelPill(pick)], line });
      }
    }
  }
  return [...rows.values()];
}

function audienceOf(actor) {
  const assigned = game.users.filter((u) => !u.isGM && u.character?.id === actor.id);
  if (assigned.length) return assigned;
  return game.users.filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER"));
}

export async function postTrackByHand(combat) {
  if (!combat) return 0;
  const groups = new Map();
  const seen = new Set();
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    const rows = handRows(actor);
    if (!rows.length) continue;
    const players = audienceOf(actor);
    const keys = players.length ? players.map((u) => u.id) : ["gm"];
    for (const key of keys) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ actor, token: c.token, rows });
    }
  }
  const gms = game.users.filter((u) => u.isGM).map((u) => u.id);
  for (const [key, entries] of groups) {
    const sections = await Promise.all(entries.map(async ({ actor, token, rows }) => `<section class="dst-malice-band dst-hand-actor">
      <h4>${faceHTML(token ?? actor, { named: true }) || esc(actor.name)}</h4>
      ${await abilityRowsHTML(await Promise.all(rows.map(async (r) => ({ ...r, owner: null, action: false,
        embed: r.line ? await anyLineEmbed(r.item, r.line) : undefined }))))}
    </section>`));
    await postSystemCard({
      title: L("Title"),
      flavor: null,
      kind: "Track",
      whisper: key === "gm" ? gms : [key],
      content: cardContent({
        head: `<div class="dst-malice-head"><span class="dst-malice-title">${esc(L("Title"))}</span></div>`,
        intro: esc(L("Intro")),
        body: sections.join(""),
      }),
      flags: { [MODULE_ID]: { trackByHand: { combatId: combat.id } } },
    });
  }
  return groups.size;
}

Hooks.on("updateCombat", async (combat, changes) => {
  if (!isPrimaryGM() || changes.round !== 1 || getSetting("trackByHand") === false || combat.getFlag(MODULE_ID, POSTED_FLAG)) return;
  await combat.setFlag(MODULE_ID, POSTED_FLAG, true);
  postTrackByHand(combat).catch((err) => console.warn(`${MODULE_ID} | track by hand message failed`, err));
});
