import { MODULE_ID } from "../util.mjs";
import { getQueueMirror, canActOn, resolveQueueEntry, addRollBypass } from "../triggers/queue.mjs";

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
    return {
      isGM: game.user.isGM,
      labels: {
        use: L("Use"), decline: L("Decline"), dismiss: L("Dismiss"),
        dismissTooltip: L("DismissTooltip"), empty: L("Empty"),
      },
      entries: getQueueMirror().map((e) => ({
        ...e,
        isPending: e.state === "pending",
        showButtons: e.state === "pending" && canActOn(e),
        stateLabel: L(`State.${e.state}`),
      })),
    };
  }

  _onRender(_context, _options) {
    setTimeout(() => this.setPosition({ height: "auto" }), 0);
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
}

Hooks.on("dst.queueChanged", () => StackWindow.refresh());
Hooks.on("dst.queueOpenRequested", () => StackWindow.open());
