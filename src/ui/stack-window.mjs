import { MODULE_ID, getSetting } from "../util.mjs";
import { autoUseLevel, lineMandatory } from "../triggers/auto-use.mjs";
import { getQueueMirror, canActOn, resolveQueueEntry, chooseQueueSubject, pickTriggerSubject, addRollBypass, releaseHeld, applyHeldDamageNow, chooseRedirectEntry, releaseResolutionNow, watchUseCancellation, markVillainUsed, retargetEpoch, asPrimaryGM } from "../triggers/queue.mjs";
import { buildAbilityPreview, featureLinePreview } from "./ability-preview.mjs";
import { buildRoster } from "./roster.mjs";
import { snoozeFor, setSnooze, clearSnooze, promptSnooze, toggleSnooze, actorSnoozeFor, exactSnoozeFor } from "./snooze.mjs";
import { runBespokeUse } from "../triggers/bespoke.mjs";
import { maliceValue } from "../triggers/malice.mjs";
import { squadBase } from "../triggers/squad-groups.mjs";
import { impactChips } from "./stack-impacts.mjs";
import { featureSnoozeId } from "../triggers/feature-triggers.mjs";
import { gainSnoozeId } from "../triggers/resource-gains.mjs";
import { richify } from "./tips.mjs";

const UNSNOOZABLE_KINDS = new Set(["held", "damageHeld", "resolutionHeld", "reaper", "redirect"]);

function snoozeIdOf(entry) {
  if (UNSNOOZABLE_KINDS.has(entry.kind) || entry.villain) return null;
  if (entry.gain?.line) return gainSnoozeId({ key: entry.gain.line });
  if (entry.lineKey) return featureSnoozeId(entry.lineKey);
  return entry.itemUuid ? fromUuidSync(entry.itemUuid)?.system?._dsid ?? null : null;
}

const snoozeActorsOf = (entry) => [...new Set([entry.ownerActorUuid, ...(entry.squad ?? []).map((m) => m.ownerActorUuid)].filter(Boolean))];

const STACK_WIDTH = 500;
const EDGE_GAP = 8;

function stackRightEdge() {
  const side = ui.sidebar?.element?.getBoundingClientRect();
  if (!side?.width) return window.innerWidth;
  const chat = document.getElementById("chat-notifications")?.getBoundingClientRect();
  const tabs = document.getElementById("sidebar-tabs")?.getBoundingClientRect();
  if (!chat?.width || !tabs?.width) return side.left;
  const chatLeftCollapsed = window.innerWidth - tabs.width - (side.left - chat.right) - chat.width;
  return Math.min(side.left, chatLeftCollapsed);
}
const CTLIB_ID = "draw-steel-ctlib";

const ctlib = () => (game.modules.get(CTLIB_ID)?.active ? game.modules.get(CTLIB_ID).api : null);

export const reducedEffects = () => ctlib()?.reducedEffects?.() ?? !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const UNSIDED_KINDS = new Set(["held", "damageHeld", "resolutionHeld", "reaper", "redirect"]);
const colourOf = (user) => user?.color?.css ?? (user?.color ? String(user.color) : null);

export function sideOf(entry) {
  if (UNSIDED_KINDS.has(entry.kind)) return null;
  if (!entry.playerSide) return { side: "director", colour: colourOf(game.users.activeGM ?? game.users.find((u) => u.isGM)) };
  const actor = entry.ownerActorUuid ? fromUuidSync(entry.ownerActorUuid) : null;
  const players = actor ? game.users.filter((u) => !u.isGM && actor.testUserPermission(u, "OWNER")) : [];
  const player = players.find((u) => u.character === actor) ?? players.find((u) => u.active) ?? players[0];
  return { side: "hero", colour: colourOf(player) };
}

const HELD_KINDS = new Set(["held", "damageHeld", "resolutionHeld"]);
const MOMENT_GAP_MS = 2000;

function momentsOf(entries) {
  const sorted = [...entries].filter((e) => Number.isFinite(e.createdAt)).sort((a, b) => a.createdAt - b.createdAt);
  const out = new Map();
  let moment = -1;
  let last = -Infinity;
  for (const e of sorted) {
    if (e.createdAt - last > MOMENT_GAP_MS) moment++;
    last = e.createdAt;
    out.set(e.id, moment);
  }
  return out;
}

function heldKeys(e) {
  if (e.kind === "held") return e.resumeId ? [`r:${e.resumeId}`] : [];
  if (e.kind === "damageHeld") return (e.damageIds ?? [e.damageId]).filter(Boolean).map((id) => `d:${id}`);
  if (e.kind === "resolutionHeld") return e.resolutionId ? [`s:${e.resolutionId}`] : [];
  return [];
}

const holdingKeys = (e) => [e.resumeId && `r:${e.resumeId}`, e.resolutionId && `s:${e.resolutionId}`,
  ...(e.choices ?? []).map((c) => c.resumeId && `r:${c.resumeId}`),
  ...[e.damageId, ...(e.choices ?? []).map((c) => c.damageId)].filter(Boolean).map((id) => `d:${id}`)].filter(Boolean);

function arrangeHolds(entries, isLocked) {
  const blockOf = new Map();
  const blocks = [];
  const reapers = [];
  const heads = entries.filter((e) => HELD_KINDS.has(e.kind)).map((held) => ({ helds: [held], holders: [], at: Infinity }));
  for (const block of heads) for (const key of heldKeys(block.helds[0])) blockOf.set(key, block);
  entries.forEach((e, i) => {
    if (e.kind === "reaper") return reapers.push(e);
    if (HELD_KINDS.has(e.kind)) return;
    const hit = [...new Set(holdingKeys(e).map((k) => blockOf.get(k)).filter(Boolean))];
    if (!hit.length) return blocks.push({ holders: [e], helds: [], at: i });
    const [block, ...others] = hit;
    for (const other of others) {
      block.helds.push(...other.helds);
      block.holders.push(...other.holders);
      block.at = Math.min(block.at, other.at);
      other.merged = true;
      for (const held of other.helds) for (const key of heldKeys(held)) blockOf.set(key, block);
    }
    block.holders.push(e);
    block.at = Math.min(block.at, i);
  });
  for (const block of heads) {
    if (block.merged) continue;
    if (block.at === Infinity) block.at = entries.indexOf(block.helds[0]);
    blocks.push(block);
  }
  const unlockedFirst = (list) => [...list.filter((e) => !isLocked(e)), ...list.filter(isLocked)];
  const lockedBlock = (b) => b.holders.length > 0 && b.holders.every(isLocked);
  const directorBlock = (b) => !b.holders.some((e) => e.playerSide);
  const ordered = blocks.sort((a, b) => (lockedBlock(a) - lockedBlock(b)) || (directorBlock(a) - directorBlock(b)) || (a.at - b.at));
  const roles = new Map();
  const maybe = new Set();
  const list = [];
  for (const block of ordered) {
    const holders = unlockedFirst(block.holders);
    list.push(...holders);
    if (holders.length && block.helds.length) {
      const choosing = holders.some((h) => h.choices?.length > 1);
      holders.forEach((h) => roles.set(h.id, "holder"));
      for (const held of block.helds) {
        roles.set(held.id, "held");
        if (choosing) maybe.add(held.id);
      }
    }
    list.push(...block.helds);
  }
  return { list: [...list, ...reapers], roles, maybe };
}

