// The smoke behind every page: scrire.com's WarpCanvas, a domain-warped fbm
// shader coloured with the scrire palette. Rendered at reduced resolution and
// 30 fps, paused while the window or the canvas is hidden, one still frame for
// reduced motion. Used for the page background and inside the Install button.
// zoom < 1 shows less of the field, so a small canvas looks like a crop of the page smoke.
// t0 starts the drift at that many seconds in (the icon picks its moment this way).
function startWarp(canvas, RES, zoom = 1, t0 = 0) {
  const gl = canvas && canvas.getContext('webgl', { antialias: false });
  if (!gl) return;
  const FRAME_MS = 1000 / 30;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const vert = 'attribute vec2 a_position; void main() { gl_Position = vec4(a_position, 0.0, 1.0); }';
  const frag = `
precision mediump float;
uniform vec2 u_resolution;
uniform vec3 u_color_1, u_color_2, u_color_3, u_color_4;
uniform float u_warp_a, u_warp_b, u_gain, u_lacunarity, u_scale;
uniform vec2 u_q_offset, u_r_offset, u_pan;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 grad(vec2 p) { float h = hash(p) * 6.28318530718; return vec2(cos(h), sin(h)); }
float noise(vec2 p) {
  vec2 i = floor(p), f = p - i;
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n00 = dot(grad(i), f);
  float n10 = dot(grad(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float n01 = dot(grad(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float n11 = dot(grad(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y) * 0.5 + 0.5;
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5, fr = 1.0;
  for (int i = 0; i < 4; i++) { v += a * noise(p * fr); a *= u_gain; fr *= u_lacunarity; }
  return v;
}
float pattern(vec2 p) {
  vec2 q = vec2(fbm(p), fbm(p + u_q_offset));
  vec2 r = vec2(fbm(p + u_warp_a * q + vec2(1.7, 9.2)), fbm(p + u_warp_a * q + u_r_offset));
  return fbm(p + u_warp_b * r);
}
vec3 palette4(float t) {
  vec3 c = mix(u_color_1, u_color_2, smoothstep(0.40, 0.70, t));
  c = mix(c, u_color_3, smoothstep(0.70, 0.80, t));
  return mix(c, u_color_4, smoothstep(0.80, 1.10, t));
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  uv.x *= u_resolution.x / u_resolution.y;
  float f = clamp((pattern(uv * u_scale + u_pan) - 0.30) / 0.40, 0.0, 1.0);
  gl_FragColor = vec4(palette4(f), 1.0);
}`;

  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error('warp shader:', gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const vs = shader(gl.VERTEX_SHADER, vert), fs = shader(gl.FRAGMENT_SHADER, frag);
  if (!vs || !fs) return;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('warp link:', gl.getProgramInfoLog(prog)); return; }
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const pos = gl.getAttribLocation(prog, 'a_position');
  gl.enableVertexAttribArray(pos);
  gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);

  // scrire.com's colours: ink, dark purple, pink, yellow.
  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  gl.uniform3fv(U('u_color_1'), rgb('#181a25'));
  gl.uniform3fv(U('u_color_2'), rgb('#501945'));
  gl.uniform3fv(U('u_color_3'), rgb('#c80e58'));
  gl.uniform3fv(U('u_color_4'), rgb('#edda4b'));

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr * RES)), h = Math.max(1, Math.floor(canvas.clientHeight * dpr * RES));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
  }
  resize();
  new ResizeObserver(resize).observe(canvas);

  // Every knob drifts on its own slow sine, as on the site.
  const TAU = Math.PI * 2;
  const between = (t, period, lo, hi) => (lo + hi) / 2 + (hi - lo) / 2 * Math.sin(t / period * TAU);
  const wave = (t, period) => Math.sin(t / period * TAU);
  function draw(t) {
    gl.uniform2f(U('u_resolution'), canvas.width, canvas.height);
    gl.uniform1f(U('u_warp_a'), between(t, 30, 2.4, 6));
    gl.uniform1f(U('u_warp_b'), between(t, 100, 2.4, 6));
    gl.uniform1f(U('u_gain'), between(t, 100, 0.52, 0.56));
    gl.uniform1f(U('u_lacunarity'), between(t, 160, 2.01, 2.04));
    gl.uniform1f(U('u_scale'), between(t, 160000, 2.4, 3.6) * zoom);
    gl.uniform2f(U('u_q_offset'), 5.2 + 0.8 * wave(t, 120), 1.3 + 0.8 * wave(t, 240));
    gl.uniform2f(U('u_r_offset'), 8.3 + 0.8 * wave(t, 76), 2.8 + 0.8 * wave(t, 116));
    gl.uniform2f(U('u_pan'), t * 0.075, t * 0.055);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  const start = performance.now();
  let last = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || !canvas.offsetParent || now - last < FRAME_MS) return;
    last = now;
    resize();
    draw((now - start) / 1000 + t0);
  }
  if (reduced) draw(t0); else requestAnimationFrame(frame);
}
startWarp(document.getElementById('warp'), 0.6);
document.querySelectorAll('canvas.warp-btn').forEach((c) => startWarp(c, 1, 0.12));
document.querySelectorAll('canvas[data-warp]').forEach((c) => startWarp(c, 0.6));
