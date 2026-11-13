// Sfera neurale di J.A.R.V.I.S. (three.js): nucleo di particelle, anelli orbitali e rete di sinapsi.
// Ogni stato (attesa, ascolto, ragionamento, voce) è un insieme di parametri verso cui la scena "scivola" con dolcezza.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

const MOBILE = matchMedia("(max-width: 760px), (pointer: coarse)").matches;
const QUALITY = MOBILE ? { core: 7000, nodes: 90, dust: 500, pixel: 1.5 } : { core: 16000, nodes: 160, dust: 1400, pixel: 2 };

// parametri di ogni stato: energia (deformazione), luce, velocità di rotazione, visibilità della rete, frequenza degli impulsi
const STATES = {
  boot: { energy: 0.02, glow: 0.2, spin: 0.02, net: 0.0, fire: 0, size: 0.5 },
  sleep: { energy: 0.03, glow: 0.45, spin: 0.035, net: 0.15, fire: 0.3, size: 0.6 },
  listen: { energy: 0.05, glow: 0.7, spin: 0.07, net: 0.5, fire: 1.2, size: 0.8 },
  think: { energy: 0.09, glow: 0.85, spin: 0.3, net: 0.9, fire: 9, size: 0.82 },
  speak: { energy: 0.07, glow: 0.8, spin: 0.1, net: 0.65, fire: 2.5, size: 0.82 },
};

const lerp = (a, b, t) => a + (b - a) * t;

