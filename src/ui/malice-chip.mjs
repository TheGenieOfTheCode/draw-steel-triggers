

let _cachedURI = null;

export function maliceChipURI() {
  if (_cachedURI) return _cachedURI;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  _drawMaliceChip(canvas.getContext("2d"), size / 2, size / 2, size / 2 - 2);
  _cachedURI = canvas.toDataURL("image/png");
  return _cachedURI;
}

function _drawMaliceChip(ctx, x, y, r) {
  const Fr = r * 0.76;

  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = "#1a0202"; ctx.fill();

  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 0.87, y + Math.sin(a) * r * 0.87, r * 0.07, 0, Math.PI * 2);
    ctx.fillStyle = "#0c0101"; ctx.fill();
  }

  ctx.fillStyle = "#7a0808";

  ctx.beginPath();
  ctx.moveTo(x - Fr * 0.28, y - Fr * 0.96);
  ctx.bezierCurveTo(
    x - Fr * 0.40, y - Fr * 1.18,
    x - Fr * 0.70, y - Fr * 1.22,
    x - Fr * 0.90, y - Fr * 1.10
  );
  ctx.bezierCurveTo(
    x - Fr * 0.90, y - Fr * 0.85,
    x - Fr * 0.68, y - Fr * 0.70,
    x - Fr * 0.54, y - Fr * 0.83
  );
  ctx.closePath(); ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x + Fr * 0.28, y - Fr * 0.96);
  ctx.bezierCurveTo(
    x + Fr * 0.40, y - Fr * 1.18,
    x + Fr * 0.70, y - Fr * 1.22,
    x + Fr * 0.90, y - Fr * 1.10
  );
  ctx.bezierCurveTo(
    x + Fr * 0.90, y - Fr * 0.85,
    x + Fr * 0.68, y - Fr * 0.70,
    x + Fr * 0.54, y - Fr * 0.83
  );
  ctx.closePath(); ctx.fill();

  ctx.beginPath(); ctx.arc(x, y, Fr, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x - Fr * 0.18, y - Fr * 0.28, 0, x, y, Fr);
  g.addColorStop(0.00, "#de2828");
  g.addColorStop(0.38, "#b01414");
  g.addColorStop(0.72, "#7a0c0c");
  g.addColorStop(1.00, "#480606");
  ctx.fillStyle = g; ctx.fill();

  ctx.save();
  ctx.beginPath(); ctx.arc(x, y, Fr, 0, Math.PI * 2); ctx.clip();
  const sh = ctx.createRadialGradient(x - Fr * 0.14, y - Fr * 0.48, 0, x - Fr * 0.14, y - Fr * 0.48, Fr * 0.62);
  sh.addColorStop(0.00, "rgba(255,180,180,0.52)");
  sh.addColorStop(0.45, "rgba(255,100,100,0.16)");
  sh.addColorStop(1.00, "rgba(255,0,0,0)");
  ctx.fillStyle = sh; ctx.fillRect(x - Fr, y - Fr, Fr * 2, Fr * 0.74);
  ctx.restore();

  ctx.save();
  ctx.lineCap = "round"; ctx.strokeStyle = "#080101"; ctx.lineWidth = Fr * 0.155;
  ctx.beginPath();
  ctx.moveTo(x - Fr * 0.56, y - Fr * 0.38);
  ctx.quadraticCurveTo(x - Fr * 0.36, y - Fr * 0.26, x - Fr * 0.14, y - Fr * 0.16);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + Fr * 0.14, y - Fr * 0.16);
  ctx.quadraticCurveTo(x + Fr * 0.36, y - Fr * 0.26, x + Fr * 0.56, y - Fr * 0.38);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#080101";
  ctx.beginPath(); ctx.ellipse(x - Fr * 0.32, y - Fr * 0.06, Fr * 0.17, Fr * 0.12, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + Fr * 0.32, y - Fr * 0.06, Fr * 0.17, Fr * 0.12, 0, 0, Math.PI * 2); ctx.fill();

  ctx.beginPath();
  ctx.moveTo(x - Fr * 0.42, y + Fr * 0.28);
  ctx.quadraticCurveTo(x, y + Fr * 0.52, x + Fr * 0.42, y + Fr * 0.28);
  ctx.strokeStyle = "#080101"; ctx.lineWidth = Fr * 0.135; ctx.lineCap = "round"; ctx.stroke();
}
