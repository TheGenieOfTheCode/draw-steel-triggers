import { MODULE_ID, getSetting, isPrimaryGM } from "../util.mjs";
import { isMaliceAbility } from "./registry.mjs";
import { abilityRowsHTML, cardContent, cardPill, postSystemCard, withFaces } from "../ui/system-card.mjs";

export const BASIC_MALICE = {
  "brutal-effectiveness": "Compendium.draw-steel.monster-features.Item.GpKibCtEYzdsnGSX",
  "malicious-strike": "Compendium.draw-steel.monster-features.Item.HiAuOVI1sJF0AZGx",
};
const STRIKE = "malicious-strike";
const STRIKE_FLAG = "maliciousStrikeRound";
const OFF_FLAG = "maliceOff";
const POSTED_FLAG = "maliceSelectPosted";

const L = (k, data) => (data ? game.i18n.format(`DS_TRIGGERS.MaliceCard.${k}`, data) : game.i18n.localize(`DS_TRIGGERS.MaliceCard.${k}`));
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

export const maliceKey = (item) => String(item?.system?._dsid || item?.name || "").toLowerCase();
export const maliceValue = () => Number(game.settings.get("draw-steel", "malice")?.value ?? 0) || 0;
const chipURI = () => game.modules.get("draw-steel-ctlib")?.api?.resourceTokenURI?.("malice") ?? "";

export const malicePill = (item) => {
  const cost = Number.isFinite(item.system.resource) ? `${item.system.resource}${maliceKey(item) === STRIKE ? "+" : ""} ` : "";
  return cardPill(`${cost}${game.i18n.localize("DS_TRIGGERS.Reminder.Malice")}`, { cls: "dst-card-pill--malice", img: chipURI() });
};

const isMonster = (actor, token = null) => {
  if (actor?.type !== "npc" || actor.hasPlayerOwner) return false;
  const disposition = token?.disposition ?? actor.token?.disposition ?? actor.prototypeToken?.disposition;
  return disposition === CONST.TOKEN_DISPOSITIONS.HOSTILE;
};

export function maliceTypeName(actor) {
  if (actor.system?.monster?.organization === "solo") return null;
  const config = ds.CONFIG.monsters?.keywords ?? {};
  for (const kw of actor.system?.monster?.keywords ?? []) {
    const cfg = config[kw];
    if (/(^|\.)Ancestry$/.test(String(cfg?.group ?? ""))) return game.i18n.localize(cfg.label ?? kw);
  }
  return null;
}

const _adding = new Map();

async function addBasics(actor) {
  const have = new Set(actor.items.map(maliceKey));
  const missing = Object.entries(BASIC_MALICE).filter(([key]) => !have.has(key));
  if (!missing.length) return;
  const docs = (await Promise.all(missing.map(([, uuid]) => fromUuid(uuid).catch(() => null)))).filter(Boolean);
  const data = docs.map((doc) => {
    const out = doc.toObject();
    delete out._id;
    foundry.utils.setProperty(out, `flags.${MODULE_ID}.basicMalice`, true);
    foundry.utils.setProperty(out, "_stats.compendiumSource", doc.uuid);
    return out;
  });
  if (data.length) await actor.createEmbeddedDocuments("Item", data);
}

export function ensureBasicMalice(actor, token = null) {
  if (!actor || getSetting("basicMalice") === false || !isPrimaryGM() || !isMonster(actor, token)) return null;
  const key = actor.uuid;
  if (_adding.has(key)) return _adding.get(key);
  const run = addBasics(actor).catch((err) => console.warn(`${MODULE_ID} | basic malice for ${actor.name} failed`, err))
    .finally(() => _adding.delete(key));
  _adding.set(key, run);
  return run;
}

Hooks.on("createCombatant", (combatant) => ensureBasicMalice(combatant.actor, combatant.token));

Hooks.once("ready", () => {
  for (const combat of game.combats) {
    if (combat.started) for (const c of combat.combatants) ensureBasicMalice(c.actor, c.token);
  }
});

