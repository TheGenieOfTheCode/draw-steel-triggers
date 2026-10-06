

const BAR = [[11.32, 4.17], [14.68, 4.17], [15.69, 5.18], [14.21, 14.27], [11.79, 14.27], [10.31, 5.18]];
const DOT = [[13.00, 15.95], [15.29, 18.31], [13.00, 20.66], [10.71, 18.31]];

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const mix = (a, b, t) => `rgb(${hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t)).join(",")})`;
const faceFrom = (base) => [mix(base, "#ffffff", 0.55), mix(base, "#ffffff", 0.15), mix(base, "#000000", 0.3), mix(base, "#000000", 0.62)];

const IRON = ["#c9d2dc", "#7f8b99", "#454e5a", "#1f252d"];
const FACES = {
  iron: IRON,
  full: faceFrom("#3d7a3d"),
  partial: faceFrom("#a87f16"),
  none: IRON,
  manual: faceFrom("#3f6db0"),
  unknown: faceFrom("#8a4fa8"),
};

export const COIN_STATES = Object.freeze(Object.keys(FACES));

function sheen(ctx, x, y, Fr) {
  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, Fr, 0, Math.PI * 2); ctx.clip();
  const sh = ctx.createRadialGradient(x, y - Fr * 0.48, 0, x, y - Fr * 0.48, Fr * 0.62);
  sh.addColorStop(0, "rgba(240,240,250,0.45)"); sh.addColorStop(0.45, "rgba(240,240,250,0.14)"); sh.addColorStop(1, "rgba(240,240,250,0)");
  ctx.fillStyle = sh; ctx.fillRect(x - Fr, y - Fr, Fr * 2, Fr * 0.74);
  ctx.restore();
}

function sword(F, path) {
  const b = F * 0.085;
  path.moveTo(0, -F * 0.98);
  path.lineTo(b, -F * 0.80);
  path.lineTo(b, F * 0.18);
  path.lineTo(-b, F * 0.18);
  path.lineTo(-b, -F * 0.80);
  path.closePath();
  path.rect(-F * 0.30, F * 0.18, F * 0.60, F * 0.12);
  path.rect(-F * 0.065, F * 0.30, F * 0.13, F * 0.30);
  path.moveTo(F * 0.11, F * 0.68);
  path.arc(0, F * 0.68, F * 0.11, 0, Math.PI * 2);
}

function swords(ctx, x, y, F) {
  for (const turn of [-1, 1]) {
    const p = new Path2D();
    sword(F, p);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(turn * Math.PI / 4);
    ctx.lineJoin = "round";
    ctx.lineWidth = F * 0.09; ctx.strokeStyle = "#141820"; ctx.stroke(p);
    ctx.fillStyle = "#eef0f4"; ctx.fill(p);
    ctx.restore();
  }
}

function mark(ctx, x, y, h) {
  const k = h / (20.66 - 4.17);
  ctx.save();
  ctx.translate(x, y); ctx.scale(k, k); ctx.translate(-13, -(4.17 + 20.66) / 2);
  const p = new Path2D();
  for (const poly of [BAR, DOT]) { p.moveTo(...poly[0]); for (const pt of poly.slice(1)) p.lineTo(...pt); p.closePath(); }
  ctx.lineJoin = "miter"; ctx.lineWidth = 1.9; ctx.strokeStyle = "#14060a"; ctx.stroke(p);
  ctx.fillStyle = "#e01f1f"; ctx.fill(p);
  ctx.restore();
}

export function drawEmblemCoin(ctx, state, x, y, r) {
  const face = FACES[state] ?? IRON;
  ctx.fillStyle = "#d9a63f"; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#0b0d10"; ctx.beginPath(); ctx.arc(x, y, r * 0.86, 0, Math.PI * 2); ctx.fill();
  const Fr = r * 0.74;
  ctx.beginPath(); ctx.arc(x, y, Fr, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x, y - Fr * 0.28, 0, x, y, Fr);
  g.addColorStop(0, face[0]); g.addColorStop(0.38, face[1]); g.addColorStop(0.72, face[2]); g.addColorStop(1, face[3]);
  ctx.fillStyle = g; ctx.fill();
  sheen(ctx, x, y, Fr);
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, Fr, 0, Math.PI * 2); ctx.clip();
  swords(ctx, x, y, Fr * 0.98);
  ctx.restore();
  mark(ctx, x, y + Fr * 0.02, Fr * 1.5);
}

const _uris = new Map();

export function emblemCoinURI(state = "iron", size = 64) {
  const id = `${state}:${size}`;
  if (_uris.has(id)) return _uris.get(id);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  drawEmblemCoin(canvas.getContext("2d"), state, size / 2, size / 2, (size / 2) * 0.96);
  const uri = canvas.toDataURL("image/png");
  _uris.set(id, uri);
  return uri;
}

export function emblemCoinHTML(state = "iron", { className = "" } = {}) {
  const key = COIN_STATES.includes(state) ? state : "iron";
  return `<img class="dst-coin dst-coin--${key} ${className}" src="${emblemCoinURI(key)}" alt="">`;
}
