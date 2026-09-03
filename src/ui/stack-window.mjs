import { MODULE_ID } from "../util.mjs";
import { getQueueMirror, canActOn, resolveQueueEntry, addRollBypass, releaseHeld } from "../triggers/queue.mjs";

export class StackWindow extends ds.applications.api.DSApplication {
  static DEFAULT_OPTIONS = {
    id: "dst-stack-window",
    classes: ["draw-steel", "dst-stack-window"],
    window: { minimizable: true, resizable: true },
    position: { width: 380, height: "auto" },
    actions: {
      useEntry: StackWindow.#onUse,
      declineEntry: StackWindow.#onDecline,
      dismissEntry: StackWindow.#onDismiss,
      releaseHeld: StackWindow.#onReleaseHeld,
      openOwner: StackWindow.#onOpenOwner,
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

  get title() {
    return game.i18n.localize("DS_TRIGGERS.Queue.Title");
  }

  async _prepareContext(_options) {
    const L = (k) => game.i18n.localize(`DS_TRIGGERS.Queue.${k}`);
    
    const ordered = [...getQueueMirror()].sort((a, b) => (a.kind === "held") - (b.kind === "held"));
    const TE = foundry.applications?.ux?.TextEditor?.implementation ?? TextEditor;
    const embeds = await Promise.all(ordered.map((e) =>
      TE.enrichHTML(`@Embed[${e.itemUuid} caption=false]`).catch(() => "")));
    return {
      isGM: game.user.isGM,
      labels: {
        use: L("Use"), decline: L("Decline"), dismiss: L("Dismiss"),
        dismissTooltip: L("DismissTooltip"), empty: L("Empty"),
        release: L("Release"), releaseTooltip: L("ReleaseTooltip"),
        showAbility: L("ShowAbility"),
      },
      entries: ordered.map((e, i) => {
        const isHeld = e.kind === "held";
        const embedHTML = embeds[i];
        const embedOpen = this._openEmbeds?.has(e.id) ?? false;
        const pendingCount = isHeld
          ? getQueueMirror().filter((q) => q.resumeId === e.resumeId && q.state === "pending").length
          : 0;
        const ownerDoc = fromUuidSync(e.ownerActorUuid);
        return {
          ...e,
          embedHTML,
          embedOpen,
          ownerClickable: !!ownerDoc && ownerDoc.testUserPermission(game.user, "LIMITED"),
          isHeld,
          isPending: e.state === "pending",
          showButtons: !isHeld && e.state === "pending" && canActOn(e),
          showRelease: isHeld && game.user.isGM,
          isGrace: e.state === "grace",
          graceRemaining: e.graceUntil ? Math.max(0, Math.ceil((e.graceUntil - Date.now()) / 1000)) : null,
          heldStatus: isHeld
            ? (e.state === "grace" ? null : game.i18n.format("DS_TRIGGERS.Queue.WaitingOn", { count: pendingCount }))
            : null,
          stateLabel: L(`State.${e.state}`),
        };
      }),
    };
  }

  _onRender(_context, _options) {
    setTimeout(() => this.setPosition({ height: "auto" }), 0);
    
    this._openEmbeds ??= new Set();
    for (const details of this.element.querySelectorAll(".dst-stack-embed")) {
      details.addEventListener("toggle", () => {
        if (details.open) this._openEmbeds.add(details.dataset.entryId);
        else this._openEmbeds.delete(details.dataset.entryId);
        this.setPosition({ height: "auto" });
      });
    }
    clearInterval(this._graceTicker);
    if (this.element.querySelector("[data-grace-until]")) {
      this._graceTicker = setInterval(() => {
        for (const span of this.element.querySelectorAll("[data-grace-until]")) {
          const remaining = Math.max(0, Math.ceil((Number(span.dataset.graceUntil) - Date.now()) / 1000));
          span.textContent = game.i18n.format("DS_TRIGGERS.Queue.GraceCountdown", { seconds: remaining });
        }
      }, 500);
    }
  }

  close(options) {
    clearInterval(this._graceTicker);
    return super.close(options);
  }

  static async #onUse(_event, target) {
    const entry = getQueueMirror().find((e) => e.id === target.dataset.id);
    if (!entry) return;
    const item = await fromUuid(entry.itemUuid).catch(() => null);
    resolveQueueEntry(entry.id, "used");
    if (item) {
      
      addRollBypass(item.uuid);
      item.system.use();
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

  static async #onOpenOwner(_event, target) {
    const doc = await fromUuid(target.dataset.uuid).catch(() => null);
    doc?.sheet?.render(true);
  }
}

Hooks.on("dst.queueChanged", () => StackWindow.refresh());
Hooks.on("dst.queueOpenRequested", () => StackWindow.open());
