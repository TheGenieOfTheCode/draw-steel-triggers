import { MODULE_ID } from "../util.mjs";
import { getQueueMirror, canActOn, resolveQueueEntry, addRollBypass, releaseHeld } from "../triggers/queue.mjs";
import { maliceChipURI } from "./malice-chip.mjs";

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
      maliceChipURI: maliceChipURI(),
      labels: {
        use: L("Use"), decline: L("Decline"), dismiss: L("Dismiss"),
        dismissTooltip: L("DismissTooltip"), empty: L("Empty"),
        release: L("Release"), releaseTooltip: L("ReleaseTooltip"),
        showAbility: L("ShowAbility"),
        free: game.i18n.localize("DS_TRIGGERS.Reminder.Free"),
      },
      entries: ordered.map((e, i) => {
        const isHeld = e.kind === "held";
        const embedHTML = embeds[i];
        const embedOpen = this._openEmbeds?.has(e.id) ?? false;
        const pendingCount = isHeld
          ? getQueueMirror().filter((q) => q.resumeId === e.resumeId && q.state === "pending").length
          : 0;
        const ownerDoc = fromUuidSync(e.ownerActorUuid);
        const item = fromUuidSync(e.itemUuid);
        const sys = item?.system;

        const typeParts = [];
        const typeLabel = sys?.type ? ds.CONFIG.abilities.types[sys.type]?.label : null;
        if (typeLabel) typeParts.push(game.i18n.localize(typeLabel));
        const keywords = [...(sys?.keywords ?? [])]
          .map((k) => {
            const kw = ds.CONFIG.abilities.keywords?.[k]?.label;
            return kw ? game.i18n.localize(kw) : k.charAt(0).toUpperCase() + k.slice(1);
          });
        if (keywords.length) typeParts.push(keywords.join(", "));

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

        
        let labels = null;
        try { labels = sys?.formattedLabels ?? null; } catch { labels = null; }
        let distance = null;
        if (sys?.distance?.type && labels?.distance) {
          const distIcons = { melee: "fa-sword", ranged: "fa-bow-arrow", meleeRanged: "fa-swords", self: "fa-user" };
          distance = { icon: distIcons[sys.distance.type] ?? "fa-ruler-combined", label: labels.distance };
        }
        const target = labels?.target && sys?.target?.type !== "self"
          ? { label: game.i18n.localize(labels.target) }
          : null;

        return {
          ...e,
          embedHTML,
          embedOpen,
          ownerClickable: !!ownerDoc && ownerDoc.testUserPermission(game.user, "LIMITED"),
          isHeld,
          typeLine: typeParts.join(" · "),
          costBadge,
          isFree: sys?.type === "freeTriggered",
          distance,
          target,
          heldEyebrow: isHeld ? game.i18n.format("DS_TRIGGERS.Queue.HeldBy", { name: e.ownerName }) : null,
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
    const count = getQueueMirror().length;
    const titleEl = this.element.querySelector(".window-header .window-title");
    if (titleEl) {
      titleEl.textContent = count
        ? `${this.title} · ${game.i18n.format("DS_TRIGGERS.Queue.InStack", { count })}`
        : this.title;
    }
    
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
        span.textContent = game.i18n.format("DS_TRIGGERS.Queue.GraceCountdown", { seconds: remaining });
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
