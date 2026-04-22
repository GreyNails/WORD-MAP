import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

let wordData = [];
let scene, camera, renderer, controls;
let pointCloud, pointPositions, pointColors, pointSizes;
let raycaster, mouse;
let hoveredIndex = -1;
let selectedIndex = -1;
let baseColors, baseSizes;
let connectionLines = null;
let highlightedSet = new Set();
let isLocked = false;
let currentMode = 'semantic'; // 'semantic' or 'spelling'
let traverseList = []; // sorted array of highlighted indices (excluding selected)
let traverseIndex = -1; // current position in traverseList
let traversePrevColor = null; // to restore color when moving away

const posColors = {
  n:     [0.00, 0.82, 1.00],
  v:     [0.48, 0.36, 1.00],
  adj:   [1.00, 0.43, 0.78],
  adv:   [0.30, 1.00, 0.65],
  prep:  [1.00, 0.78, 0.20],
  conj:  [0.40, 0.85, 1.00],
  pron:  [1.00, 0.55, 0.35],
  num:   [0.70, 1.00, 0.40],
  int:   [0.90, 0.50, 1.00],
  art:   [0.80, 0.80, 0.80],
  other: [0.50, 0.50, 0.60],
};
const posLabels = {
  n: 'Noun', v: 'Verb', adj: 'Adjective', adv: 'Adverb',
  prep: 'Preposition', conj: 'Conjunction', pron: 'Pronoun',
  num: 'Numeral', int: 'Interjection', art: 'Article', other: 'Other',
};

async function loadData() {
  const resp = await fetch('words_3d.json');
  wordData = await resp.json();
  document.getElementById('load-progress').textContent = `Loaded ${wordData.length} words. Building scene...`;
}

function getCoords(d) {
  if (currentMode === 'spelling') return [d.sx, d.sy, d.sz];
  return [d.x, d.y, d.z];
}

function init() {
  const canvas = document.getElementById('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a1a);
  scene.fog = new THREE.FogExp2(0x0a0a1a, 0.003);

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 0, 100);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1.2;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.3;

  raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 1.2;
  mouse = new THREE.Vector2();

  buildPointCloud();
  addAmbientParticles();
  buildLegend();

  window.addEventListener('resize', onResize);
  canvas.addEventListener('pointermove', onMouseMove);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('mousedown', () => { controls.autoRotate = false; });

  // Search toggle
  const searchToggle = document.getElementById('search-toggle');
  const searchBox = document.getElementById('search-box');
  searchToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = searchBox.classList.toggle('hidden');
    searchToggle.classList.toggle('active', !searchBox.classList.contains('hidden'));
    if (!searchBox.classList.contains('hidden')) {
      document.getElementById('search-input').focus();
    }
  });

  // Search
  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', onSearch);
  searchInput.addEventListener('focus', () => { if (searchInput.value) onSearch(); });
  document.addEventListener('click', (e) => {
    if (!searchBox.contains(e.target) && e.target !== searchToggle) {
      document.getElementById('search-results').style.display = 'none';
    }
  });

  // UI collapse toggle
  document.getElementById('ui-toggle').addEventListener('click', () => {
    const layer = document.getElementById('ui-layer');
    const btn = document.getElementById('ui-toggle');
    layer.classList.toggle('hidden');
    btn.classList.toggle('collapsed', layer.classList.contains('hidden'));
  });

  // Legend toggle
  document.getElementById('legend-toggle').addEventListener('click', () => {
    const legend = document.getElementById('legend');
    const btn = document.getElementById('legend-toggle');
    legend.classList.toggle('hidden');
    btn.classList.toggle('active', !legend.classList.contains('hidden'));
  });

  // UI scale slider — set CSS variable on :root, each panel scales independently
  const uiScaleSlider = document.getElementById('ui-scale');
  const uiScaleVal = document.getElementById('ui-scale-val');
  uiScaleSlider.addEventListener('input', () => {
    const s = parseInt(uiScaleSlider.value) / 100;
    uiScaleVal.textContent = uiScaleSlider.value + '%';
    document.documentElement.style.setProperty('--ui-s', s);
  });

  // Similarity scale slider
  const slider = document.getElementById('sim-scale');
  const sliderVal = document.getElementById('sim-scale-val');
  slider.addEventListener('input', () => {
    sliderVal.textContent = slider.value;
    if (selectedIndex >= 0) highlightNeighbors(selectedIndex);
  });

  // IS Connect toggle
  document.getElementById('is-connect').addEventListener('change', () => {
    if (selectedIndex >= 0) highlightNeighbors(selectedIndex);
    else removeConnections();
  });

  // Lock button
  document.getElementById('lock-btn').addEventListener('click', () => {
    isLocked = !isLocked;
    const btn = document.getElementById('lock-btn');
    btn.classList.toggle('active', isLocked);
    btn.querySelector('.icon').textContent = isLocked ? '\u{1F512}' : '\u{1F513}';
    btn.querySelector('.label').textContent = isLocked ? 'Locked' : 'Lock Selection';
  });

  // Traverse buttons
  document.getElementById('traverse-prev').addEventListener('click', () => traverseStep(-1));
  document.getElementById('traverse-next').addEventListener('click', () => traverseStep(1));

  // Mode switcher
  document.querySelectorAll('#mode-switcher button').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === currentMode) return;
      currentMode = mode;
      document.querySelectorAll('#mode-switcher button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switchMode();
    });
  });

  setTimeout(() => { document.getElementById('loading').classList.add('hidden'); }, 500);
}

