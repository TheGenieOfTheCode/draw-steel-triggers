import { MODULE_ID } from "../util.mjs";
import { getQueueMirror, canActOn, resolveQueueEntry, addRollBypass, releaseHeld, applyHeldDamageNow, releaseResolutionNow, watchUseCancellation } from "../triggers/queue.mjs";
import { maliceChipURI } from "./malice-chip.mjs";
import { buildAbilityPreview } from "./ability-preview.mjs";
import { buildRoster } from "./roster.mjs";
import { snoozeFor, setSnooze, clearSnooze, promptSnooze, toggleSnooze } from "./snooze.mjs";
import { runBespokeUse } from "../triggers/bespoke.mjs";

const STACK_WIDTH = 500;
const ROSTER_OPEN_WIDTH = 758;
const DSCT_ID = "draw-steel-combat-tools";

async function useWithTriggerContext(item, entry) {
  const subject = entry.subjectTokenUuid ? fromUuidSync(entry.subjectTokenUuid) : null;
  const token = subject?.object ?? (subject?.documentName === "Token" ? subject : null);
  const previous = [...game.user.targets];
  const borrowed = !!token?.isVisible;

  if (Number.isFinite(entry.triggerDamage)) {
    game.modules.get(DSCT_ID)?.api?.setTriggerDamage?.(entry.triggerDamage);
  }
  if (borrowed) token.setTarget(true, { user: game.user, releaseOthers: true });

  try {
    await item.system.use();
    await runBespokeUse(item, entry);
  } finally {
    if (borrowed) {
      for (const t of game.user.targets) t.setTarget(false, { user: game.user, releaseOthers: false });
      for (const t of previous) t.setTarget(true, { user: game.user, releaseOthers: false });
    }
  }
}