function monsterFeatures(combat) {
  const features = new Map();
  for (const c of combat.combatants) {
    const actor = c.actor;
    if (!isMonster(actor, c.token)) continue;
    for (const item of actor.items) {
      const key = maliceKey(item);
      if (!isMaliceAbility(item) || key in BASIC_MALICE || /malice features$/i.test(item.name) || features.has(key)) continue;
      features.set(key, { key, item, source: maliceTypeName(actor) ?? actor.name });
    }
  }
  return [...features.values()].sort((a, b) => (a.item.system.resource ?? 99) - (b.item.system.resource ?? 99) || a.item.name.localeCompare(b.item.name));
}

const BANDS = [
  ["Band23", (c) => c >= 2 && c <= 3],
  ["Band5", (c) => c === 5],
  ["Band710", (c) => c >= 7 && c <= 10],
  ["BandOther", () => true],
];

async function postSelectionCard(combat) {
  const features = monsterFeatures(combat);
  if (!features.length) return;
  const groups = BANDS.map(([band]) => ({ band, rows: [] }));
  for (const f of features) {
    const cost = Number(f.item.system.resource);
    groups[BANDS.findIndex(([, fits]) => fits(cost))].rows.push(f);
  }
  const body = groups.filter((g) => g.rows.length).map((g) => `<section class="dst-malice-band">
    <h4>${esc(L(g.band))}</h4>
    <ul>${g.rows.map((f) => `<li><label class="dst-malice-pick">
      <input type="checkbox" data-malice-key="${esc(f.key)}" checked>
      <span class="dst-malice-pick-name">${esc(f.item.name)}</span>
      <span class="dst-malice-pick-source">${esc(f.source)}</span>
      ${malicePill(f.item)}
    </label></li>`).join("")}</ul>
  </section>`).join("");
  await postSystemCard({
    title: L("SelectTitle"),
    flavor: null,
    kind: "Malice",
    whisper: game.users.filter((u) => u.isGM).map((u) => u.id),
    content: cardContent({
      head: `<div class="dst-malice-head"><span class="dst-malice-title">${esc(L("SelectTitle"))}</span></div>`,
      intro: esc(L("SelectHint")),
      body,
    }),
    flags: { [MODULE_ID]: { maliceSelect: { combatId: combat.id } } },
  });
}

Hooks.on("updateCombat", async (combat, changes) => {
  if (!isPrimaryGM() || changes.round !== 1 || combat.getFlag(MODULE_ID, POSTED_FLAG)) return;
  await combat.setFlag(MODULE_ID, POSTED_FLAG, true);
  await Promise.all(combat.combatants.map((c) => ensureBasicMalice(c.actor, c.token)));
  postSelectionCard(combat);
});

Hooks.on("createChatMessage", (message) => {
  if (!isPrimaryGM()) return;
  const use = message.system?.parts?.contents?.find?.((p) => p.type === "abilityUse");
  const item = use?.ability ?? (use?.abilityUuid ? fromUuidSync(use.abilityUuid) : null);
  const combat = game.combat;
  if (maliceKey(item) !== STRIKE || !combat?.started) return;
  combat.setFlag(MODULE_ID, STRIKE_FLAG, combat.round);
});

export const maliceFeatureOff = (combat, item) => !(maliceKey(item) in BASIC_MALICE) && !!combat?.getFlag(MODULE_ID, OFF_FLAG)?.[maliceKey(item)];