// texture rotonda e morbida per i punti e per il bagliore del nucleo (disegnata al volo, niente file)
function softDot(size = 64, falloff = 2.2) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 10; i++) grad.addColorStop(i / 10, `rgba(255,255,255,${Math.pow(1 - i / 10, falloff).toFixed(3)})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// punti distribuiti in modo uniforme su una sfera (spirale di Fibonacci)
function fibonacciPoint(i, n) {
  const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5));
  return new THREE.Vector3(Math.cos(phi) * r, y, Math.sin(phi) * r);
}

export function createScene(canvas, labelLayer) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !MOBILE, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, QUALITY.pixel));
  renderer.setClearColor(0x000000, 1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
  camera.position.set(0, 0, 11);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.9, 0.55, 0.12);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const world = new THREE.Group();
  scene.add(world);
  const dot = softDot();

  // ---- nucleo: guscio di particelle + volume interno, deformati nello shader da un "rumore" che segue la voce
  const n = QUALITY.core;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n), shell = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const onShell = i < n * 0.78;
    const p = onShell ? fibonacciPoint(i, Math.floor(n * 0.78)) : new THREE.Vector3().randomDirection();
    const r = onShell ? 2.3 + (Math.random() - 0.5) * 0.08 : Math.pow(Math.random(), 0.6) * 2.1;
    p.multiplyScalar(r);
    pos.set([p.x, p.y, p.z], i * 3);
    seed[i] = Math.random();
    shell[i] = onShell ? 1 : 0;
  }
  const coreGeo = new THREE.BufferGeometry();
  coreGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  coreGeo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
  coreGeo.setAttribute("shell", new THREE.BufferAttribute(shell, 1));
  const coreMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uGlow: { value: 0 }, uPixel: { value: renderer.getPixelRatio() }, uMap: { value: dot } },
    vertexShader: /* glsl */ `
      attribute float seed; attribute float shell;
      uniform float uTime, uEnergy, uGlow, uPixel;
      varying float vAlpha;
      // onde sovrapposte: economiche ma con un aspetto "organico"
      float wave(vec3 p, float t) {
        return sin(p.x * 1.7 + t * 1.3) * sin(p.y * 2.1 - t * 0.9) * sin(p.z * 1.9 + t * 1.1)
             + 0.5 * sin(p.x * 3.9 - t * 2.2 + p.z * 2.7) * sin(p.y * 3.3 + t * 1.7);
      }
      void main() {
        vec3 p = position;
        float w = wave(normalize(p) * 2.0, uTime);
        p *= 1.0 + w * uEnergy * 0.35 * (0.4 + 0.6 * shell); // deformazione lieve: resta una sfera
        p += normalize(p) * sin(uTime * 3.0 + seed * 40.0) * 0.012;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float twinkle = 0.55 + 0.45 * sin(uTime * (1.5 + seed * 3.0) + seed * 60.0);
        gl_PointSize = (shell > 0.5 ? 1.7 : 1.3) * (1.0 + seed * 0.7) * uPixel * (11.0 / -mv.z);
        vAlpha = uGlow * twinkle * (shell > 0.5 ? 0.55 : 0.22) * (0.6 + 0.4 * (1.0 + w) * 0.5);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; varying float vAlpha;
      void main() { gl_FragColor = vec4(vec3(1.0), texture2D(uMap, gl_PointCoord).a * vAlpha); }`,
  });
  const core = new THREE.Points(coreGeo, coreMat);
  world.add(core);

  // bagliore centrale
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot(128, 3), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.4 }));
  halo.scale.set(3.4, 3.4, 1);
  world.add(halo);

  // ---- anelli orbitali: archi sottili stretti attorno alla sfera, con inclinazioni diverse (crescono con lei)
  const orbit = new THREE.Group();
  world.add(orbit);
  const rings = [];
  for (const [radius, tilt, speed, arc] of [[2.75, [1.3, 0.25], 0.12, 1.2], [2.95, [-0.6, 0.95], -0.08, 0.8], [3.15, [0.35, -1.15], 0.05, 0.5]]) {
    const pts = [];
    for (let a = 0; a <= Math.PI * 2 * arc / 2; a += 0.02) pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false }));
    line.rotation.set(tilt[0], tilt[1], 0);
    line.userData = { speed, base: 0.16 };
    orbit.add(line);
    rings.push(line);
  }

  // ---- rete neurale: nodi sparsi attorno al nucleo, collegati ai vicini; gli impulsi corrono sulle connessioni
  const nodes = [];
  for (let i = 0; i < QUALITY.nodes; i++) {
    const d = new THREE.Vector3().randomDirection();
    d.multiplyScalar(4.4 + Math.random() * 5.2);
    d.y *= 0.62;
    d.z = d.z * 0.55 - 1.5; // la rete sta soprattutto dietro e attorno, mai addosso alla telecamera
    nodes.push(d);
  }
  const edges = [];
  nodes.forEach((a, i) => {
    const near = nodes.map((b, j) => [j, a.distanceToSquared(b)]).filter(([j]) => j !== i).sort((x, y) => x[1] - y[1]).slice(0, 3);
    for (const [j, d2] of near) if (d2 < 9 && !edges.some(([x, y]) => (x === j && y === i))) edges.push([i, j]);
  });
  const edgePos = new Float32Array(edges.length * 6);
  edges.forEach(([i, j], k) => edgePos.set([nodes[i].x, nodes[i].y, nodes[i].z, nodes[j].x, nodes[j].y, nodes[j].z], k * 6));
  const netGeo = new THREE.BufferGeometry();
  netGeo.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
  const netMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const net = new THREE.LineSegments(netGeo, netMat);
  world.add(net);
  const nodeGeo = new THREE.BufferGeometry().setFromPoints(nodes);
  const nodeMat = new THREE.PointsMaterial({ map: dot, size: 0.16, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  world.add(new THREE.Points(nodeGeo, nodeMat));

  // impulsi: punti luminosi che viaggiano lungo una connessione
  const MAX_PULSES = 260;
  const pulsePos = new Float32Array(MAX_PULSES * 3);
  const pulseGeo = new THREE.BufferGeometry();
  pulseGeo.setAttribute("position", new THREE.BufferAttribute(pulsePos, 3));
  const pulseMat = new THREE.PointsMaterial({ map: dot, size: 0.28, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  const pulsePoints = new THREE.Points(pulseGeo, pulseMat);
  world.add(pulsePoints);
  const pulses = [];
  let fired = 0;
  function fire(count = 1) {
    for (let k = 0; k < count && pulses.length < MAX_PULSES && edges.length; k++) {
      const [a, b] = edges[Math.floor(Math.random() * edges.length)];
      pulses.push(Math.random() < 0.5 ? { a, b, t: 0, v: 0.6 + Math.random() * 1.4 } : { a: b, b: a, t: 0, v: 0.6 + Math.random() * 1.4 });
      fired++;
    }
  }

  // ---- polvere di stelle lontana
  const dustPos = new Float32Array(QUALITY.dust * 3);
  for (let i = 0; i < QUALITY.dust; i++) dustPos.set(new THREE.Vector3().randomDirection().multiplyScalar(14 + Math.random() * 40).toArray(), i * 3);
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ map: dot, size: 0.12, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending });
  scene.add(new THREE.Points(dustGeo, dustMat));

  // ---- etichette HTML agganciate ai nodi della rete
  let labels = [];
  function setLabels(items) {
    labelLayer.replaceChildren();
    const used = new Set();
    labels = items.slice(0, 8).map((it, k) => {
      let idx;
      do { idx = Math.floor(Math.random() * nodes.length); } while (used.has(idx) && used.size < nodes.length);
      used.add(idx);
      const el = document.createElement("div");
      el.className = "label";
      el.innerHTML = `<i></i><small></small><span></span>`;
      el.querySelector("small").textContent = it.kind;
      el.querySelector("span").textContent = it.text;
      el.style.transitionDelay = `${0.15 * k}s`;
      labelLayer.appendChild(el);
      return { el, node: idx };
    });
  }

  // ---- stato e animazione
  let mode = "boot", level = 0, mic = 0, kick = 0, flash = 0, flashLabel = -1;
  const cur = { ...STATES.boot }, tmp = new THREE.Vector3();
  let fireAcc = 0;
  function resize() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    bloom.resolution.set(w, h);
    camera.aspect = w / h;
    camera.position.z = w < h ? 15.5 : 11; // in verticale (telefono) la sfera si allontana per entrare tutta
    camera.updateProjectionMatrix();
  }
  addEventListener("resize", resize);
  resize();

  const clock = new THREE.Clock();
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    const target = STATES[mode] || STATES.sleep;
    for (const k in cur) cur[k] = lerp(cur[k], target[k], 1 - Math.pow(0.04, dt));
    kick = Math.max(0, kick - dt * 0.8);
    flash = Math.max(0, flash - dt * 1.5);

    const voice = mode === "speak" ? level : mode === "listen" || mode === "sleep" ? mic * 0.8 : 0;
    coreMat.uniforms.uTime.value = t;
    coreMat.uniforms.uEnergy.value = cur.energy + voice * 0.18 + kick * 0.15;
    coreMat.uniforms.uGlow.value = cur.glow + voice * 0.25 + kick * 0.3;
    const breathe = 1 + Math.sin(t * (mode === "sleep" ? 0.9 : 1.6)) * 0.02;
    const s = cur.size * breathe * (1 + voice * 0.06 + kick * 0.12);
    core.scale.setScalar(s);
    orbit.scale.setScalar(s);
    halo.scale.setScalar(2.6 * s * (1 + voice * 0.3));
    halo.material.opacity = 0.05 + cur.glow * 0.12 + voice * 0.12 + kick * 0.2;
    bloom.strength = 0.35 + cur.glow * 0.35 + voice * 0.3 + kick * 0.5;

    world.rotation.y += dt * cur.spin;
    world.rotation.x = Math.sin(t * 0.15) * 0.12;
    for (const r of rings) {
      r.rotation.z += dt * r.userData.speed * (1 + cur.spin * 6);
      r.material.opacity = (r.userData.base + voice * 0.3) * cur.glow;
    }
    netMat.opacity = cur.net * 0.14 + flash * 0.25;
    nodeMat.opacity = cur.net * 0.55 + flash * 0.3;

    // impulsi: nuovi in base allo stato, quelli esistenti avanzano lungo la loro connessione
    fireAcc += dt * (cur.fire + voice * 6);
    while (fireAcc > 1) { fire(1); fireAcc -= 1; }
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.t += dt * p.v;
      if (p.t >= 1) {
        // a volte l'impulso prosegue su una connessione vicina: sembra un segnale che attraversa la rete
        const next = Math.random() < 0.45 ? edges.filter(([a]) => a === p.b) : [];
        if (next.length) { const e = next[Math.floor(Math.random() * next.length)]; Object.assign(p, { a: e[0], b: e[1], t: 0 }); fired++; }
        else pulses.splice(i, 1);
      }
    }
    pulses.forEach((p, i) => pulsePos.set(tmp.lerpVectors(nodes[p.a], nodes[p.b], p.t).toArray(), i * 3));
    pulseGeo.setDrawRange(0, pulses.length);
    pulseGeo.attributes.position.needsUpdate = true;
    pulseMat.opacity = 0.5 + cur.net * 0.5;

    // etichette: proiezione 3D → schermo, visibili solo quando il nodo è davanti
    const w = canvas.clientWidth, h = canvas.clientHeight;
    labels.forEach((l, k) => {
      tmp.copy(nodes[l.node]).applyMatrix4(world.matrixWorld);
      const front = tmp.z > -1.5;
      tmp.project(camera);
      const x = (tmp.x * 0.5 + 0.5) * w, y = (-tmp.y * 0.5 + 0.5) * h;
      const inside = x > 40 && x < w - 220 && y > 90 && y < h - 120;
      l.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      l.el.classList.toggle("left", x > w * 0.5); // a destra del centro il testo va verso sinistra
      l.el.classList.toggle("on", front && inside && cur.net > 0.3);
      l.el.classList.toggle("hot", k === flashLabel && flash > 0.05);
    });

    composer.render(dt);
  }
  frame();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) cancelAnimationFrame(raf);
    else { clock.getDelta(); frame(); }
  });

  return {
    setMode(m) { mode = STATES[m] ? m : "sleep"; },
    setLevel(v) { level = lerp(level, Math.min(1, v), 0.5); },
    setMic(v) { mic = lerp(mic, Math.min(1, v), 0.35); },
    wake() { kick = 1; fire(40); },
    burstSynapses(count = 20) { fire(count); },
    highlight(i) { flash = 1; flashLabel = Number.isInteger(i) ? i : Math.floor(Math.random() * Math.max(1, labels.length)); fire(25); },
    setLabels,
    get synapses() { return fired; },
  };
}
