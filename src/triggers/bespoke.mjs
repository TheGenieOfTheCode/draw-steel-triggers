import { MODULE_ID, dbg, primaryGM } from "../util.mjs";
import { queueSocket } from "./queue.mjs";
import { registerBespokeUse, getBespokeUse } from "./bespoke-registry.mjs";

const DSCT_ID = "draw-steel-combat-tools";
const DSTD_ID = "draw-steel-target-damage";

export async function runBespokeUse(item, entry) {
  const dsid = item?.system?._dsid ?? item?.dsid;
  const fn = getBespokeUse(dsid);
  if (!fn) return;
  try {
    await fn(item, entry);
  } catch (err) {
    console.warn(`${MODULE_ID} | bespoke handler for ${dsid} failed`, err);
  }
}

const PILL_FLAG = "bespokePills";

export function registerDamagePillBridge() {
  const api = game.modules.get(DSCT_ID)?.api;
  if (!api?.damagePills?.registerProvider) return;
  api.damagePills.registerProvider((message) => {
    const entries = message.getFlag(MODULE_ID, PILL_FLAG);
    if (!Array.isArray(entries)) return [];
    return entries.map((e) => ({ targetUuid: e.targetUuid, pill: e.pill }));
  });
  dbg("damage pill bridge registered with Combat Tools");
}

async function addDamagePill(message, targetUuid, pill) {
  const flag = message.getFlag(MODULE_ID, PILL_FLAG);
  const existing = Array.isArray(flag) ? flag : [];
  if (existing.some((e) => e.targetUuid === targetUuid && e.pill?.label === pill.label)) return;
  await message.setFlag(MODULE_ID, PILL_FLAG, [...existing, { targetUuid, pill }]);
}

async function addTarget(message, tokenDoc) {
  const state = message.getFlag(DSTD_ID, "state") ?? {};
  const targets = [...(state.targets ?? [])];
  const uuid = tokenDoc.uuid;
  if (targets.some((t) => String(t.tokenUuid ?? "") === uuid)) return false;

  targets.push({
    tokenUuid: uuid,
    tokenId: tokenDoc.id ?? null,
    sceneId: tokenDoc.parent?.id ?? null,
    actorUuid: tokenDoc.actor?.uuid ?? null,
    actorId: tokenDoc.actor?.id ?? null,
    name: tokenDoc.name,
    tokenImg: tokenDoc.texture?.src ?? null,
    actorImg: tokenDoc.actor?.img ?? null,
  });
  await message.update({
    [`flags.${DSTD_ID}.state.targets`]: targets,
    [`flags.${DSTD_ID}.state.updatedAt`]: Date.now(),
  });
  return true;
}

registerBespokeUse("harmonize", async (item, entry) => {
  const message = entry.sourceMessageId ? game.messages.get(entry.sourceMessageId) : null;
  if (!message) {
    ui.notifications.warn(game.i18n.localize("DS_TRIGGERS.Bespoke.HarmonizeNoMessage"));
    return;
  }

  const ally = entry.subjectTokenUuid ? fromUuidSync(entry.subjectTokenUuid) : null;
  const chooser = pickUserFor(ally?.actor);
  const already = (message.getFlag(DSTD_ID, "state")?.targets ?? []).map((t) => String(t.tokenUuid ?? ""));

  const pickedUuid = chooser && chooser.id !== game.user.id
    ? await queueSocket()?.executeAsUser("pickHarmonizeTarget", chooser.id, item.name, already).catch(() => null)
    : await pickHarmonizeTarget(item.name, already);
  if (!pickedUuid) return;

  const tokenDoc = fromUuidSync(pickedUuid);
  if (!tokenDoc) return;

  await addTarget(message, tokenDoc);
  await addDamagePill(message, pickedUuid, {
    kind: "type",
    value: "sonic",
    label: item.name,
    src: entry.ownerName ?? null,
    source: "trigger",
  });
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Bespoke.HarmonizeAdded", { name: tokenDoc.name }));
});

function pickUserFor(actor) {
  if (!actor) return primaryGM();
  return game.users.find((u) => u.active && !u.isGM && actor.testUserPermission(u, "OWNER")) ?? primaryGM();
}

export async function pickHarmonizeTarget(abilityName, excludeUuids = []) {
  const api = game.modules.get(DSCT_ID)?.api;
  const eligible = canvas.tokens.placeables.filter((t) =>
    t.actor && !excludeUuids.includes(t.document.uuid));
  if (!eligible.length) return null;

  if (!api?.colorTokenPicker) {
    ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Bespoke.HarmonizeManual", { modName: abilityName }));
    return null;
  }
  const picked = await api.colorTokenPicker({
    tokens: eligible,
    colorMap: new Map(eligible.map((t) => [t.id, "#4aa3d9"])),
    hint: game.i18n.format("DS_TRIGGERS.Bespoke.HarmonizePick", { modName: abilityName }),
  }).catch(() => null);
  return picked?.document?.uuid ?? null;
}