function buildPointCloud() {
  const n = wordData.length;
  const geometry = new THREE.BufferGeometry();
  pointPositions = new Float32Array(n * 3);
  pointColors = new Float32Array(n * 3);
  pointSizes = new Float32Array(n);
  baseColors = new Float32Array(n * 3);
  baseSizes = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const d = wordData[i];
    const [px, py, pz] = getCoords(d);
    pointPositions[i * 3] = px;
    pointPositions[i * 3 + 1] = py;
    pointPositions[i * 3 + 2] = pz;

    const c = posColors[d.p] || posColors.other;
    const v = 0.85 + Math.random() * 0.15;
    baseColors[i * 3] = c[0] * v;
    baseColors[i * 3 + 1] = c[1] * v;
    baseColors[i * 3 + 2] = c[2] * v;
    pointColors[i * 3] = baseColors[i * 3];
    pointColors[i * 3 + 1] = baseColors[i * 3 + 1];
    pointColors[i * 3 + 2] = baseColors[i * 3 + 2];

    baseSizes[i] = 1.0;
    pointSizes[i] = 1.0;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(pointPositions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(pointColors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(pointSizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uPixelRatio: { value: renderer.getPixelRatio() } },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      uniform float uPixelRatio;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio * (120.0 / -mvPosition.z);
        gl_PointSize = clamp(gl_PointSize, 1.5, 30.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float alpha = 1.0 - smoothstep(0.3, 0.5, d);
        float glow = exp(-d * 4.0) * 0.5;
        gl_FragColor = vec4(vColor + glow, alpha * 0.9);
      }
    `,
    transparent: true,
    vertexColors: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  pointCloud = new THREE.Points(geometry, material);
  scene.add(pointCloud);
}

function addAmbientParticles() {
  const n = 2000;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 200;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 200;
    pos[i * 3 + 2] = (Math.random() - 0.5) * 200;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.15, color: 0x333366,
    transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  scene.add(new THREE.Points(geo, mat));
}

function buildLegend() {
  const el = document.getElementById('legend');
  let html = '<h4>Parts of Speech</h4>';
  for (const [pos, label] of Object.entries(posLabels)) {
    const c = posColors[pos];
    const hex = '#' + c.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    html += `<span class="legend-item"><span class="legend-dot" style="background:${hex}"></span>${label}</span>`;
  }
  el.innerHTML = html;
}

function switchMode() {
  // Reset selection
  resetHighlight();
  selectedIndex = -1;
  hoveredIndex = -1;
  highlightedSet.clear();
  removeConnections();
  document.getElementById('tooltip').style.display = 'none';

  // Update positions
  const n = wordData.length;
  for (let i = 0; i < n; i++) {
    const [px, py, pz] = getCoords(wordData[i]);
    pointPositions[i * 3] = px;
    pointPositions[i * 3 + 1] = py;
    pointPositions[i * 3 + 2] = pz;
  }
  pointCloud.geometry.attributes.position.needsUpdate = true;

  // Reset camera
  camera.position.set(0, 0, 100);
  controls.target.set(0, 0, 0);
  controls.update();
  controls.autoRotate = true;
}

function highlightNeighbors(idx) {
  const simScale = parseFloat(document.getElementById('sim-scale').value);
  const isConnect = document.getElementById('is-connect').checked;
  const n = wordData.length;
  const d = wordData[idx];
  const [cx, cy, cz] = getCoords(d);

  highlightedSet.clear();
  highlightedSet.add(idx);

  const neighbors = [];

  for (let i = 0; i < n; i++) {
    const [px, py, pz] = getCoords(wordData[i]);
    const dx = px - cx, dy = py - cy, dz = pz - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    if (i === idx) {
      pointColors[i * 3] = 1; pointColors[i * 3 + 1] = 1; pointColors[i * 3 + 2] = 1;
      pointSizes[i] = 3.0;
    } else if (dist <= simScale) {
      highlightedSet.add(i);
      neighbors.push(i);
      const c = posColors[wordData[i].p] || posColors.other;
      pointColors[i * 3] = c[0];
      pointColors[i * 3 + 1] = c[1];
      pointColors[i * 3 + 2] = c[2];
      pointSizes[i] = 1.8;
    } else {
      pointColors[i * 3] = baseColors[i * 3] * 0.15;
      pointColors[i * 3 + 1] = baseColors[i * 3 + 1] * 0.15;
      pointColors[i * 3 + 2] = baseColors[i * 3 + 2] * 0.15;
      pointSizes[i] = 0.5;
    }
  }

  pointCloud.geometry.attributes.color.needsUpdate = true;
  pointCloud.geometry.attributes.size.needsUpdate = true;

  // Connections
  removeConnections();
  if (isConnect && neighbors.length > 0 && neighbors.length < 500) {
    const linePositions = new Float32Array(neighbors.length * 6);
    const lineColors = new Float32Array(neighbors.length * 6);
    for (let i = 0; i < neighbors.length; i++) {
      const ni = neighbors[i];
      const [nx, ny, nz] = getCoords(wordData[ni]);
      linePositions[i * 6] = cx;
      linePositions[i * 6 + 1] = cy;
      linePositions[i * 6 + 2] = cz;
      linePositions[i * 6 + 3] = nx;
      linePositions[i * 6 + 4] = ny;
      linePositions[i * 6 + 5] = nz;
      const c = posColors[wordData[ni].p] || posColors.other;
      lineColors[i * 6] = 1; lineColors[i * 6 + 1] = 1; lineColors[i * 6 + 2] = 1;
      lineColors[i * 6 + 3] = c[0]; lineColors[i * 6 + 4] = c[1]; lineColors[i * 6 + 5] = c[2];
    }
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
    lineGeo.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    const lineMat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    connectionLines = new THREE.LineSegments(lineGeo, lineMat);
    scene.add(connectionLines);
  }

  // Build traverse list from neighbors (sorted by distance)
  traverseList = neighbors.slice().sort((a, b) => {
    const [ax, ay, az] = getCoords(wordData[a]);
    const [bx, by, bz] = getCoords(wordData[b]);
    const da = Math.sqrt((ax-cx)**2 + (ay-cy)**2 + (az-cz)**2);
    const db = Math.sqrt((bx-cx)**2 + (by-cy)**2 + (bz-cz)**2);
    return da - db;
  });
  traverseIndex = -1;
  traversePrevColor = null;
  updateTraverseUI();
}

function removeConnections() {
  if (connectionLines) {
    scene.remove(connectionLines);
    connectionLines.geometry.dispose();
    connectionLines.material.dispose();
    connectionLines = null;
  }
}

function updateTraverseUI() {
  const group = document.getElementById('traverse-group');
  const counter = document.getElementById('traverse-counter');
  if (traverseList.length > 0) {
    group.style.display = '';
    counter.textContent = `${traverseIndex + 1}/${traverseList.length}`;
  } else {
    group.style.display = 'none';
    counter.textContent = '0/0';
  }
}

function traverseStep(dir) {
  if (traverseList.length === 0) return;

  // Restore previous traversed word to its highlighted color (POS color)
  if (traverseIndex >= 0 && traverseIndex < traverseList.length && traversePrevColor) {
    const prevIdx = traverseList[traverseIndex];
    pointColors[prevIdx * 3] = traversePrevColor[0];
    pointColors[prevIdx * 3 + 1] = traversePrevColor[1];
    pointColors[prevIdx * 3 + 2] = traversePrevColor[2];
    pointSizes[prevIdx] = 1.8;
  }

  // Move index
  traverseIndex += dir;
  if (traverseIndex >= traverseList.length) traverseIndex = 0;
  if (traverseIndex < 0) traverseIndex = traverseList.length - 1;

  const idx = traverseList[traverseIndex];
  const d = wordData[idx];

  // Save current color before turning white
  traversePrevColor = [
    pointColors[idx * 3],
    pointColors[idx * 3 + 1],
    pointColors[idx * 3 + 2],
  ];

  // Turn traversed word white and enlarge
  pointColors[idx * 3] = 1;
  pointColors[idx * 3 + 1] = 1;
  pointColors[idx * 3 + 2] = 1;
  pointSizes[idx] = 2.8;

  pointCloud.geometry.attributes.color.needsUpdate = true;
  pointCloud.geometry.attributes.size.needsUpdate = true;

  // Show tooltip for this word
  const pc = posColors[d.p] || posColors.other;
  const hex = '#' + pc.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  document.getElementById('tip-word').textContent = d.w;
  document.getElementById('tip-pos').textContent = posLabels[d.p] || d.p;
  document.getElementById('tip-pos').style.background = hex + '33';
  document.getElementById('tip-pos').style.color = hex;
  document.getElementById('tip-meaning').textContent = d.m;
  const tooltip = document.getElementById('tooltip');
  tooltip.style.display = 'block';
  tooltip.style.left = '50%';
  tooltip.style.top = '75%';
  tooltip.style.transform = 'translate(-50%, -50%)';

  updateTraverseUI();
}

function resetTraverse() {
  // Restore color of currently traversed word
  if (traverseIndex >= 0 && traverseIndex < traverseList.length && traversePrevColor) {
    const prevIdx = traverseList[traverseIndex];
    pointColors[prevIdx * 3] = traversePrevColor[0];
    pointColors[prevIdx * 3 + 1] = traversePrevColor[1];
    pointColors[prevIdx * 3 + 2] = traversePrevColor[2];
    pointSizes[prevIdx] = 1.8;
  }
  traverseList = [];
  traverseIndex = -1;
  traversePrevColor = null;
  updateTraverseUI();
}

function resetHighlight() {
  resetTraverse();
  const n = wordData.length;
  for (let i = 0; i < n; i++) {
    pointColors[i * 3] = baseColors[i * 3];
    pointColors[i * 3 + 1] = baseColors[i * 3 + 1];
    pointColors[i * 3 + 2] = baseColors[i * 3 + 2];
    pointSizes[i] = baseSizes[i];
  }
  highlightedSet.clear();
  pointCloud.geometry.attributes.color.needsUpdate = true;
  pointCloud.geometry.attributes.size.needsUpdate = true;
  removeConnections();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function onMouseMove(e) {
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(pointCloud);

  const tooltip = document.getElementById('tooltip');

  // Only show tooltip on highlighted words (when selection active) or any word (when no selection)
  if (intersects.length > 0) {
    const idx = intersects[0].index;
    const hasSelection = selectedIndex >= 0;

    if (hasSelection && !highlightedSet.has(idx)) {
      // Not a highlighted word, hide tooltip
      if (hoveredIndex >= 0 && hoveredIndex !== selectedIndex) {
        pointSizes[hoveredIndex] = highlightedSet.has(hoveredIndex) ? 1.8 : 0.5;
        pointCloud.geometry.attributes.size.needsUpdate = true;
      }
      hoveredIndex = -1;
      tooltip.style.display = 'none';
      document.getElementById('canvas').style.cursor = 'grab';
      return;
    }

    if (idx !== hoveredIndex) {
      // Restore previous hovered
      if (hoveredIndex >= 0 && hoveredIndex !== selectedIndex) {
        pointSizes[hoveredIndex] = hasSelection ? (highlightedSet.has(hoveredIndex) ? 1.8 : 0.5) : baseSizes[hoveredIndex];
        pointCloud.geometry.attributes.size.needsUpdate = true;
      }
      hoveredIndex = idx;
      const d = wordData[idx];
      const pc = posColors[d.p] || posColors.other;
      const hex = '#' + pc.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
      document.getElementById('tip-word').textContent = d.w;
      document.getElementById('tip-pos').textContent = posLabels[d.p] || d.p;
      document.getElementById('tip-pos').style.background = hex + '33';
      document.getElementById('tip-pos').style.color = hex;
      document.getElementById('tip-meaning').textContent = d.m;
    }
    tooltip.style.display = 'block';
    tooltip.style.left = (e.clientX + 16) + 'px';
    tooltip.style.top = (e.clientY - 10) + 'px';
    tooltip.style.transform = '';

    // Enlarge hovered point
    if (idx !== selectedIndex) {
      pointSizes[idx] = hasSelection ? 2.5 : 2.0;
      pointCloud.geometry.attributes.size.needsUpdate = true;
    }
    document.getElementById('canvas').style.cursor = 'pointer';
  } else {
    if (hoveredIndex >= 0 && hoveredIndex !== selectedIndex) {
      const hasSelection = selectedIndex >= 0;
      pointSizes[hoveredIndex] = hasSelection ? (highlightedSet.has(hoveredIndex) ? 1.8 : 0.5) : baseSizes[hoveredIndex];
      pointCloud.geometry.attributes.size.needsUpdate = true;
    }
    hoveredIndex = -1;
    tooltip.style.display = 'none';
    document.getElementById('canvas').style.cursor = 'grab';
  }
}

function onClick(e) {
  if (isLocked && selectedIndex >= 0) return;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(pointCloud);

  if (intersects.length > 0) {
    const idx = intersects[0].index;
    if (idx === selectedIndex) {
      // Deselect
      selectedIndex = -1;
      resetHighlight();
      document.getElementById('tooltip').style.display = 'none';
      return;
    }
    selectedIndex = idx;
    highlightNeighbors(idx);
  } else if (!isLocked) {
    selectedIndex = -1;
    resetHighlight();
    document.getElementById('tooltip').style.display = 'none';
  }
}

function flyToWord(idx) {
  const d = wordData[idx];
  const [tx, ty, tz] = getCoords(d);
  const target = new THREE.Vector3(tx, ty, tz);
  const camTarget = target.clone().add(new THREE.Vector3(5, 3, 20));
  const startPos = camera.position.clone();
  const startTarget = controls.target.clone();
  const duration = 1000;
  const startTime = performance.now();
  controls.autoRotate = false;

  function animateFly(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    camera.position.lerpVectors(startPos, camTarget, ease);
    controls.target.lerpVectors(startTarget, target, ease);
    controls.update();
    if (t < 1) requestAnimationFrame(animateFly);
  }
  requestAnimationFrame(animateFly);

  selectedIndex = idx;
  highlightNeighbors(idx);

  const pc = posColors[d.p] || posColors.other;
  const hex = '#' + pc.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  document.getElementById('tip-word').textContent = d.w;
  document.getElementById('tip-pos').textContent = posLabels[d.p] || d.p;
  document.getElementById('tip-pos').style.background = hex + '33';
  document.getElementById('tip-pos').style.color = hex;
  document.getElementById('tip-meaning').textContent = d.m;
  const tooltip = document.getElementById('tooltip');
  tooltip.style.display = 'block';
  tooltip.style.left = '50%';
  tooltip.style.top = '70%';
}

function onSearch() {
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  const resultsEl = document.getElementById('search-results');
  if (!q) { resultsEl.style.display = 'none'; return; }
  const matches = wordData
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => d.w.toLowerCase().includes(q))
    .slice(0, 20);
  if (matches.length === 0) { resultsEl.style.display = 'none'; return; }
  resultsEl.innerHTML = matches.map(({ d, i }) => {
    const pc = posColors[d.p] || posColors.other;
    const hex = '#' + pc.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
    return `<div class="item" data-idx="${i}"><span class="sw" style="color:${hex}">${d.w}</span><span class="sm">${d.m}</span></div>`;
  }).join('');
  resultsEl.style.display = 'block';
  resultsEl.querySelectorAll('.item').forEach(item => {
    item.addEventListener('click', () => {
      flyToWord(parseInt(item.dataset.idx));
      resultsEl.style.display = 'none';
      document.getElementById('search-input').value = '';
    });
  });
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  if (hoveredIndex >= 0 && hoveredIndex !== selectedIndex) {
    const t = performance.now() * 0.003;
    const hasSelection = selectedIndex >= 0;
    pointSizes[hoveredIndex] = (hasSelection ? 2.5 : 2.0) + Math.sin(t) * 0.5;
    pointCloud.geometry.attributes.size.needsUpdate = true;
  }

  renderer.render(scene, camera);
}

await loadData();
init();
animate();