export class StackWindow extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-stack-window",
    classes: ["draw-steel", "dst-stack-window"],
    window: { minimizable: true, resizable: true },
    position: { width: STACK_WIDTH, height: "auto" },
    actions: {
      useEntry: StackWindow.#onUse,
      declineEntry: StackWindow.#onDecline,
      dismissEntry: StackWindow.#onDismiss,
      releaseHeld: StackWindow.#onReleaseHeld,
      releaseResolutionNow: StackWindow.#onReleaseResolutionNow,
      applyHeldNow: StackWindow.#onApplyHeldNow,
      openOwner: StackWindow.#onOpenOwner,
      snoozeTrigger: StackWindow.#onSnoozeTrigger,
      snoozeAll: StackWindow.#onSnoozeAll,
      toggleRosterEmbed: StackWindow.#onToggleRosterEmbed,
      toggleRoster: StackWindow.#onToggleRoster,
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
    if (this._instance?.rendered) this._instance.render();
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
      {
        icon: "fa-solid fa-bell-slash",
        label: "DS_TRIGGERS.Queue.RosterToggle",
        action: "toggleRoster",
      },
    ];
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);
    
    const isHeldKind = (e) => e.kind === "held" || e.kind === "damageHeld" || e.kind === "resolutionHeld";
    const groupKey = (e) => e.resumeId ?? e.damageId ?? e.resolutionId ?? e.promptId ?? null;
    const ordered = [...getQueueMirror()].sort((a, b) => {
      const held = isHeldKind(a) - isHeldKind(b);
      if (held) return held;
      if (groupKey(a) && groupKey(a) === groupKey(b)) return (b.playerSide ? 1 : 0) - (a.playerSide ? 1 : 0);
      return 0;
    });
    const isGated = (e) => !e.playerSide && !isHeldKind(e) && groupKey(e)
      && getQueueMirror().some((q) => !isHeldKind(q) && groupKey(q) === groupKey(e) && q.playerSide && q.state === "pending");
    const embeds = await Promise.all(ordered.map((e) => e.itemUuid
      ? buildAbilityPreview(fromUuidSync(e.itemUuid), { includeMeta: true, includeTrigger: true, includeTriggeredAction: true }).catch(() => "")
      : Promise.resolve("")));
    const roster = buildRoster();
    return {
      isGM: game.user.isGM,
      roster,
      
      
      rosterOpen: (this._rosterOpen ??= !ordered.length),
      maliceChipURI: maliceChipURI(),
      labels: {
        use: L("Use"), decline: L("Decline"), dismiss: L("Dismiss"),
        dismissTooltip: L("DismissTooltip"), empty: L("Empty"),
        release: L("Release"), releaseTooltip: L("ReleaseTooltip"),
        applyNow: L("ApplyNow"), applyNowTooltip: L("ApplyNowTooltip"),
        releaseResolution: L("ReleaseResolution"), releaseResolutionTooltip: L("ReleaseResolutionTooltip"),
        gatedTooltip: L("PlayerPriorityTooltip"),
        showAbility: L("ShowAbility"),
        free: game.i18n.localize("DS_TRIGGERS.Reminder.Free"),
        rosterTitle: L("RosterTitle"),
        rosterEmptyGM: L("RosterEmptyGM"),
        rosterEmptyPlayer: L("RosterEmptyPlayer"),
        snoozeTooltip: L("SnoozeTooltip"),
        snoozeAllTooltip: L("SnoozeAllTooltip"),
        groupMuted: L("GroupMuted"),
      },
      entries: ordered.map((e, i) => {
        const isHeld = e.kind === "held";
        const isDamageHeld = e.kind === "damageHeld";
        const isResolutionHeld = e.kind === "resolutionHeld";
        const embedHTML = embeds[i];
        const embedOpen = this._openEmbeds?.has(e.id) ?? false;
        const pendingCount = isHeld
          ? getQueueMirror().filter((q) => q.resumeId === e.resumeId && q.state === "pending").length
          : isDamageHeld
            ? getQueueMirror().filter((q) => q.damageId === e.damageId && q.state === "pending").length
            : isResolutionHeld
              ? getQueueMirror().filter((q) => q.resolutionId === e.resolutionId && q.state === "pending").length
              : 0;
        const ownerDoc = e.ownerActorUuid ? fromUuidSync(e.ownerActorUuid) : null;
        const item = e.itemUuid ? fromUuidSync(e.itemUuid) : null;
        const sys = item?.system;

        let costBadge = null;
        if (Number.isFinite(sys?.resource) && sys.resource > 0) {
          const malice = ownerDoc?.type !== "hero" && ownerDoc?.type !== "character";
          costBadge = {
            malice,
            label: malice
              ? game.i18n.format("DS_TRIGGERS.Queue.CostMalice", { n: sys.resource })
              : `${sys.resource} ${ownerDoc?.system?.coreResource?.name ?? ""}`.trim(),
          };
        }

        
        return {
          ...e,
          embedHTML,
          embedOpen,
          iconSrc: item?.img ?? null,
          ownerClickable: !!ownerDoc && ownerDoc.testUserPermission(game.user, "LIMITED"),
          isHeld,
          isDamageHeld,
          isResolutionHeld,
          costBadge,
          isFree: sys?.type === "freeTriggered",
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
          gated: isGated(e),
          showButtons: !isHeld && !isDamageHeld && !isResolutionHeld && e.state === "pending" && canActOn(e),
          showRelease: isHeld && game.user.isGM,
          showApplyNow: isDamageHeld && game.user.isGM,
          showReleaseResolution: isResolutionHeld && game.user.isGM,
          isGrace: e.state === "grace",
          graceRemaining: e.graceUntil ? Math.max(0, Math.ceil((e.graceUntil - Date.now()) / 1000)) : null,
          heldStatus: (isHeld || isDamageHeld || isResolutionHeld)
            ? (e.state === "grace" ? null : game.i18n.format("DS_TRIGGERS.Queue.WaitingOn", { count: pendingCount }))
            : null,
          stateLabel: L(`State.${e.state}`),
        };
      }),
    };
  }

  _onRender(_context, _options) {
    
    
    
    const handle = this.element.querySelector(".window-resize-handle");
    if (handle && this._resizeHookedOn !== handle) {
      this._resizeHookedOn = handle;
      handle.addEventListener("pointerdown", () => { this._userSized = true; });
    }
    setTimeout(() => {
      if (!this._userSized) this.setPosition({ height: "auto" });
      this._fitRoster();
    }, 0);
    const count = getQueueMirror().length;
    const titleEl = this.element.querySelector(".window-header .window-title");
    if (titleEl) {
      const text = count
        ? `${this.title} · ${game.i18n.format("DS_TRIGGERS.Queue.InStack", { count })}`
        : this.title;
      titleEl.innerHTML = `<img class="dst-window-emblem" src="modules/${MODULE_ID}/icons/emblem.svg" alt="">${text}`;
    }

    
    
    this.element.querySelector('.header-control[data-action="toggleRoster"]')?.classList.toggle("is-open", !!this._rosterOpen);
    this.setPosition({ width: this._rosterOpen ? ROSTER_OPEN_WIDTH : STACK_WIDTH });
    this._fitRoster();

    this._openEmbeds ??= new Set();
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

  close(options) {
    clearInterval(this._graceTicker);
    clearTimeout(this._drawerTimer);
    return super.close(options);
  }

  static async #onUse(event, target) {
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    if (!entry) return;
    if (target.classList.contains("dst-use-gated") && !(game.user.isGM && event?.shiftKey)) {
      ui.notifications.warn("DS_TRIGGERS.Queue.PlayerPriorityWarn", { localize: true });
      return;
    }
    const item = await fromUuid(entry.itemUuid).catch(() => null);
    resolveQueueEntry(entry.id, "used");
    if (item) {

      addRollBypass(item.uuid);
      watchUseCancellation(item.uuid);
      await useWithTriggerContext(item, entry);
    }
  }

  static #onDecline(_event, target) {
    resolveQueueEntry(target.dataset.id, "declined");
  }

  static #onDismiss(_event, target) {
    resolveQueueEntry(target.dataset.id, "dismissed");
  }

  static #onReleaseHeld(_event, target) {
    releaseHeld(target.dataset.resumeId);
  }

  static #onApplyHeldNow(_event, target) {
    applyHeldDamageNow(target.dataset.damageId);
  }

  static #onReleaseResolutionNow(_event, target) {
    releaseResolutionNow(target.dataset.resolutionId);
  }

  static async #onOpenOwner(_event, target) {
    const doc = await fromUuid(target.dataset.uuid).catch(() => null);
    doc?.sheet?.render(true);
  }

  static async #onSnoozeTrigger(_event, target) {
    const { dsid, actorUuid, name } = target.dataset;
    const actor = actorUuid ? fromUuidSync(actorUuid) : null;
    const existing = snoozeFor(actor, dsid);
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
  }

  _setRosterOpen(open) {
    this._rosterOpen = !!open;
    this.element.querySelector(".dst-shell")?.classList.toggle("roster-open", this._rosterOpen);
    this.element.querySelector(".dst-roster")?.classList.toggle("expanded", this._rosterOpen);
    this.element.querySelector('.header-control[data-action="toggleRoster"]')?.classList.toggle("is-open", this._rosterOpen);
    
    
    this.element.style.transition = "width 0.25s ease";
    this.setPosition({ width: this._rosterOpen ? ROSTER_OPEN_WIDTH : STACK_WIDTH });
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
    if (!host.hidden) {
      host.hidden = true;
      icon?.classList.replace("fa-angle-down", "fa-angle-right");
      return;
    }
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
Hooks.on("dst.queueOpenRequested", () => StackWindow.open());

for (const hook of ["createCombat", "deleteCombat"]) Hooks.on(hook, () => StackWindow.refresh());
Hooks.on("updateCombat", (combat, changed) => { if ("round" in changed || "active" in changed) StackWindow.refresh(); });
Hooks.on("createCombatant", () => StackWindow.refresh());
Hooks.on("deleteCombatant", () => StackWindow.refresh());

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