export const tokenOfActor = (uuid) => {
  const actor = uuid ? fromUuidSync(uuid) : null;
  if (!actor) return null;
  if (actor.token) return actor.token;
  const tokens = actor.getActiveTokens?.(false, true) ?? [];
  return tokens.find((t) => t.parent === canvas.scene) ?? tokens[0] ?? null;
};

const faceChain = (docs, faded = () => false) => {
  const lib = ctlib();
  if (!lib?.faceChainHTML) return "";
  const faces = docs.filter(Boolean).map((d) => lib.faceFromToken(d, { faded: faded(d) })).filter(Boolean);
  return faces.length ? lib.faceChainHTML(faces) : "";
};

function reaperGroups(e) {
  const lib = ctlib();
  if (!lib?.groupFaces) return null;
  const faces = [
    ...(e.certain ?? []).map((t) => lib.faceFromToken(fromUuidSync(t.uuid))),
    ...(e.maybe ?? []).map((t) => lib.faceFromToken(fromUuidSync(t.uuid), { faded: true })),
  ].filter(Boolean);
  return lib.groupFaces(faces).map((g) => ({ label: g.label, faded: g.faded, facesHTML: lib.faceChainHTML(g.faces) }));
}

function choiceCauseHTML(e) {
  const docs = [];
  const seen = new Set();
  for (const c of e.choices ?? []) {
    const doc = c.subjectTokenUuid ? fromUuidSync(c.subjectTokenUuid) : null;
    if (doc && !seen.has(doc.uuid)) { seen.add(doc.uuid); docs.push(doc); }
  }
  const key = `DS_TRIGGERS.Queue.ChoiceEvent.${e.event}`;
  const event = game.i18n.has(key) ? game.i18n.localize(key) : "";
  return game.i18n.format("DS_TRIGGERS.Queue.ChoiceCauseFaces", {
    faces: faceChain(docs),
    count: docs.length || e.choices.length,
    event,
  }).replace(/\s+\./, ".");
}

function cappedNameHTML(e) {
  const original = Number(e.heldDamage?.original);
  const amount = Number(e.heldDamage?.amount);
  if (!(original > amount)) return null;
  const name = (e.damageIds?.length ?? 1) > 1
    ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEach", { entry: e.itemName })
    : e.itemName;
  const at = name.indexOf(String(amount));
  if (at < 0) return null;
  const esc = foundry.utils.escapeHTML;
  return `${esc(name.slice(0, at))}<s class="dst-capped-from">${original}</s> ${amount}${esc(name.slice(at + String(amount).length))}`;
}

function mergeSquadHolds(entries, mirror) {
  const holders = (damageId) => mirror
    .filter((q) => q.state === "pending" && [q.damageId, ...(q.choices ?? []).map((c) => c.damageId)].includes(damageId))
    .map((q) => q.id).sort().join(",");
  const out = [];
  const byKey = new Map();
  for (const e of entries) {
    const squad = e.kind === "damageHeld" ? e.heldDamage?.squad?.groupUuid : null;
    if (!squad) { out.push(e); continue; }
    const key = [squad, e.heldDamage.amount, e.heldDamage.damageType ?? "", e.state, holders(e.damageId)].join("|");
    const into = byKey.get(key);
    if (into) {
      into.damageIds.push(e.damageId);
      into.subjectUuids.push(e.heldDamage.tokenUuid);
      continue;
    }
    const row = { ...e, damageIds: [e.damageId], subjectUuids: [e.heldDamage.tokenUuid] };
    byKey.set(key, row);
    out.push(row);
  }
  return out;
}
const ROSTER_OPEN_WIDTH = 758;
const DSCT_ID = "draw-steel-combat-tools";

function useMessageRendered(itemUuid, timeoutMs = 1500, settleMs = 800) {
  return new Promise((resolve) => {
    let timer = null;
    let rendered = null;
    const finish = () => {
      Hooks.off("renderChatMessageHTML", renderHook);
      Hooks.off("updateChatMessage", updateHook);
      clearTimeout(timer);
      requestAnimationFrame(() => resolve());
    };
    const recorded = (message) => !!message.getFlag?.("draw-steel-target-damage", "state");
    const renderHook = Hooks.on("renderChatMessageHTML", (message) => {
      if (rendered || !message.system?.parts?.contents?.some((p) => p.type === "abilityUse" && p.abilityUuid === itemUuid)) return;
      rendered = message.id;
      if (recorded(message)) return finish();
      clearTimeout(timer);
      timer = setTimeout(finish, settleMs);
    });
    const updateHook = Hooks.on("updateChatMessage", (message) => {
      if (message.id === rendered && recorded(message)) finish();
    });
    timer = setTimeout(finish, timeoutMs);
  });
}

export async function spendMalice(cost) {
  const held = maliceValue();
  if (!game.user.isGM || held < cost) return false;
  await game.settings.set("draw-steel", "malice", { ...game.settings.get("draw-steel", "malice"), value: held - cost });
  return true;
}

async function useWithTriggerContext(item, entry) {
  const subject = entry.subjectTokenUuid ? fromUuidSync(entry.subjectTokenUuid) : null;
  const token = subject?.object ?? (subject?.documentName === "Token" ? subject : null);
  const previous = [...game.user.targets];
  const borrowed = !!token?.isVisible;
  const epoch = retargetEpoch();

  if (Number.isFinite(entry.triggerDamage)) {
    game.modules.get(DSCT_ID)?.api?.setTriggerDamage?.(entry.triggerDamage);
  }
  game.modules.get(DSCT_ID)?.api?.setTriggerSubject?.(entry.eventSubjectUuid ?? entry.subjectTokenUuid ?? null);
  if (borrowed) {
    token.setTarget(true, { user: game.user, releaseOthers: true });
    game.modules.get(DSCT_ID)?.api?.allowOutOfRange?.(item.uuid);
  }
  
  const rendered = borrowed ? useMessageRendered(item.uuid) : null;

  try {
    await item.system.use();
    await runBespokeUse(item, entry);
  } finally {
    if (rendered) await rendered;
    if (borrowed && retargetEpoch() === epoch) {
      for (const t of game.user.targets) t.setTarget(false, { user: game.user, releaseOthers: false });
      for (const t of previous) t.setTarget(true, { user: game.user, releaseOthers: false });
    }
  }
}

const _stackUses = new Map();

const DECISION_CONTROLS = "input:not([type=hidden]), select, textarea, range-picker, [data-action=placeTemplate]";

function hasDecisions(app) {
  if (app.options?.ability?.system?.power?.roll?.enabled) return true;
  const footer = app.element?.querySelector("footer, .form-footer");
  return [...(app.element?.querySelectorAll(DECISION_CONTROLS) ?? [])]
    .some((el) => !footer?.contains(el) && !el.closest("[hidden]") && el.offsetParent !== null);
}

Hooks.on("renderAbilityConfigurationDialog", (app) => {
  const uuid = app.options?.ability?.uuid;
  const use = uuid ? _stackUses.get(uuid) : null;
  if (!use) return;
  _stackUses.delete(uuid);
  if (!use.auto && !getSetting("skipEmptyDialogs")) return;
  if (app.options?.ability?.system?.power?.roll?.enabled) return;
  const reveal = () => { if (app.rendered) app.element.style.visibility = ""; };
  app.element.style.visibility = "hidden";
  setTimeout(() => {
    if (!app.rendered) return;
    if (hasDecisions(app)) return reveal();
    app.element.querySelector("button[type=submit]")?.click();
    setTimeout(reveal, 1000);
  }, 150);
});