export async function sendMaliceCard(matches, subjectActor, { causeLabel = "", people = [], recipients = [] } = {}) {
  const combat = game.combat;
  const shown = matches.filter((m) => !maliceFeatureOff(combat, m.item))
    .sort((a, b) => (a.item.system.resource ?? 999) - (b.item.system.resource ?? 999));
  if (!shown.length) return;
  const body = await abilityRowsHTML(shown.map((m) => ({
    item: m.item,
    pills: [malicePill(m.item)],
    action: !!m.item.system.type && m.item.system.type !== "none",
    attrs: { "data-malice-cost": Number(m.item.system.resource) || 0, "data-malice-key": maliceKey(m.item) },
  })));
  const head = `<div class="dst-malice-head">
    <span class="dst-malice-title">${esc(L("Header"))}</span>
    <button type="button" class="dst-malice-avail" data-tooltip="${esc(L("AvailableTip"))}">
      <img class="dst-card-pill-chip" src="${chipURI()}" alt=""><span class="dst-malice-avail-text"></span>
    </button>
  </div>`;
  const intro = withFaces(L("Intro", { name: subjectActor.name }), people.filter(Boolean));
  await postSystemCard({
    title: L("Header"),
    flavor: null,
    kind: "Malice",
    content: cardContent({ head, intro, body: `${body}<p class="dst-malice-empty">${esc(L("NoneAffordable"))}</p>` }),
    whisper: recipients,
    flags: { [MODULE_ID]: { reminder: { event: "MALICE_MENU" }, maliceMenu: { combatId: combat?.id ?? null, round: combat?.round ?? null } } },
  });
}

const _showAll = new Set();

function refreshMenu(message, html) {
  const card = html.querySelector(".dst-system-card");
  if (!card) return;
  const malice = maliceValue();
  const combat = game.combats.get(message.getFlag(MODULE_ID, "maliceMenu")?.combatId) ?? game.combat;
  const strikeRound = combat?.getFlag(MODULE_ID, STRIKE_FLAG);
  const strikeBlocked = combat?.started && Number.isFinite(strikeRound) && strikeRound === combat.round - 1;
  card.querySelector(".dst-malice-avail-text").textContent = L("Available", { n: malice });
  let visible = 0;
  for (const row of card.querySelectorAll("li.dst-card-row[data-malice-cost]")) {
    const tooDear = Number(row.dataset.maliceCost) > malice;
    const used = row.dataset.maliceKey === STRIKE && strikeBlocked;
    row.classList.toggle("dst-malice-hidden", tooDear || used);
    const tail = row.querySelector("h5 .dst-card-tail");
    row.querySelector(".dst-malice-note")?.remove();
    if (used && tail) tail.insertAdjacentHTML("afterbegin", `<span class="dst-malice-note">${esc(L("UsedLastRound"))}</span>`);
    if (!tooDear && !used) visible++;
  }
  card.classList.toggle("dst-malice-show-all", _showAll.has(message.id));
  card.classList.toggle("dst-malice-none", !visible);
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (message.getFlag(MODULE_ID, "maliceMenu")) {
    refreshMenu(message, html);
    html.querySelector(".dst-malice-avail")?.addEventListener("click", (event) => {
      event.preventDefault();
      if (_showAll.has(message.id)) _showAll.delete(message.id);
      else _showAll.add(message.id);
      refreshMenu(message, html);
    });
  }
  const select = message.getFlag(MODULE_ID, "maliceSelect");
  if (select) {
    const combat = game.combats.get(select.combatId);
    const off = combat?.getFlag(MODULE_ID, OFF_FLAG) ?? {};
    for (const box of html.querySelectorAll("input[data-malice-key]")) {
      box.checked = !off[box.dataset.maliceKey];
      box.disabled = !game.user.isGM || !combat;
      box.addEventListener("change", () => {
        const path = `${OFF_FLAG}.${box.dataset.maliceKey}`;
        if (box.checked) combat?.unsetFlag(MODULE_ID, path);
        else combat?.setFlag(MODULE_ID, path, true);
      });
    }
  }
});

const rerenderMenus = () => {
  for (const message of game.messages.contents.slice(-40)) {
    if (message.getFlag(MODULE_ID, "maliceMenu") || message.getFlag(MODULE_ID, "maliceSelect")) ui.chat?.updateMessage?.(message);
  }
};

Hooks.on("updateSetting", (setting) => {
  if (setting.key === "draw-steel.malice") rerenderMenus();
});

Hooks.on("updateCombat", (combat, changes) => {
  const flags = changes.flags?.[MODULE_ID];
  if ("round" in changes || (flags && (STRIKE_FLAG in flags || OFF_FLAG in flags || `-=${OFF_FLAG}` in flags))) rerenderMenus();
});
