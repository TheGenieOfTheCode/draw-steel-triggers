import { getSetting, dbg } from "../../util.mjs";
import { collectTriggerMatches } from "../dispatch.mjs";
import { enqueueResolutionHold } from "../queue.mjs";

const DSTD_ID = "draw-steel-target-damage";
const _handled = new Set();
const _handledAt = new Map();

function _pruneHandled() {
  const now = Date.now();
  for (const [id, t] of _handledAt) {
    if (now - t > 60000) {
      _handledAt.delete(id);
      _handled.delete(id);
    }
  }
}

async function _tryDispatch(message) {
  if (!game.users.activeGM?.isSelf) return;
  if (!getSetting("resolutionHolds")) return;
  if (!game.combat?.started) return;
  if (_handled.has(message.id)) return;
  if (Date.now() - (message.timestamp ?? 0) > 30000) return;

  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  const state = message.getFlag(DSTD_ID, "state");
  const targets = state?.targets ?? [];
  if (!targets.length) return;
  if (!message.rolls?.length) return;

  const ability = await fromUuid(abilityUse.abilityUuid).catch(() => null);
  if (!ability || ability.type !== "ability") return;
  if (!(ability.system.keywords?.has?.("strike") ?? false)) return;
  const rollerActor = ability.actor;

  _handled.add(message.id);
  _handledAt.set(message.id, Date.now());
  _pruneHandled();

  const matches = [];
  const seen = new Set();
  for (const t of targets) {
    const tokenDoc = t.tokenUuid ? await fromUuid(t.tokenUuid).catch(() => null) : null;
    const subjectActor = tokenDoc?.actor
      ?? (t.actorUuid ? await fromUuid(t.actorUuid).catch(() => null) : null);
    if (!subjectActor) continue;
    const list = collectTriggerMatches("TARGETED_BY_STRIKE", subjectActor, tokenDoc)
      .filter((m) => !m.malice && m.clause?.postRoll === true && m.actor !== rollerActor
        && (m.parse?.confidence === "high" || m.parse?.source === "manual"));
    for (const m of list) {
      if (seen.has(m.item.uuid)) continue;
      seen.add(m.item.uuid);
      m._subjectTargetKey = String(t.tokenUuid ?? t.actorUuid ?? "").replace(/\./g, "__");
      m._subjectName = tokenDoc?.name ?? subjectActor.name;
      m._causeLabel = game.i18n.format("DS_TRIGGERS.Queue.ResolutionCause", {
        roller: rollerActor?.name ?? "", ability: ability.name, owner: m._subjectName,
      });
      matches.push(m);
    }
  }
  if (!matches.length) return;

  dbg(`resolution hold: ${ability.name} held by ${matches.length} post-roll triggers`);
  enqueueResolutionHold(matches, {
    causeLabel: game.i18n.format("DS_TRIGGERS.Queue.ResolutionCause", {
      roller: rollerActor?.name ?? "", ability: ability.name, owner: "",
    }),
    resolution: {
      messageId: message.id,
      abilityUuid: ability.uuid,
      abilityName: ability.name,
      rollerName: rollerActor?.name ?? "",
      rollerActorUuid: rollerActor?.uuid ?? null,
      authorUserId: message.author?.id ?? null,
    },
  });
}

Hooks.on("createChatMessage", (message) => { _tryDispatch(message); });

Hooks.on("updateChatMessage", (message, changes) => {
  if (!foundry.utils.hasProperty(changes, `flags.${DSTD_ID}`)) return;
  _tryDispatch(message);
});
