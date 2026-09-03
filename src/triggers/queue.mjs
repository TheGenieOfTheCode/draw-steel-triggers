import { MODULE_ID, getSetting, dbg } from "../util.mjs";

let socket = null;

let _queue = [];
let _mirror = [];
const _rollBypass = new Set();

const _pendingResumes = new Map();

export function getQueueMirror() {
  return _mirror;
}

export function addRollBypass(itemUuid) {
  _rollBypass.add(itemUuid);
}

export function consumeRollBypass(itemUuid) {
  if (!_rollBypass.has(itemUuid)) return false;
  _rollBypass.delete(itemUuid);
  return true;
}

export function queueSocket() {
  return socket;
}

function _broadcast() {
  socket.executeForEveryone("queueSync", foundry.utils.deepClone(_queue));
}

function _onQueueAdd(entries) {
  if (!game.users.activeGM?.isSelf) return;
  
  const fresh = entries.filter((e) =>
    !_queue.some((q) => q.itemUuid === e.itemUuid && q.state === "pending"));
  if (!fresh.length) return;
  _queue.push(...fresh);
  dbg("queue add", fresh);
  _broadcast();
}

async function _onQueueResolve(id, outcome, userName) {
  if (!game.users.activeGM?.isSelf) return;
  const entry = _queue.find((e) => e.id === id);
  if (!entry || entry.state !== "pending") return;
  entry.state = outcome;
  dbg(`queue resolve ${id} -> ${outcome}`);

  if (outcome === "declined") {
    const owner = await fromUuid(entry.ownerActorUuid).catch(() => null);
    const recipients = game.users.filter((u) => u.isGM || (owner && owner.testUserPermission(u, "OWNER"))).map((u) => u.id);
    ChatMessage.create({
      content: `<div class="dst-reminder"><em>${game.i18n.format("DS_TRIGGERS.Queue.DeclineRecord", { owner: entry.ownerName, ability: entry.itemName })}</em></div>`,
      whisper: recipients,
      speaker: { alias: game.i18n.localize("DS_TRIGGERS.Reminder.Speaker") },
    });
  }

  if (entry.resumeId) {
    const stillLocked = _queue.some((e) => e.resumeId === entry.resumeId && e.state === "pending");
    if (!stillLocked) {
      const group = _queue.filter((e) => e.resumeId === entry.resumeId);
      const resume = group[0]?.resume;
      const usedItems = new Set(group.filter((e) => e.state === "used").map((e) => e.itemUuid));
      _queue = _queue.filter((e) => e.resumeId !== entry.resumeId);
      if (!usedItems.size) _dispatchResume(resume);
      else {
        const grace = Math.max(1, Number(getSetting("rollLockGrace")) || 15) * 1000;
        const resumeId = entry.resumeId;
        _pendingResumes.set(resumeId, {
          resume,
          awaiting: usedItems,
          timer: setTimeout(() => _fireResume(resumeId), grace),
        });
      }
    }
  } else {
    _queue = _queue.filter((e) => e.id !== id);
  }
  _broadcast();
}

function _dispatchResume(resume) {
  if (!resume?.userId || !resume?.itemUuid) return;
  const user = game.users.get(resume.userId);
  if (user?.active) socket.executeForUsers("resumeRoll", [resume.userId], resume.itemUuid);
  else socket.executeAsGM("resumeRoll", resume.itemUuid);
}

function _fireResume(resumeId) {
  const pending = _pendingResumes.get(resumeId);
  if (!pending) return;
  clearTimeout(pending.timer);
  _pendingResumes.delete(resumeId);
  _dispatchResume(pending.resume);
}

Hooks.on("createChatMessage", (message) => {
  if (!game.users.activeGM?.isSelf || !_pendingResumes.size) return;
  const abilityUse = message.system?.parts?.contents?.find((p) => p.type === "abilityUse");
  if (!abilityUse?.abilityUuid) return;
  for (const [resumeId, pending] of _pendingResumes) {
    if (!pending.awaiting.has(abilityUse.abilityUuid)) continue;
    pending.awaiting.delete(abilityUse.abilityUuid);
    if (!pending.awaiting.size) _fireResume(resumeId);
  }
});

async function _onResumeRoll(itemUuid) {
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!item) return;
  addRollBypass(itemUuid);
  ui.notifications.info(game.i18n.format("DS_TRIGGERS.Queue.RollReleased", { name: item.name }));
  item.system.use();
}

function _onQueueSync(entries) {
  const hadPendingForMe = _pendingForMe(_mirror).length;
  _mirror = entries;
  Hooks.callAll("dst.queueChanged", _mirror);
  if (_pendingForMe(_mirror).length > hadPendingForMe) Hooks.callAll("dst.queueOpenRequested");
}

function _pendingForMe(entries) {
  return entries.filter((e) => e.state === "pending" && canActOn(e));
}

export function canActOn(entry) {
  if (game.user.isGM) return true;
  const owner = fromUuidSync(entry.ownerActorUuid);
  return !!owner && owner.testUserPermission(game.user, "OWNER");
}

export function enqueueLockEntries(matches, { event, causeLabel, resume }) {
  const resumeId = foundry.utils.randomID();
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event,
    causeLabel,
    lock: true,
    state: "pending",
    resumeId,
    resume,
  }));
  socket.executeAsGM("queueAdd", entries);
  return entries;
}

export function enqueuePromptEntries(matches, { event, causeLabel }) {
  const entries = matches.map((m) => ({
    id: foundry.utils.randomID(),
    itemUuid: m.item.uuid,
    itemName: m.item.name,
    ownerActorUuid: m.actor.uuid,
    ownerName: m.actor.name,
    event,
    causeLabel,
    lock: false,
    state: "pending",
    resumeId: null,
    resume: null,
  }));
  socket.executeAsGM("queueAdd", entries);
}

export function resolveQueueEntry(id, outcome) {
  socket.executeAsGM("queueResolve", id, outcome, game.user.name);
}

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("queueAdd", _onQueueAdd);
  socket.register("queueResolve", _onQueueResolve);
  socket.register("queueSync", _onQueueSync);
  socket.register("resumeRoll", _onResumeRoll);
});
