import { MODULE_ID } from "../util.mjs";
import { StackWindow, sideOf, tokenOfActor } from "./stack-window.mjs";

const POP_MS = 260;
const HOLD_MS = 4200;
const FADE_MS = 700;
const PULSE_MS = 900;
const FALLBACK_COLOUR = 0xd9a63f;
const EMBLEM = `modules/${MODULE_ID}/icons/emblem-coin.png`;

const _badges = new Map();
let _known = null;
let _layer = null;

const enabled = () => game.settings.get(MODULE_ID, "tokenBadges") !== false;
const reducedMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const colourNumber = (css) => {
  try { return css ? Number(foundry.utils.Color.from(css)) : FALLBACK_COLOUR; } catch { return FALLBACK_COLOUR; }
};

function layer() {
  if (_layer && !_layer.destroyed && _layer.parent) return _layer;
  _layer = new PIXI.Container();
  _layer.eventMode = "static";
  _layer.sortableChildren = true;
  _layer.zIndex = 1000;
  canvas.controls.addChild(_layer);
  return _layer;
}

function tokensFor(entry) {
  const uuids = [entry.ownerActorUuid, ...(entry.squad ?? []).map((m) => m.ownerActorUuid)].filter(Boolean);
  const out = new Set();
  for (const uuid of uuids) {
    const token = tokenOfActor(uuid)?.object;
    if (token?.visible && token.document.parent === canvas.scene) out.add(token);
  }
  return [...out];
}

function drawBadge(badge) {
  const { body, ring, count } = badge.parts;
  const r = badge.radius;
  body.clear();
  body.beginFill(0x161412, 0.9).lineStyle(3, badge.colour, 1).drawCircle(0, 0, r).endFill();
  ring.clear();
  ring.lineStyle(3, badge.colour, 1).drawCircle(0, 0, r);
  count.visible = badge.entryIds.length > 1;
  count.removeChildren().forEach((c) => c.destroy());
  if (!count.visible) return;
  const text = new PIXI.Text(String(badge.entryIds.length), { fontFamily: "Signika", fontSize: Math.round(r * 0.75), fontWeight: "bold", fill: 0xffffff });
  text.anchor.set(0.5);
  const pill = new PIXI.Graphics().beginFill(badge.colour, 1).drawCircle(0, 0, r * 0.48).endFill();
  count.addChild(pill, text);
  count.position.set(r * 0.78, r * 0.78);
}

function place(badge) {
  const t = badge.token;
  if (!t || t.destroyed) return false;
  badge.container.position.set(t.x + t.w - badge.radius * 0.35, t.y + badge.radius * 0.35);
  return true;
}

function removeBadge(badge) {
  canvas.app?.ticker.remove(badge.tick);
  _badges.delete(badge.tokenId);
  if (!badge.container.destroyed) badge.container.destroy({ children: true });
}

function showBadge(token, entry, colour) {
  const existing = _badges.get(token.id);
  if (existing) {
    if (!existing.entryIds.includes(entry.id)) existing.entryIds.push(entry.id);
    existing.born = performance.now() - POP_MS;
    drawBadge(existing);
    return;
  }
  const radius = Math.max(12, Math.round(canvas.grid.size * 0.17));
  const container = new PIXI.Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  container.hitArea = new PIXI.Circle(0, 0, radius * 1.15);
  const ring = new PIXI.Graphics();
  const body = new PIXI.Graphics();
  const emblem = PIXI.Sprite.from(EMBLEM);
  emblem.anchor.set(0.5);
  emblem.width = emblem.height = radius * 1.45;
  const count = new PIXI.Container();
  container.addChild(ring, body, emblem, count);
  const badge = { token, tokenId: token.id, container, radius, colour, entryIds: [entry.id], parts: { body, ring, count }, born: performance.now(), hovered: false };
  drawBadge(badge);
  container.on("pointerover", () => { badge.hovered = true; });
  container.on("pointerout", () => { badge.hovered = false; badge.born = performance.now() - POP_MS; });
  container.on("pointerdown", (event) => {
    event.stopPropagation();
    StackWindow.focus(badge.entryIds[0]);
    removeBadge(badge);
  });
  const still = reducedMotion();
  badge.tick = () => {
    if (!place(badge)) return removeBadge(badge);
    const age = performance.now() - badge.born;
    if (badge.hovered) {
      container.alpha = 1;
      container.scale.set(1.08);
      ring.alpha = 0;
      return;
    }
    if (still) container.scale.set(1);
    else if (age < POP_MS) {
      const p = age / POP_MS;
      container.scale.set(p < 0.7 ? (p / 0.7) * 1.18 : 1.18 - ((p - 0.7) / 0.3) * 0.18);
    } else container.scale.set(1);
    const pulse = still ? 1 : (age % PULSE_MS) / PULSE_MS;
    ring.alpha = still || age > HOLD_MS ? 0 : 1 - pulse;
    ring.scale.set(1 + pulse * 0.9);
    const fading = age - POP_MS - HOLD_MS;
    container.alpha = fading > 0 ? Math.max(0, 1 - fading / FADE_MS) : 1;
    if (fading >= FADE_MS) removeBadge(badge);
  };
  layer().addChild(container);
  place(badge);
  container.scale.set(still ? 1 : 0);
  _badges.set(token.id, badge);
  canvas.app.ticker.add(badge.tick);
}

function onQueueChanged(mirror) {
  const entries = mirror ?? [];
  const pending = entries.filter((e) => e.state === "pending");
  if (_known === null) {
    _known = new Set(pending.map((e) => e.id));
    return;
  }
  const fresh = pending.filter((e) => !_known.has(e.id));
  _known = new Set(pending.map((e) => e.id));
  for (const badge of [..._badges.values()]) {
    badge.entryIds = badge.entryIds.filter((id) => _known.has(id));
    if (!badge.entryIds.length) removeBadge(badge);
    else drawBadge(badge);
  }
  if (!fresh.length || !enabled() || !canvas?.ready) return;
  for (const entry of fresh) {
    const side = sideOf(entry);
    if (!side) continue;
    const colour = colourNumber(side.colour);
    for (const token of tokensFor(entry)) showBadge(token, entry, colour);
  }
}

Hooks.on("dst.queueChanged", onQueueChanged);
Hooks.on("canvasTearDown", () => {
  for (const badge of [..._badges.values()]) removeBadge(badge);
  _layer = null;
});