function autoUsable(entry) {
  const level = autoUseLevel();
  if (level === "none") return false;
  if (entry.state !== "pending" || entry.kind || entry.choices?.length || entry.villain || entry.gain) return false;
  const item = entry.itemUuid ? fromUuidSync(entry.itemUuid) : null;
  if (!item) return false;
  const line = entry.featureLine ?? null;
  if (line?.neverAutoUse) return false;
  const action = line ? line.action ?? null : item.system?.type;
  if (action && !["freeTriggered", "none"].includes(action)) return false;
  const cost = line ? (Number(line.resourceCost) || 0) + (Number(line.maliceCost) || 0) : Number(item.system?.resource) || 0;
  if (cost > 0 || Number(item.getFlag?.(MODULE_ID, "derived")?.epicCost) > 0 || item.getFlag?.(MODULE_ID, "malice")) return false;
  if (level === "mandatory" && !lineMandatory(line)) return false;
  const text = line?.sentence ?? item.system?.trigger ?? "";
  const perRound = line?.once === "round" || /\bonce (?:per|each|a) round\b/i.test(text);
  return !perRound || /\bfirst time (?:each|in (?:any|a|each)) (?:combat )?round\b/i.test(text);
}

export class StackWindow extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-stack-window",
    classes: ["draw-steel", "dst-stack-window"],
    window: { minimizable: true, resizable: true },
    position: { width: STACK_WIDTH, height: "auto" },
    actions: {
      useEntry: StackWindow.#onUse,
      chooseSubject: StackWindow.#onChooseSubject,
      chooseRandom: StackWindow.#onChooseRandom,
      declineEntry: StackWindow.#onDecline,
      dismissEntry: StackWindow.#onDismiss,
      markVillainUsed: StackWindow.#onMarkVillainUsed,
      releaseHeld: StackWindow.#onReleaseHeld,
      releaseResolutionNow: StackWindow.#onReleaseResolutionNow,
      applyHeldNow: StackWindow.#onApplyHeldNow,
      redirectPick: StackWindow.#onRedirectPick,
      redirectNone: StackWindow.#onRedirectNone,
      openOwner: StackWindow.#onOpenOwner,
      snoozeTrigger: StackWindow.#onSnoozeTrigger,
      snoozeEntry: StackWindow.#onSnoozeEntry,
      snoozeActor: StackWindow.#onSnoozeActor,
      snoozeAll: StackWindow.#onSnoozeAll,
      toggleRosterEmbed: StackWindow.#onToggleRosterEmbed,
      toggleRoster: StackWindow.#onToggleRoster,
      clearStack: StackWindow.#onClearStack,
      resetPosition: StackWindow.#onResetPosition,
    },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/stack-window.hbs` },
  };

  static _instance = null;

  static open() {
    this._instance ??= new StackWindow();
    this._instance.render({ force: true });
    return this._instance;
  }

  static refresh() {
    if (!this._instance?.rendered || this._refreshTimer) return;
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      if (this._instance?.rendered) this._instance.render();
    }, 30);
  }

  
  static toggle() {
    if (this._instance?.rendered) {
      this._instance.close();
      return null;
    }
    return this.open();
  }

  get title() {
    return game.i18n.localize("DS_TRIGGERS.Queue.Title");
  }

  
  _getFrameButtons(options) {
    return [
      ...super._getFrameButtons(options),
      ...(game.user.isGM ? [{
        icon: "fa-solid fa-trash-can-xmark",
        label: "DS_TRIGGERS.Queue.ClearStack",
        action: "clearStack",
      }] : []),
      {
        icon: "fa-solid fa-bell-slash",
        label: "DS_TRIGGERS.Queue.RosterToggle",
        action: "toggleRoster",
      },
    ];
  }

  _getHeaderControls() {
    return [
      ...super._getHeaderControls(),
      { icon: "fa-solid fa-arrows-to-circle", label: "DS_TRIGGERS.Queue.ResetPosition", action: "resetPosition" },
    ];
  }

  static #onResetPosition() {
    this._userPlaced = false;
    game.settings.set(MODULE_ID, "stackPosition", null).catch(() => {});
    this._anchor();
  }

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    const saved = game.settings.get(MODULE_ID, "stackPosition");
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) {
      this._userPlaced = true;
      this.setPosition({ left: saved.left, top: saved.top });
    }
  }

  _placedByUser() {
    this._userPlaced = true;
    game.settings.set(MODULE_ID, "stackPosition", { left: Math.round(this.position.left), top: Math.round(this.position.top) }).catch(() => {});
  }

  _anchor() {
    if (this._userPlaced || this._dragging || this.minimized || !this.rendered) return;
    const width = Number.isFinite(this.position.width) ? this.position.width : this.element.offsetWidth;
    const height = this.element.offsetHeight;
    const left = Math.max(0, stackRightEdge() - width - EDGE_GAP);
    let bottom = window.innerHeight - EDGE_GAP;
    const bar = ui.hotbar?.element?.getBoundingClientRect();
    if (bar?.width && left < bar.right && left + width > bar.left) bottom = Math.min(bottom, bar.top - EDGE_GAP);
    const top = Math.max(0, bottom - height);
    if (Math.abs(left - this.position.left) < 1 && Math.abs(top - this.position.top) < 1) return;
    this._anchoring = true;
    try { this.setPosition({ left, top }); } finally { this._anchoring = false; }
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);
    
    const isHeldKind = (e) => e.kind === "held" || e.kind === "damageHeld" || e.kind === "resolutionHeld";
    const groupKey = (e) => e.resumeId ?? e.damageId ?? e.resolutionId ?? e.promptId ?? null;
    const ordered = [...getQueueMirror()].sort((a, b) => {
      const reaper = (a.kind === "reaper") - (b.kind === "reaper");
      if (reaper) return reaper;
      const held = isHeldKind(a) - isHeldKind(b);
      if (held) return held;
      if (groupKey(a) && groupKey(a) === groupKey(b)) return (b.playerSide ? 1 : 0) - (a.playerSide ? 1 : 0);
      return 0;
    });
    const moments = momentsOf(getQueueMirror().filter((q) => !isHeldKind(q) && q.kind !== "reaper"));
    const gateKeys = (e) => [groupKey(e), ...(e.choices ?? []).map((c) => c.promptId ?? c.damageId ?? null)].filter(Boolean);
    const isGated = (e) => !e.playerSide && !isHeldKind(e) && e.kind !== "reaper"
      && getQueueMirror().some((q) => !isHeldKind(q) && q.playerSide && q.state === "pending"
        && ((moments.get(q.id) != null && moments.get(q.id) === moments.get(e.id)) || gateKeys(e).includes(groupKey(q))));
    const awaitsChoosers = (e) => {
      if (e.choices?.length || e.squadChooser) return false;
      const base = squadBase(e);
      return !!base && getQueueMirror().some((q) => q.state === "pending" && q.squadChooser === base);
    };
    const { list: shown, roles: holdRoles, maybe: holdMaybe } = arrangeHolds(mergeSquadHolds(ordered, getQueueMirror()),
      (e) => e.state === "pending" && (isGated(e) || awaitsChoosers(e)));
    const embeds = await Promise.all(shown.map((e) => e.featureLine ? Promise.resolve(featureLinePreview(e.featureLine))
      : e.itemUuid
      ? buildAbilityPreview(fromUuidSync(e.itemUuid), { includeMeta: true, includeTrigger: true, includeTriggeredAction: true }).catch(() => "")
      : Promise.resolve("")));
    const roster = buildRoster();
    
    for (const s of roster.sections ?? []) if (this._sectionOpen?.has(s.id)) s.collapsed = !this._sectionOpen.get(s.id);
    return {
      isGM: game.user.isGM,
      roster,
      
      
      rosterOpen: (this._rosterOpen ??= !shown.length),
      maliceChipURI: ctlib()?.resourceTokenURI?.("malice"),
      labels: {
        use: L("Use"), choose: L("Choose"), chooseTooltip: L("ChooseTooltip"), chooseRandomTooltip: L("ChooseRandomTooltip"), decline: L("Decline"), dismiss: L("Dismiss"),
        dismissTooltip: L("DismissTooltip"), empty: L("Empty"),
        markUsed: game.i18n.localize("DS_TRIGGERS.Villain.MarkUsed"),
        markUsedTooltip: game.i18n.localize("DS_TRIGGERS.Villain.MarkUsedTooltip"),
        release: L("Release"), releaseTooltip: L("ReleaseTooltip"),
        applyNow: L("ApplyNow"), applyNowTooltip: L("ApplyNowTooltip"),
        redirectPick: L("RedirectPickButton"), redirectNone: L("RedirectNoneButton"), redirectNoneTooltip: L("RedirectNoneTooltip"), redirectKeepTooltip: L("RedirectKeepTooltip"),
        releaseResolution: L("ReleaseResolution"), releaseResolutionTooltip: L("ReleaseResolutionTooltip"),
        gatedTooltip: L("PlayerPriorityTooltip"),
        squadWaitTooltip: L("SquadWaitTooltip"),
        showAbility: L("ShowAbility"),
        free: game.i18n.localize("DS_TRIGGERS.Reminder.Free"),
        noAction: game.i18n.localize("DS_TRIGGERS.Reminder.NoAction"),
        rosterTitle: L("RosterTitle"),
        rosterEmptyGM: L("RosterEmptyGM"),
        rosterEmptyPlayer: L("RosterEmptyPlayer"),
        snoozeTooltip: L("SnoozeTooltip"),
        snoozeEntryTooltip: L("SnoozeEntryTooltip"),
        snoozeAllTooltip: L("SnoozeAllTooltip"),
        snoozeActorTooltip: L("SnoozeActorTooltip"),
        snoozeShort: L("SnoozeShort"), snoozedShort: L("SnoozedShort"), snoozeCreatureShort: L("SnoozeCreatureShort"),
        snoozePartTooltip: L("SnoozePartTooltip"),
        rosterSearch: L("RosterSearch"),
        rosterSearchHint: L("RosterSearchHint"),
        rosterNoMatch: L("RosterNoMatch"),
        openItem: L("RosterOpenItem"),
        groupMuted: L("GroupMuted"),
        area: L("Area"), areaTooltip: L("AreaTooltip"),
        reaperReason: L("ReaperReason"), reaperQuoteBy: L("ReaperQuoteBy"), reaperMemorial: L("ReaperMemorial"), reaperMaybe: L("ReaperMaybe"),
      },
      entries: shown.map((e, i) => {
        const isHeld = e.kind === "held";
        const isDamageHeld = e.kind === "damageHeld";
        const isResolutionHeld = e.kind === "resolutionHeld";
        const embedHTML = embeds[i];
        const embedOpen = this._openEmbeds?.has(e.id) ?? false;
        const pendingCount = isHeld
          ? getQueueMirror().filter((q) => q.state === "pending" && (q.resumeId === e.resumeId || q.choices?.some((c) => c.resumeId === e.resumeId))).length
          : isDamageHeld
            ? getQueueMirror().filter((q) => q.state === "pending" && [q.damageId, ...(q.choices ?? []).map((c) => c.damageId)].includes(e.damageId)).length
            : isResolutionHeld
              ? getQueueMirror().filter((q) => q.resolutionId === e.resolutionId && q.state === "pending").length
              : 0;
        const ownerDoc = e.ownerActorUuid ? fromUuidSync(e.ownerActorUuid) : null;
        const item = e.itemUuid ? fromUuidSync(e.itemUuid) : null;
        const sys = item?.system;

        let costBadge = null;
        if (e.featureLine?.maliceCost) costBadge = { malice: true, label: game.i18n.format("DS_TRIGGERS.Queue.CostMalice", { n: e.featureLine.maliceCost }) };
        else if (Number.isFinite(sys?.resource) && sys.resource > 0) {
          const malice = ownerDoc?.type !== "hero" && ownerDoc?.type !== "character";
          costBadge = {
            malice,
            label: malice
              ? game.i18n.format("DS_TRIGGERS.Queue.CostMalice", { n: sys.resource })
              : `${sys.resource} ${ownerDoc?.system?.coreResource?.name ?? ""}`.trim(),
          };
        }

        
        const side = sideOf(e);
        return {
          ...e,
          chips: UNSIDED_KINDS.has(e.kind) ? [] : impactChips(e, (docs) => faceChain(docs)),
          holdRole: holdRoles.get(e.id) ?? null,
          holdMaybe: holdMaybe.has(e.id),
          side: side?.side ?? null,
          sideColour: side?.colour ?? null,
          embedHTML,
          embedOpen,
          iconSrc: item?.img ?? null,
          ownerClickable: !!ownerDoc && ownerDoc.testUserPermission(game.user, "LIMITED"),
          isHeld,
          isDamageHeld,
          isResolutionHeld,
          costBadge,
          isFree: e.featureLine ? e.featureLine.action === "freeTriggered" : sys?.type === "freeTriggered",
          heldEyebrow: isHeld
            ? game.i18n.format("DS_TRIGGERS.Queue.HeldBy", { name: e.ownerName })
            : isDamageHeld
              ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEyebrow", { name: e.ownerName })
              : isResolutionHeld
                ? game.i18n.format("DS_TRIGGERS.Queue.ResolutionEyebrow", { name: e.ownerName })
                : null,
          
          fmTrail: (e.fmTrail ?? []).map((t) => ({
            dir: t.amount < 0 ? "down" : "up",
            label: `${t.amount > 0 ? "+" : ""}${t.amount}`,
            tooltip: game.i18n.format("DS_TRIGGERS.Queue.FmTrailTooltip", {
              modName: t.modName, owner: t.ownerName ?? "",
            }),
          })),
          fmRunningLabel: e.fmRunning == null ? "" : game.i18n.format("DS_TRIGGERS.Queue.FmNow", { n: e.fmRunning }),
          fmStopped: e.fmRunning === 0,
          isPending: e.state === "pending",
          isChoosing: !!e.choices?.length,
          canRandom: new Set((e.choices ?? []).map((c) => c.subjectTokenUuid).filter(Boolean)).size > 1,
          choiceCauseHTML: e.choices?.length ? choiceCauseHTML(e) : null,
          isReaper: e.kind === "reaper",
          isArea: isDamageHeld && !!e.heldDamage?.squad?.areaCap,
          itemNameHTML: isDamageHeld ? cappedNameHTML(e) : null,
          reaperGroups: e.kind === "reaper" ? reaperGroups(e) : null,
          ownerFaces: isDamageHeld
            ? faceChain((e.subjectUuids ?? [e.heldDamage?.tokenUuid]).map((u) => (u ? fromUuidSync(u) : null)))
            : e.itemUuid ? faceChain([e.ownerActorUuid, ...(e.squad ?? []).map((m) => m.ownerActorUuid)].map(tokenOfActor)) : "",
          ownerName: e.squad?.length ? game.i18n.format("DS_TRIGGERS.Squad.OwnerCount", { name: e.ownerName, n: e.squad.length + 1 }) : e.ownerName,
          damageIdsJoined: (e.damageIds ?? [e.damageId]).filter(Boolean).join(","),
          itemName: isDamageHeld && (e.damageIds?.length ?? 1) > 1
            ? game.i18n.format("DS_TRIGGERS.Queue.HeldDamageEach", { entry: e.itemName })
            : e.itemName,
          reaperCertain: e.certain ?? [],
          reaperMaybe: e.maybe ?? [],
          reaperStatus: e.status === "picking"
            ? game.i18n.format("DS_TRIGGERS.Queue.ReaperPicking", { name: e.picker ?? game.i18n.localize("DS_TRIGGERS.Queue.ReaperSomeone") })
            : e.status === "impending" ? L("ReaperImpending") : null,
          gated: isGated(e) || awaitsChoosers(e),
          gate: awaitsChoosers(e) ? "squad" : isGated(e) ? "player" : null,
          chooseLabel: e.squadChooser ? L("SquadChoose") : null,
          chooseTip: e.squadChooser ? L("SquadChooseTooltip") : null,
          
          
          showButtons: !isHeld && !isDamageHeld && !isResolutionHeld && e.kind !== "redirect" && e.state === "pending",
          showMarkUsed: !!e.villain && game.user.isGM && e.state === "pending",
          notYours: !canActOn(e),
          ...(() => {
            const id = e.state === "pending" && canActOn(e) ? snoozeIdOf(e) : null;
            const owner = id && e.ownerActorUuid ? fromUuidSync(e.ownerActorUuid) : null;
            const snooze = owner ? snoozeFor(owner, id) : null;
            return { snoozeId: owner ? id : null, snoozed: !!snooze, snoozeLabel: snooze?.label ?? "" };
          })(),
          notYoursTooltip: game.i18n.format("DS_TRIGGERS.Queue.NotYoursTooltip", { owner: e.ownerName }),
          showRelease: isHeld && game.user.isGM,
          showApplyNow: isDamageHeld && game.user.isGM && e.state !== "resolving",
          isRedirect: e.kind === "redirect" && e.state === "pending",
          redirectHint: e.redirect ? game.i18n.format(e.redirect.swaps ? "DS_TRIGGERS.Queue.RedirectSwapHint" : "DS_TRIGGERS.Queue.RedirectPickHint", { modName: e.redirect.modName }) : null,
          showReleaseResolution: isResolutionHeld && game.user.isGM,
          isGrace: e.state === "grace",
          graceRemaining: e.graceUntil ? Math.max(0, Math.ceil((e.graceUntil - Date.now()) / 1000)) : null,
          heldStatus: (isHeld || isDamageHeld || isResolutionHeld)
            ? (e.state === "grace" ? null : e.state === "resolving" ? L("Resolving") : game.i18n.format("DS_TRIGGERS.Queue.WaitingOn", { count: pendingCount }))
            : null,
          stateLabel: L(`State.${e.state}`),
        };
      }),
    };
  }

  async _preRender(context, options) {
    await super._preRender(context, options);
    const rows = [...(this.element?.querySelectorAll(".dst-stack-list > .dst-stack-entry[data-entry-id]") ?? [])];
    const staying = new Set((context.entries ?? []).map((e) => e.id));
    this._oldRows = rows.map((row, i) => ({ row, id: row.dataset.entryId, after: rows.slice(i + 1).map((r) => r.dataset.entryId),
      ghost: row.classList.contains("dst-stack-entry--leaving") })).filter((o) => !staying.has(o.id));
    for (const o of this._oldRows) if (!o.ghost) o.height = o.row.offsetHeight;
  }

  _funnelOut() {
    const OUT_MS = 280;
    const STAGGER_MS = 70;
    const old = this._oldRows ?? [];
    this._oldRows = null;
    const list = this.element.querySelector(".dst-stack-list");
    const live = new Set([...this.element.querySelectorAll(".dst-stack-entry[data-entry-id]")].map((r) => r.dataset.entryId));
    const leaving = old.filter((o) => !live.has(o.id));
    if (!leaving.length || reducedEffects()) return;
    const host = list ?? this.element.querySelector(".dst-stack")?.insertAdjacentElement("afterbegin", Object.assign(document.createElement("ul"), { className: "dst-stack-list dst-stack-list--ghosts" }));
    if (!host) return;
    const gap = parseFloat(getComputedStyle(host).rowGap) || 0;
    const place = (o) => {
      const anchor = o.after.map((id) => host.querySelector(`:scope > .dst-stack-entry[data-entry-id="${CSS.escape(id)}"]`)).find(Boolean);
      host.insertBefore(o.row, anchor ?? null);
    };
    for (const o of leaving.filter((o) => o.ghost)) place(o);
    const anims = leaving.filter((o) => !o.ghost).map((o, i) => {
      const ghost = o.row;
      ghost.classList.add("dst-stack-entry--leaving");
      ghost.inert = true;
      place(o);
      return ghost.animate([
        { opacity: 1, transform: "none", height: `${o.height}px`, marginBottom: "0px", clipPath: "inset(0 0 0 0 round 6px)" },
        { opacity: 0, transform: "translateY(-10px) scale(0.96)", height: "0px", paddingTop: "0px", paddingBottom: "0px", borderWidth: "0px",
          marginBottom: `${-gap}px`, clipPath: "inset(0 0 100% 0 round 6px)" },
      ], { duration: OUT_MS, delay: i * STAGGER_MS, easing: "cubic-bezier(0.4, 0, 0.6, 1)", fill: "forwards" }).finished
        .catch(() => {}).finally(() => ghost.remove());
    });
    Promise.all(anims).then(() => {
      if (!list) host.remove();
      if (this.rendered && !this._userSized) this.setPosition({ height: "auto" });
    });
  }

  _onRender(_context, _options) {
    richify(this.element, "StackCategory");
    const list = this.element.querySelector(".dst-stack");
    if (list && this._stackScroll) list.scrollTop = this._stackScroll;
    if (list && this._scrollWatched !== list) {
      this._scrollWatched = list;
      list.addEventListener("scroll", () => { this._stackScroll = list.scrollTop; }, { passive: true });
    }
    
    
    
    const handle = this.element.querySelector(".window-resize-handle");
    if (handle && this._resizeHookedOn !== handle) {
      this._resizeHookedOn = handle;
      handle.addEventListener("pointerdown", () => {
        this._userSized = true;
        this._dragging = true;
        window.addEventListener("pointerup", () => { this._dragging = false; this._placedByUser(); }, { once: true });
      });
    }
    const header = this.element.querySelector(".window-header");
    if (header && this._dragHookedOn !== header) {
      this._dragHookedOn = header;
      header.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest("button, a, input, .header-control")) return;
        this._dragging = true;
        const start = { left: this.position.left, top: this.position.top };
        window.addEventListener("pointerup", () => {
          this._dragging = false;
          if (Math.abs(this.position.left - start.left) > 2 || Math.abs(this.position.top - start.top) > 2) this._placedByUser();
          else this._anchor();
        }, { once: true });
      });
    }
    
    const stackKey = getQueueMirror().map((e) => `${e.id}:${e.state}`).join("|");
    const stackChanged = stackKey !== this._lastStackKey;
    this._lastStackKey = stackKey;
    setTimeout(() => {
      if (!this._userSized && (stackChanged || !this._sizedOnce)) this.setPosition({ height: "auto" });
      this._sizedOnce = true;
      this._fitRoster();
    }, 0);
    const count = getQueueMirror().length;
    const titleEl = this.element.querySelector(".window-header .window-title");
    if (titleEl) {
      const text = count
        ? `${this.title} · ${game.i18n.format("DS_TRIGGERS.Queue.InStack", { count })}`
        : this.title;
      titleEl.innerHTML = `<img class="dst-window-emblem" src="modules/${MODULE_ID}/icons/emblem-coin.png" alt="">${text}`;
    }

    
    
    this.element.querySelector('.header-control[data-action="toggleRoster"]')?.classList.toggle("is-open", !!this._rosterOpen);
    const clear = this.element.querySelector('.header-control[data-action="clearStack"]');
    if (clear) clear.disabled = !getQueueMirror().some((e) => e.state === "pending");
    if (this._widthFor !== !!this._rosterOpen) {
      this.setPosition({ width: this._rosterOpen ? ROSTER_OPEN_WIDTH : STACK_WIDTH });
      this._widthFor = !!this._rosterOpen;
    }
    for (const d of this.element.querySelectorAll("details.dst-roster-section[data-section]")) {
      d.addEventListener("toggle", () => (this._sectionOpen ??= new Map()).set(d.dataset.section, d.open));
    }
    for (const uuid of this._rosterEmbeds ?? []) {
      const host = this.element.querySelector("[data-embed-for=" + JSON.stringify(uuid) + "]");
      const button = this.element.querySelector(`.dst-roster-expand[data-ability-uuid=${JSON.stringify(uuid)}]`);
      if (host) StackWindow.#openRosterEmbed(host, button?.querySelector("i"), uuid);
      else this._rosterEmbeds.delete(uuid);
    }
    const search = this.element.querySelector(".dst-roster-search");
    if (search) {
      search.value = this._rosterQuery ?? "";
      search.addEventListener("input", () => { this._rosterQuery = search.value; this._filterRoster(); });
      this._filterRoster();
    }
    this._fitRoster();

    ctlib()?.activateFaces?.(this.element);
    this._funnelIn();
    this._funnelOut();
    if (this._focusId) this._focusEntry(this._focusId);
    this._openEmbeds ??= new Set();
    for (const chip of this.element.querySelectorAll(".dst-impact--manual[data-entry-id]")) {
      const open = () => this.element.querySelector(`.dst-stack-embed-toggle[data-entry-id="${CSS.escape(chip.dataset.entryId)}"]`)?.click();
      chip.addEventListener("click", open);
      chip.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
    }
    for (const toggle of this.element.querySelectorAll(".dst-stack-embed-toggle")) {
      toggle.addEventListener("click", () => {
        const id = toggle.dataset.entryId;
        const content = this.element.querySelector(`[data-embed-for="${id}"]`);
        if (!content) return;
        content.hidden = !content.hidden;
        if (content.hidden) this._openEmbeds.delete(id);
        else this._openEmbeds.add(id);
        toggle.querySelector("i")?.classList.toggle("fa-chevron-right", content.hidden);
        toggle.querySelector("i")?.classList.toggle("fa-chevron-down", !content.hidden);
        this.setPosition({ height: "auto" });
      });
    }
    clearInterval(this._graceTicker);
    const tick = () => {
      for (const span of this.element.querySelectorAll("[data-grace-until]")) {
        const remaining = Math.max(0, Math.ceil((Number(span.dataset.graceUntil) - Date.now()) / 1000));
        span.textContent = game.i18n.format(span.dataset.graceKey || "DS_TRIGGERS.Queue.GraceCountdown", { seconds: remaining });
      }
      for (const span of this.element.querySelectorAll("[data-created-at]")) {
        const age = Math.floor((Date.now() - Number(span.dataset.createdAt)) / 1000);
        
        if (age < 8) {
          span.textContent = game.i18n.localize("DS_TRIGGERS.Queue.Now");
          span.classList.add("dst-stack-age--now");
        } else {
          span.classList.remove("dst-stack-age--now");
          span.textContent = age < 60
            ? game.i18n.format("DS_TRIGGERS.Queue.AgeSeconds", { n: age })
            : age < 3600
              ? game.i18n.format("DS_TRIGGERS.Queue.AgeMinutes", { n: Math.floor(age / 60) })
              : game.i18n.format("DS_TRIGGERS.Queue.AgeHours", { n: Math.floor(age / 3600) });
        }
      }
    };
    if (this.element.querySelector("[data-grace-until], [data-created-at]")) {
      tick();
      this._graceTicker = setInterval(tick, 1000);
    }
  }

  static focus(entryId) {
    const app = this._instance?.rendered ? this._instance : null;
    if (app) return app._focusEntry(entryId);
    this._instance ??= new StackWindow();
    this._instance._focusId = entryId;
    this._instance.render({ force: true });
  }

  _focusEntry(entryId) {
    this._focusId = null;
    if (this.minimized) this.maximize();
    this.bringToFront?.();
    const rows = [entryId].flat().map((id) => this.element?.querySelector(`.dst-stack-entry[data-entry-id="${CSS.escape(id)}"]`)).filter(Boolean);
    rows[0]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    for (const row of rows) {
      row.style.setProperty("--dst-flash-colour", row.style.getPropertyValue("--dst-side") || "var(--dst-gold-text, #d9a63f)");
      row.classList.remove("dst-flash");
      void row.offsetWidth;
      row.classList.add("dst-flash");
    }
  }

  _funnelIn() {
    const FUNNEL_MS = 320;
    const STAGGER_MS = 110;
    const rows = [...this.element.querySelectorAll(".dst-stack-entry[data-entry-id]")];
    const now = performance.now();
    this._seenEntries ??= new Map();
    let next = Math.max(now, ...[...this._seenEntries.values()].map((t) => t + STAGGER_MS));
    for (const row of rows) {
      const id = row.dataset.entryId;
      if (!this._seenEntries.has(id)) {
        this._seenEntries.set(id, next);
        next += STAGGER_MS;
      }
    }
    const live = new Set(rows.map((r) => r.dataset.entryId));
    for (const id of this._seenEntries.keys()) if (!live.has(id)) this._seenEntries.delete(id);
    if (reducedEffects()) return;
    for (const row of rows) {
      const delay = this._seenEntries.get(row.dataset.entryId) - now;
      if (delay + FUNNEL_MS <= 0) continue;
      row.animate([
        { opacity: 0, transform: "translateY(-14px) scale(0.96)", clipPath: "inset(0 0 100% 0 round 6px)" },
        { opacity: 1, transform: "translateY(2px) scale(1)", clipPath: "inset(0 0 0 0 round 6px)", offset: 0.75 },
        { opacity: 1, transform: "none", clipPath: "inset(0 0 0 0 round 6px)" },
      ], { duration: FUNNEL_MS, delay, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "backwards" });
    }
  }

  close(options) {
    clearInterval(this._graceTicker);
    clearTimeout(this._drawerTimer);
    return super.close(options);
  }

  static async #onUse(event, target) {
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    if (!entry || entry.choices?.length) return;
    if (!canActOn(entry)) return;
    if (StackWindow.#gated(event, target)) return;
    await StackWindow.#useEntry(entry);
  }

  static #gated(event, target) {
    if (!target.classList.contains("dst-use-gated") || (game.user.isGM && event?.shiftKey)) return false;
    ui.notifications.warn(target.dataset.gate === "squad" ? "DS_TRIGGERS.Queue.SquadWaitWarn" : "DS_TRIGGERS.Queue.PlayerPriorityWarn", { localize: true });
    return true;
  }

  static async autoUse(entries) {
    if (autoUseLevel() === "none") return;
    for (const entry of entries.filter(autoUsable)) {
      await StackWindow.#useEntry(entry, { auto: true }).catch((err) => console.warn(`${MODULE_ID} | could not auto-use ${entry.itemName}`, err));
    }
  }

  static async #useEntry(entry, { auto = false } = {}) {
    const maliceCost = Number(entry.featureLine?.maliceCost) || 0;
    if (maliceCost) {
      const held = maliceValue();
      if (held < maliceCost) {
        ui.notifications.warn(game.i18n.format("DS_TRIGGERS.Queue.NotEnoughMalice", { n: maliceCost, have: held, name: entry.itemName }));
        return;
      }
      if (!(game.user.isGM ? await spendMalice(maliceCost) : await asPrimaryGM("spendMalice", maliceCost))) return;
    }
    if (entry.gain || entry.pill || (entry.featureLine && !entry.derived)) {
      resolveQueueEntry(entry.id, "used");
      return;
    }
    const item = await fromUuid(entry.itemUuid).catch(() => null);
    resolveQueueEntry(entry.id, "used");
    if (item) {

      addRollBypass(item.uuid);
      watchUseCancellation(item.uuid);
      _stackUses.set(item.uuid, { auto });
      try {
        await useWithTriggerContext(item, entry);
      } finally {
        _stackUses.delete(item.uuid);
      }
    }
  }

  
  static async #onChooseSubject(event, target, { random = false } = {}) {
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    if (!entry?.choices?.length || !canActOn(entry)) return;
    if (StackWindow.#gated(event, target)) return;
    const byToken = new Map();
    for (const c of entry.choices) {
      const token = c.subjectTokenUuid ? fromUuidSync(c.subjectTokenUuid)?.object : null;
      if (token && !byToken.has(token.id)) byToken.set(token.id, { token, choice: c });
    }
    const options = [...byToken.values()];
    let choice = null;
    if (options.length <= 1) choice = options[0]?.choice ?? entry.choices[0];
    else if (random) choice = options[Math.floor(Math.random() * options.length)].choice;
    else {
      const picked = await pickTriggerSubject(options.map((v) => v.token),
        game.i18n.format("DS_TRIGGERS.Queue.PickChoice", { modName: entry.itemName }));
      choice = picked ? byToken.get(picked.id)?.choice : null;
    }
    if (!choice) return;
    const placed = await chooseQueueSubject(entry.id, choice.key);
    if (placed?.joined || placed?.waiting) return;
    const { key, ...fields } = choice;
    const chosen = { ...entry, ...fields };
    delete chosen.choices;
    await StackWindow.#useEntry(chosen);
  }

  static #onChooseRandom(event, target) {
    return StackWindow.#onChooseSubject(event, target, { random: true });
  }

  static #onDecline(_event, target) {
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    if (!entry || !canActOn(entry)) return;
    resolveQueueEntry(entry.id, "declined");
  }

  static #onDismiss(_event, target) {
    resolveQueueEntry(target.dataset.id, "dismissed");
  }

  static async #onClearStack() {
    if (!game.user.isGM) return;
    for (const e of getQueueMirror().filter((q) => q.state === "pending")) await resolveQueueEntry(e.id, "dismissed");
  }

  static #onMarkVillainUsed(_event, target) {
    if (!game.user.isGM) return;
    markVillainUsed(target.dataset.id);
  }

  static #onReleaseHeld(_event, target) {
    releaseHeld(target.dataset.resumeId);
  }

  static #onApplyHeldNow(_event, target) {
    for (const id of (target.dataset.damageIds ?? "").split(",").filter(Boolean)) applyHeldDamageNow(id);
  }

  static #onRedirectPick(_event, target) {
    chooseRedirectEntry(target.dataset.id, "pick");
  }

  static #onRedirectNone(_event, target) {
    chooseRedirectEntry(target.dataset.id, "none");
  }

  static #onReleaseResolutionNow(_event, target) {
    releaseResolutionNow(target.dataset.resolutionId);
  }

  static async #onOpenOwner(_event, target) {
    const doc = await fromUuid(target.dataset.uuid).catch(() => null);
    doc?.sheet?.render(true);
  }

  static async #onSnoozeActor(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const { actorUuid, name } = target.dataset;
    const actor = actorUuid ? fromUuidSync(actorUuid) : null;
    if (!actor) return;
    const existing = actorSnoozeFor(actor);
    if (existing) await clearSnooze(actor, existing.key);
    else {
      const choice = await promptSnooze(name);
      if (!choice) return;
      await setSnooze(actor, { actorUuid, ownerUuid: actorUuid, ...choice });
    }
    this.render();
  }

  
  _filterRoster() {
    const root = this.element?.querySelector(".dst-roster");
    if (!root) return;
    const terms = [...String(this._rosterQuery ?? "").matchAll(/['‘’]([^'‘’]*)['‘’]?|["“”]([^"“”]*)["“”]?|(\S+)/g)]
      .map((m) => (m[1] != null ? ["trigger", m[1]] : m[2] != null ? ["effect", m[2]] : ["name", m[3]]))
      .map(([k, v]) => [k, v.trim().toLowerCase()]).filter(([, v]) => v);
    const field = { name: "searchName", trigger: "searchTrigger", effect: "searchEffect" };
    let shown = 0;
    for (const row of root.querySelectorAll(".dst-roster-row")) {
      const ok = terms.every(([k, v]) => (row.dataset[field[k]] ?? "").includes(v));
      row.hidden = !ok;
      if (ok) shown++;
    }
    for (const box of root.querySelectorAll(".dst-roster-group, .dst-roster-section")) {
      const any = !!box.querySelector(".dst-roster-row:not([hidden])");
      box.hidden = !!terms.length && !any;
      if (terms.length && any) box.open = true;
    }
    const none = root.querySelector(".dst-roster-nomatch");
    if (none) none.hidden = !terms.length || shown > 0;
  }

  static async #onSnoozeEntry(event, target) {
    event.preventDefault();
    event.stopPropagation();
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    const id = entry ? snoozeIdOf(entry) : null;
    if (!id || !canActOn(entry)) return;
    const actors = snoozeActorsOf(entry).map((uuid) => fromUuidSync(uuid)).filter(Boolean);
    const snoozed = actors.map((a) => [a, snoozeFor(a, id)]).filter(([, s]) => s);
    if (snoozed.length) {
      for (const [actor, s] of snoozed) await clearSnooze(actor, s.key);
      this.render();
      return;
    }
    const choice = await promptSnooze(entry.itemName);
    if (!choice) return;
    for (const actor of actors) await setSnooze(actor, { dsid: id, ownerUuid: actor.uuid, ...choice });
    this.render();
  }

  static async #onSnoozeTrigger(_event, target) {
    const { dsid, actorUuid, name, part } = target.dataset;
    const actor = actorUuid ? fromUuidSync(actorUuid) : null;
    const existing = part ? exactSnoozeFor(actor, dsid) : snoozeFor(actor, dsid);
    if (existing) {
      await clearSnooze(actor, existing.key);
      this.render();
      return;
    }
    const choice = await promptSnooze(name);
    if (!choice) return;
    
    
    await setSnooze(actor, { dsid, ownerUuid: actorUuid, ...choice });
    this.render();
  }

  
  
  _fitRoster() {
    const shell = this.element?.querySelector(".dst-shell");
    const content = this.element?.querySelector(".window-content");
    if (!shell || !content) return;
    const fixed = !!this.element.style.height;
    shell.classList.toggle("is-fixed", fixed);
    if (!fixed) {
      shell.style.height = "";
      return;
    }
    const room = content.getBoundingClientRect().bottom - shell.getBoundingClientRect().top;
    shell.style.height = `${Math.max(120, Math.floor(room))}px`;
  }

  _onPosition(position) {
    super._onPosition?.(position);
    this._fitRoster();
    if (!this._anchoring) this._anchor();
  }

  _onClose(options) {
    super._onClose?.(options);
    this._sizedOnce = false;
    this._widthFor = undefined;
    this._lastStackKey = undefined;
  }

  _setRosterOpen(open) {
    this._rosterOpen = !!open;
    this.element.querySelector(".dst-shell")?.classList.toggle("roster-open", this._rosterOpen);
    this.element.querySelector(".dst-roster")?.classList.toggle("expanded", this._rosterOpen);
    this.element.querySelector('.header-control[data-action="toggleRoster"]')?.classList.toggle("is-open", this._rosterOpen);
    
    
    this.element.style.transition = "width 0.25s ease, left 0.25s ease";
    this.setPosition({ width: this._rosterOpen ? ROSTER_OPEN_WIDTH : STACK_WIDTH });
    this._widthFor = this._rosterOpen;
    clearTimeout(this._drawerTimer);
    this._drawerTimer = setTimeout(() => { if (this.element) this.element.style.transition = ""; }, 300);
  }

  static #onToggleRoster() {
    this._setRosterOpen(!this._rosterOpen);
  }

  static async #onSnoozeAll() {
    await toggleSnooze();
    this.render();
  }

  static #onToggleRosterEmbed(_event, target) {
    const uuid = target.dataset.abilityUuid;
    const host = this.element.querySelector("[data-embed-for=" + JSON.stringify(uuid) + "]");
    if (!host) return;
    const icon = target.querySelector("i");
    this._rosterEmbeds ??= new Set();
    if (!host.hidden) {
      host.hidden = true;
      icon?.classList.replace("fa-angle-down", "fa-angle-right");
      this._rosterEmbeds.delete(uuid);
      return;
    }
    this._rosterEmbeds.add(uuid);
    StackWindow.#openRosterEmbed(host, icon, uuid);
  }

  static #openRosterEmbed(host, icon, uuid) {
    host.hidden = false;
    icon?.classList.replace("fa-angle-right", "fa-angle-down");
    if (host.dataset.built) return;
    host.dataset.built = "1";
    buildAbilityPreview(fromUuidSync(uuid), { includeMeta: true, includeTrigger: true })
      .then((html) => { host.innerHTML = html; })
      .catch(() => { host.innerHTML = ""; });
  }
}

Hooks.on("dst.queueChanged", () => StackWindow.refresh());
Hooks.on("dst.queueOpenRequested", () => {
  if (getSetting("tokenBadges") === false || getSetting("badgesInsteadOfStack") === false) StackWindow.open();
});
Hooks.on("dst.queueAdded", (entries) => StackWindow.autoUse(entries));

for (const hook of ["createCombat", "deleteCombat"]) Hooks.on(hook, () => StackWindow.refresh());
Hooks.on("updateCombat", (combat, changed) => { if ("round" in changed || "active" in changed) StackWindow.refresh(); });
Hooks.on("createCombatant", () => StackWindow.refresh());
for (const hook of ["createToken", "deleteToken"]) Hooks.on(hook, (doc) => { if (doc.parent === canvas?.scene) StackWindow.refresh(); });
Hooks.on("deleteCombatant", () => StackWindow.refresh());
Hooks.on("updateCombatant", (_combatant, changed) => { if ("defeated" in changed) StackWindow.refresh(); });

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl = controls.tokens ?? controls.token;
  if (!tokenControl) return;

  const tool = {
    name: "dst-stack",
    title: game.i18n.localize("DS_TRIGGERS.Queue.OpenStackButton"),
    icon: "fa-solid fa-layer-group",
    button: true,
    visible: true,
    onChange: () => StackWindow.toggle(),
  };

  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(tool);
  } else {
    tool.order = Object.keys(tokenControl.tools).length;
    tokenControl.tools["dst-stack"] = tool;
  }
});

function markStackButton() {
  const mirror = getQueueMirror();
  const triggers = mirror.filter((e) => !HELD_KINDS.has(e.kind) && e.kind !== "reaper" && e.state === "pending").length;
  const title = game.i18n.localize("DS_TRIGGERS.Queue.OpenStackButton");
  for (const btn of document.querySelectorAll('[data-tool="dst-stack"]')) {
    btn.classList.toggle("dst-stack-lit", mirror.length > 0);
    if (triggers) btn.dataset.dstCount = triggers > 9 ? "9+" : String(triggers);
    else delete btn.dataset.dstCount;
    btn.setAttribute("aria-label", triggers ? game.i18n.format("DS_TRIGGERS.Queue.OpenStackButtonCount", { title, n: triggers }) : title);
  }
}


const HELD_BUTTONS = "button.dst-dstd-res-locked, button.dst-dstd-held-btn:not(.dst-dstd-redirected-btn)";

function holdsButton(e, messageId, button) {
  if (e.kind === "resolutionHeld") return e.resolution?.messageId === messageId && (!button || button.classList.contains("dst-dstd-res-locked"));
  if (!button || e.heldAt?.messageId !== messageId) return false;
  if (e.heldAt.opId) return e.heldAt.opId === button.dataset.operationId;
  const row = button.closest("[data-dsct-fm-key]")?.dataset.dsctFmKey ?? "";
  return !!e.heldAt.rowKey && e.heldAt.rowKey === row.slice(row.indexOf(":") + 1);
}

function holdersOf(messageId, button = null) {
  const mirror = getQueueMirror();
  const keys = new Set(mirror.filter((e) => HELD_KINDS.has(e.kind) && holdsButton(e, messageId, button)).flatMap(heldKeys));
  return mirror.filter((e) => !HELD_KINDS.has(e.kind) && holdingKeys(e).some((k) => keys.has(k))).map((e) => e.id);
}

document.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const li = event.target?.closest?.("li.chat-message[data-message-id]");
  if (!li) return;
  const banner = event.target.closest(".dst-dstd-res-banner");
  const button = banner ? null : [...li.querySelectorAll(HELD_BUTTONS)].find((b) => {
    const r = b.getBoundingClientRect();
    return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  });
  if (!banner && !button) return;
  event.preventDefault();
  event.stopPropagation();
  const holders = holdersOf(li.dataset.messageId, button);
  if (holders.length) StackWindow.focus(holders);
  else StackWindow.open();
}, { capture: true });

Hooks.on("dst.queueChanged", markStackButton);
Hooks.on("renderSceneControls", markStackButton);

const reanchorStack = () => setTimeout(() => StackWindow._instance?._anchor(), 300);
Hooks.on("collapseSidebar", reanchorStack);
window.addEventListener("resize", reanchorStack);
