// The flame dot: scrire.com's pixel flame burning above a dotless "ı"
// (in "scrıre" and the home heading). Particles rise from a point, drift, and die; drawn on a tiny
// canvas scaled up with crisp pixels. Ported from the site's flame-anim.
document.querySelectorAll('canvas[data-flame]').forEach((canvas) => {
  const mark = canvas?.parentElement;
  if (!mark) return;
  const ctx = canvas.getContext('2d');
  const STEP_MS = 1000 / 12;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const color = () => getComputedStyle(canvas).getPropertyValue('--flame-color').trim() || '#f5f0e8';

  // Sit the canvas so its bottom touches the x-height above the "ı".
  const measure = document.createElement('canvas').getContext('2d');
  function place() {
    const walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT);
    let node, range = null;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf('ı');
      if (i >= 0) { range = document.createRange(); range.setStart(node, i); range.setEnd(node, i + 1); break; }
    }
    if (!range) return;
    const r = range.getBoundingClientRect(), box = mark.getBoundingClientRect();
    const cs = getComputedStyle(mark), size = parseFloat(cs.fontSize) || 16;
    measure.font = `${cs.fontStyle} ${cs.fontWeight} ${size}px ${cs.fontFamily}`;
    const xHeight = measure.measureText('x').actualBoundingBoxAscent || size * 0.5;
    const hg = measure.measureText('Hg');
    const ascent = hg.fontBoundingBoxAscent ?? size * 0.8, descent = hg.fontBoundingBoxDescent ?? size * 0.2;
    const pad = Math.max(0, (r.height - (ascent + descent)) / 2);
    const top = r.top - box.top + pad + ascent - xHeight;
    canvas.style.left = `${r.left + r.width / 2 - box.left - canvas.offsetWidth / 2}px`;
    canvas.style.top = `${top - canvas.offsetHeight}px`;
  }
  place();
  document.fonts?.ready.then(place);
  addEventListener('resize', place, { passive: true });

  // Grid size follows the displayed size; one grid cell per PIXEL screen pixels.
  const PIXEL = 2;
  let w = 11, h = 18, lifeMin = 7, lifeMax = 14, ox = w / 2, oy = h - 3;
  function size() {
    const nw = Math.max(3, Math.round(canvas.offsetWidth / PIXEL)), nh = Math.max(5, Math.round(canvas.offsetHeight / PIXEL));
    if (nw === w && nh === h) return;
    w = canvas.width = nw; h = canvas.height = nh;
    const k = h / 18;
    lifeMin = Math.max(3, Math.round(7 * k)); lifeMax = Math.max(lifeMin + 1, Math.round(14 * k));
    ox = w / 2; oy = h - Math.max(2, Math.round(1.5 * k));
  }
  canvas.width = w; canvas.height = h;
  size();
  new ResizeObserver(size).observe(canvas);

  const parts = [];
  function spawn() {
    const k = w / 11, count = Math.max(1, Math.round(2 * k)), radius = 1.6 * k, c = color();
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, d = Math.random() * radius;
      parts.push({ x: ox + Math.cos(a) * d, y: oy + Math.sin(a) * d, vx: (Math.random() - 0.5) * 0.35,
        vy: -1 + Math.random() * 0.6, life: lifeMin + Math.floor(Math.random() * (lifeMax - lifeMin + 1)), c });
    }
  }
  function step() {
    spawn();
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.vx += (Math.random() - 0.5) * 0.12; p.x += p.vx; p.y += p.vy; p.life--;
      if (p.life <= 0 || p.y < -1 || p.x < -1 || p.x > w + 1) parts.splice(i, 1);
    }
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      const x = Math.floor(p.x), y = Math.floor(p.y);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      ctx.fillStyle = p.c;
      ctx.fillRect(x, y, 1, 1);
    }
  }
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - last < STEP_MS) return;
    last = now;
    step();
  }
  if (reduced) { for (let i = 0; i < 10; i++) step(); } else requestAnimationFrame(frame);
});
