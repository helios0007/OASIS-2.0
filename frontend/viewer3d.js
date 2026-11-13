// OASIS 2.0 — the 3D viewport of the workspace: the flat in 3D, felt heat per
// room, and the household in the rooms their routine puts them in, with a status
// label on each person. app.js calls window.OASIS3D.show(result.unit) after each
// run (single room or room-by-room plan) and OASIS3D.setHour(h) from the
// timeline; the geometry is what the simulation read, so what is drawn is
// exactly what was simulated. Plan coordinates: x east, y north, z up (m);
// three.js: x east, y up, -z north.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

const $ = (id) => document.getElementById(id);
const TE = 0.23, TI = 0.115, SLAB = 0.15;          // wall and slab thickness (m), as in rhino/draw_detail.py
const LAT = 13.08, DECL = 18.0;                     // Chennai; solar declination mid-May (deg)
const P = (x, y, z) => new THREE.Vector3(x, z, -y);
const STATUS_LABEL = { safe: "Safe", caution: "Caution", danger: "Danger", critical: "Critical", away: "Away" };
const STATUS_HEX = { safe: 0x9aa5b1, caution: 0xe0a106, danger: 0xea580c, critical: 0xb91c1c, away: 0x9aa5b1 };

const CUT_M = 1.5;                                  // section height of the cut-away view
const state = { data: null, hour: 0, focus: null, allDetails: false, wallMode: "cut", viewKind: "3d" };
const ROOF_HEX = (a) => (a <= 0.25 ? 0xf5f5f4 : a <= 0.5 ? 0xb5afa3 : 0x6b665c);   // roof colour from solar absorptance
const GRID = { major: new THREE.Color(0xc3c9d1), minor: new THREE.Color(0xd7dce2) };  // set from the theme

// ---------------------------------------------------------------- colours
const SAFE_C = new THREE.Color("#e7ecea"), WARM_C = new THREE.Color("#f5d9a8");
const HOT_C = new THREE.Color("#ea580c"), DEEP_C = new THREE.Color("#991b1b");
function heatColor(hi) {
  const c = new THREE.Color();
  if (hi < 41) return c.lerpColors(SAFE_C, WARM_C, Math.max(0, Math.min(1, (hi - 27) / 14)));
  return c.lerpColors(HOT_C, DEEP_C, Math.min(1, (hi - 41) / 13));
}
function cssHeat(hi) { return "#" + heatColor(hi).getHexString(); }

// ---------------------------------------------------------------- scene
const view = $("v3-viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
view.appendChild(renderer.domElement);
const labels = new CSS2DRenderer();
labels.domElement.style.position = "absolute";
labels.domElement.style.inset = "0";
labels.domElement.style.pointerEvents = "none";
view.appendChild(labels.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 400);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.47;
const hemi = new THREE.HemisphereLight(0xffffff, 0xd6d3d1, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

let flat = null;          // THREE.Group of the current flat
let floorTiles = {};      // room -> [mesh]
let roomTags = {};        // room -> label element
let figures = [];         // per person {group, parts, tag, ...}
let beds = {};            // room -> {cx, cy, along: "x"|"y", len, wid}

const M = {
  ext: new THREE.MeshStandardMaterial({ color: 0xf4f3f1, roughness: 0.92 }),
  part: new THREE.MeshStandardMaterial({ color: 0xe9e7e4, roughness: 0.92 }),
  party: new THREE.MeshStandardMaterial({ color: 0xcfcac4, roughness: 0.95 }),
  slab: new THREE.MeshStandardMaterial({ color: 0xd9d6d2, roughness: 0.95 }),
  glass: new THREE.MeshPhysicalMaterial({ color: 0x9fd8f5, roughness: 0.05, transmission: 0.0, transparent: true, opacity: 0.35 }),
  door: new THREE.MeshStandardMaterial({ color: 0x8a6f55, roughness: 0.7 }),
  bed: new THREE.MeshStandardMaterial({ color: 0xfafaf9, roughness: 0.9 }),
  bedBase: new THREE.MeshStandardMaterial({ color: 0xb8aa98, roughness: 0.8 }),
  seat: new THREE.MeshStandardMaterial({ color: 0xc8c2ba, roughness: 0.85 }),
  ground: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
  edge: new THREE.LineBasicMaterial({ color: 0x8b8b93, transparent: true, opacity: 0.55 }),
  shade: new THREE.MeshStandardMaterial({ color: 0xa8a29e, roughness: 0.9 }),
  roofSlab: new THREE.MeshStandardMaterial({ color: 0xbdb9b3, roughness: 0.95, transparent: true, opacity: 0.5 }),
  insul: new THREE.MeshStandardMaterial({ color: 0xe8d9a0, roughness: 0.9, transparent: true, opacity: 0.7 }),
  dim: new THREE.LineBasicMaterial({ color: 0x8b8b93 }),
};

function box(x0, x1, y0, y1, z0, z1, mat, edges = true) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)], [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const g = new THREE.BoxGeometry(bx - ax, z1 - z0, by - ay);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(P((ax + bx) / 2, (ay + by) / 2, (z0 + z1) / 2));
  m.castShadow = m.receiveShadow = true;
  if (edges) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), M.edge));
  return m;
}

// A box along a wall line: a0..a1 along it, t0..t1 across (outward positive)
const NORMAL = { south: [0, -1], north: [0, 1], west: [-1, 0], east: [1, 0] };
function alongBox(side, fixed, a0, a1, t0, t1, z0, z1, mat, edges = true) {
  const [nx, ny] = NORMAL[side];
  if (side === "north" || side === "south") return box(a0, a1, fixed + ny * t0, fixed + ny * t1, z0, z1, mat, edges);
  return box(fixed + nx * t0, fixed + nx * t1, a0, a1, z0, z1, mat, edges);
}

function buildFlat(g) {
  // CSS2D labels stay in the page unless their elements are removed too
  if (flat) { scene.remove(flat); flat.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.isCSS2DObject) o.element.remove(); }); }
  for (const f of figures) { f.group.removeFromParent(); f.el.remove(); }
  flat = new THREE.Group();
  floorTiles = {}; roomTags = {}; figures = []; beds = {};
  const H = state.wallMode === "cut" ? Math.min(CUT_M, g.height_m) : g.height_m;   // drawn wall height

  // Walls, split around their openings
  for (const w of g.walls) {
    const mat = w.kind === "exterior" ? M.ext : w.kind === "party" ? M.party : M.part;
    const [t0, t1, ext] = w.kind === "partition" ? [-TI / 2, TI / 2, TI / 2] : [0, TE, TE];
    const holes = [...w.holes].sort((a, b) => a.lo - b.lo);
    let pos = w.a0 - ext;
    for (const h0 of holes) {
      const h = { ...h0, z0: Math.min(h0.z0, H), z1: Math.min(h0.z1, H) };
      if (h.lo - pos > 1e-3) flat.add(alongBox(w.side, w.fixed, pos, h.lo, t0, t1, 0, H, mat));
      if (h.z0 > 0) flat.add(alongBox(w.side, w.fixed, h.lo, h.hi, t0, t1, 0, h.z0, mat));
      if (h.z1 < H) flat.add(alongBox(w.side, w.fixed, h.lo, h.hi, t0, t1, h.z1, H, mat));
      const mid = (t0 + t1) / 2;
      if (h.z1 - h.z0 < 0.01) { pos = h.hi; continue; }
      if (["window", "ventilator", "balcony_door"].includes(h.kind)) {
        const pane = alongBox(w.side, w.fixed, h.lo, h.hi, mid - 0.004, mid + 0.004, h.z0, h.z1, M.glass, false);
        pane.castShadow = false; flat.add(pane);
      } else if (h.kind === "entrance") {
        flat.add(alongBox(w.side, w.fixed, h.lo, h.hi, t0 + 0.02, t0 + 0.06, 0, h.z1, M.door));
      }
      pos = h.hi;
    }
    if (w.a1 + ext - pos > 1e-3) flat.add(alongBox(w.side, w.fixed, pos, w.a1 + ext, t0, t1, 0, H, mat));
  }

  // Floor slab, room floors (coloured by felt heat), room labels, beds
  const all = Object.values(g.rooms).flatMap((r) => r.rects);
  const bb = all.reduce((b, r) => [Math.min(b[0], r[0]), Math.min(b[1], r[1]), Math.max(b[2], r[2]), Math.max(b[3], r[3])],
                        [Infinity, Infinity, -Infinity, -Infinity]);
  for (const r of all) flat.add(box(r[0] - TE, r[2] + TE, r[1] - TE, r[3] + TE, -SLAB, -0.001, M.slab, false));
  for (const [name, room] of Object.entries(g.rooms)) {
    floorTiles[name] = room.rects.map((r) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(r[2] - r[0], r[3] - r[1]),
                               new THREE.MeshStandardMaterial({ color: 0xe7ecea, roughness: 0.95 }));
      m.rotation.x = -Math.PI / 2;
      m.position.copy(P((r[0] + r[2]) / 2, (r[1] + r[3]) / 2, 0.002));
      m.receiveShadow = true;
      flat.add(m);
      return m;
    });
    const big = room.rects.reduce((a, r) => ((r[2] - r[0]) * (r[3] - r[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? r : a));
    const el = document.createElement("div");
    el.className = "rlabel";
    const obj = new CSS2DObject(el);
    obj.position.copy(P((big[0] + big[2]) / 2, big[1] + 0.35, 0.02));
    flat.add(obj);
    roomTags[name] = { el, obj };
    if (room.type === "bedroom") addBed(name, big);
  }

  // Balconies: slab and 1.0 m parapets
  for (const b of g.balconies) {
    const [t0, t1] = [TE, TE + b.depth];
    flat.add(alongBox(b.side, b.fixed, b.a0, b.a1, t0, t1, -SLAB, 0, M.slab));
    flat.add(alongBox(b.side, b.fixed, b.a0, b.a1, t1 - 0.1, t1, 0, 1.0, M.ext));
    flat.add(alongBox(b.side, b.fixed, b.a0, b.a0 + 0.1, t0, t1, 0, 1.0, M.ext));
    flat.add(alongBox(b.side, b.fixed, b.a1 - 0.1, b.a1, t0, t1, 0, 1.0, M.ext));
  }

  // Window overhangs (only when the walls are drawn up to them)
  for (const sh of g.shades || []) {
    if (sh.z > H + 1e-6) continue;
    flat.add(alongBox(sh.side, sh.fixed, sh.lo - 0.1, sh.hi + 0.1, TE, TE + sh.depth, sh.z, sh.z + 0.08, M.shade));
  }

  // Roof: slab, optional insulation, and the finish in the roof colour
  const design = state.data?.design;
  if (state.wallMode === "roof") {
    const top = design?.floor !== "middle";
    for (const r of all) {
      const add = (z0, z1, mat) => { const m = box(r[0] - TE, r[2] + TE, r[1] - TE, r[3] + TE, z0, z1, mat); m.castShadow = false; flat.add(m); };
      add(H, H + SLAB, M.roofSlab);
      let z = H + SLAB;
      if (top && String(design?.roof || "").includes("insul")) { add(z, z + 0.05, M.insul); z += 0.05; }
      if (top) add(z, z + 0.015, new THREE.MeshStandardMaterial({ color: ROOF_HEX(design?.roof_solar_absorptance ?? 0.7), roughness: 0.9, transparent: true, opacity: 0.6 }));
    }
  }

  // Ground, 1 m grid, overall dimensions and north arrow
  const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, span = Math.max(bb[2] - bb[0], bb[3] - bb[1]);
  const ground = new THREE.Mesh(new THREE.CircleGeometry(span * 4, 64), M.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.position.copy(P(cx, cy, -SLAB - 0.004));
  ground.receiveShadow = true;
  flat.add(ground);
  const size = 2 * Math.ceil(span * 2);
  const grid = new THREE.GridHelper(size, size, GRID.major, GRID.minor);
  grid.position.copy(P(Math.round(cx), Math.round(cy), -SLAB - 0.002));
  flat.add(grid);
  dimension(bb[0], bb[2], bb[1] - TE - 0.7, "x");
  dimension(bb[1], bb[3], bb[0] - TE - 0.7, "y");
  flat.add(northArrow(bb[2] + 1.6, bb[3] - 0.6, g.orientation_deg || 0));

  scene.add(flat);
  state.center = { cx, cy, span, H };
  sun.shadow.camera.left = sun.shadow.camera.bottom = -span;
  sun.shadow.camera.right = sun.shadow.camera.top = span;
  sun.shadow.camera.far = span * 8;
  sun.shadow.camera.updateProjectionMatrix();
}

// A dimension line with its length, on the ground (axis "x": along east, at y = at)
function dimension(a0, a1, at, axis) {
  const z = -SLAB + 0.01, tick = 0.18;
  const pt = (a, off) => (axis === "x" ? P(a, at + off, z) : P(at + off, a, z));
  const pts = [pt(a0, 0), pt(a1, 0), pt(a0, -tick), pt(a0, tick), pt(a1, -tick), pt(a1, tick)];
  flat.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), M.dim));
  const el = document.createElement("div"); el.className = "dim-label"; el.textContent = `${(a1 - a0).toFixed(2)} m`;
  const obj = new CSS2DObject(el); obj.position.copy(pt((a0 + a1) / 2, -0.35));
  flat.add(obj);
}

function addBed(name, r) {
  const w = r[2] - r[0], d = r[3] - r[1];
  const alongY = d >= w;                 // head against the north (or west) wall, long side along the room
  const len = 1.95, wid = Math.min(1.5, (alongY ? w : d) - 0.6);
  let x0, x1, y0, y1;
  if (alongY) { x0 = (r[0] + r[2]) / 2 - wid / 2; x1 = x0 + wid; y1 = r[3] - 0.05; y0 = y1 - len; }
  else { y0 = (r[1] + r[3]) / 2 - wid / 2; y1 = y0 + wid; x0 = r[0] + 0.05; x1 = x0 + len; }
  flat.add(box(x0, x1, y0, y1, 0, 0.3, M.bedBase));
  flat.add(box(x0 + 0.03, x1 - 0.03, y0 + 0.03, y1 - 0.03, 0.3, 0.45, M.bed));
  beds[name] = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, alongY, len, wid, rect: r };
}

function northArrow(x, y, orientation) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(0, 0.55); shape.lineTo(0.22, -0.35); shape.lineTo(0, -0.18); shape.lineTo(-0.22, -0.35); shape.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x27272a }));
  m.rotation.x = -Math.PI / 2;
  g.add(m);
  const el = document.createElement("div"); el.className = "rlabel"; el.textContent = "N";
  const t = new CSS2DObject(el); t.position.set(0, 0.02, -0.85); g.add(t);
  g.position.copy(P(x, y, 0.01));
  g.rotation.y = THREE.MathUtils.degToRad(orientation);   // true north relative to the plan
  return g;
}

// ---------------------------------------------------------------- people
function makeFigure(person) {
  const s = (person.height_cm || 160) / 160;
  const body = new THREE.MeshStandardMaterial({ color: STATUS_HEX.safe, roughness: 0.6 });
  const head = new THREE.MeshStandardMaterial({ color: 0xf1efec, roughness: 0.6 });
  const group = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.15 * s, 0.9 * s, 6, 16), body);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 20, 14), head);
  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), M.seat);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.3, 40), new THREE.MeshBasicMaterial({ color: STATUS_HEX.safe, transparent: true, opacity: 0.9 }));
  ring.rotation.x = -Math.PI / 2;
  for (const m of [torso, skull, seat]) { m.castShadow = true; m.receiveShadow = true; }
  group.add(torso, skull, seat, ring);
  if (person.role === "elderly") {           // a cane: a thin line, the only "costume"
    const cane = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.85 * s), new THREE.MeshStandardMaterial({ color: 0x57534e }));
    cane.name = "cane"; group.add(cane);
  }
  const el = document.createElement("div"); el.className = "tag";
  el.addEventListener("click", (e) => { e.stopPropagation(); focusPerson(person.id); });
  const tag = new CSS2DObject(el);
  tag.center.set(0.5, 1);                    // anchor the label's bottom edge above the head
  group.add(tag);
  scene.add(group);
  return { person, group, torso, skull, seat, ring, body, tag, el, s, target: new THREE.Vector3(), yaw: 0, placed: false };
}

function pose(f, posture, base, yaw) {
  const s = f.s, r = 0.15 * s, L = 0.9 * s;
  const cane = f.group.getObjectByName("cane");
  f.seat.visible = posture === "sitting";
  if (cane) cane.visible = posture === "standing";
  f.torso.rotation.set(0, 0, 0);
  if (posture === "lying") {
    f.torso.rotation.z = Math.PI / 2;
    f.torso.position.set(0, base + r, 0);
    f.skull.position.set(-(L / 2 + r + 0.08 * s), base + 0.11 * s, 0);
    f.tag.position.set(0, base + 0.75, 0);
    f.ring.visible = false;
  } else if (posture === "sitting") {
    f.seat.position.set(0, 0.21, 0);
    const torsoL = L * 0.55;
    f.torso.scale.set(1, (torsoL + 2 * r) / (L + 2 * r), 1);
    f.torso.position.set(0, 0.42 + (torsoL + 2 * r) / 2, 0);
    f.skull.position.set(0, 0.42 + torsoL + 2 * r + 0.13 * s, 0);
    f.tag.position.set(0, 0.42 + torsoL + 2 * r + 0.5 * s, 0);
    f.ring.visible = true;
  } else {
    f.torso.position.set(0, (L + 2 * r) / 2, 0);
    f.skull.position.set(0, L + 2 * r + 0.13 * s, 0);
    f.tag.position.set(0, L + 2 * r + 0.5 * s, 0);
    if (cane) cane.position.set(0.24, 0.42 * s, 0.05);
    f.ring.visible = true;
  }
  if (posture !== "sitting") f.torso.scale.set(1, 1, 1);
  f.ring.position.set(0, 0.006, 0);
  f.yaw = yaw;
}

// Where everyone in a room stands, sits or lies this hour
function slots(room, people, h) {
  const g = state.data.geometry, rm = g.rooms[room];
  const r = rm.rects.reduce((a, b) => ((b[2] - b[0]) * (b[3] - b[1]) > (a[2] - a[0]) * (a[3] - a[1]) ? b : a));
  const inset = 0.55, clampX = (x) => Math.min(r[2] - inset, Math.max(r[0] + inset, x)), clampY = (y) => Math.min(r[3] - inset, Math.max(r[1] + inset, y));
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  const out = {};
  const bed = beds[room];
  let onBed = 0, onFloor = 0, upright = 0;
  const grid = [[0, 0], [0.85, 0.2], [-0.85, -0.2], [0.2, -0.85], [-0.2, 0.85], [0.9, -0.9], [-0.9, 0.9]];
  for (const p of people) {
    const posture = p.hourly.posture[h];
    if (posture === "lying" && bed && onBed < 2) {
      const off = (onBed === 0 ? -1 : 1) * bed.wid / 4;
      out[p.id] = bed.alongY ? { x: bed.cx + off, y: bed.cy, z: 0.45, yaw: -Math.PI / 2 }
                             : { x: bed.cx, y: bed.cy + off, z: 0.45, yaw: 0 };
      onBed++;
    } else if (posture === "lying") {          // a mat on the floor
      const off = 0.75 * (onFloor + 1);
      out[p.id] = bed ? (bed.alongY ? { x: clampX(bed.cx + bed.wid / 2 + off - 0.2), y: bed.cy, z: 0.03, yaw: -Math.PI / 2 }
                                    : { x: bed.cx, y: clampY(bed.cy - bed.wid / 2 - off + 0.2), z: 0.03, yaw: 0 })
                      : { x: clampX(cx + (onFloor - 0.5) * 0.8), y: cy, z: 0.03, yaw: -Math.PI / 2 };
      onFloor++;
    } else {
      const [dx, dy] = grid[upright % grid.length];
      out[p.id] = { x: clampX(cx + dx), y: clampY(cy + dy), z: 0, yaw: 0 };
      upright++;
    }
  }
  return out;
}

function placePeople() {
  const d = state.data, h = state.hour;
  const byRoom = {};
  for (const p of d.people) { const rm = p.hourly.room[h]; if (rm) (byRoom[rm] ||= []).push(p); }
  const spot = {}, stack = {};
  for (const [rm, ps] of Object.entries(byRoom)) {
    Object.assign(spot, slots(rm, ps, h));
    ps.forEach((p, i) => { stack[p.id] = i; });      // labels of people in one room step up, so they don't overlap
  }
  for (const f of figures) {
    const p = d.people.find((q) => q.id === f.person.id);
    f.person = p;
    const st = p.hourly.status[h];
    const away = !p.hourly.room[h];
    f.group.visible = !away;
    f.tag.visible = !away;
    if (away) continue;
    const s = spot[p.id];
    pose(f, p.hourly.posture[h], s.z, s.yaw);
    f.target.copy(P(s.x, s.y, 0));
    if (!f.placed) { f.group.position.copy(f.target); f.placed = true; }
    f.group.rotation.y = f.yaw;
    f.body.color.setHex(STATUS_HEX[st] || STATUS_HEX.safe);
    f.ring.material.color.setHex(STATUS_HEX[st] || STATUS_HEX.safe);
    renderTag(f, p, h);
  }
}

const fmt = (v, d = 1) => (v == null ? "–" : Number(v).toFixed(d));
function renderTag(f, p, h) {
  const H = p.hourly, st = H.status[h], first = (p.name || "").split(" ")[0];
  const value = p.modelled ? `${fmt(H.t_core[h], 2)} °C` : `felt ${fmt(H.hi[h])} °C`;
  const open = state.allDetails || state.focus === p.id;
  const room = (H.room[h] || "").replace("_", " ");
  const sc = state.data.scenario;
  const cut = state.data.cut[h];
  const fan = !state.data.geometry.rooms[H.room[h]]?.fan ? "no fan" : cut ? "off (power cut)" : "on";
  const corePct = p.modelled ? Math.max(0, Math.min(1, (H.t_core[h] - 36.5) / (sc.core_critical_c - 36.5))) : 0;
  const card = !open ? "" : `
    <div class="tag-card">
      <header><b>${p.name}</b><span>${p.age} · ${p.role}</span></header>
      <div class="chip"><i class="dot st-${st}"></i>${p.modelled ? STATUS_LABEL[st] : st === "danger" ? "Felt heat: danger" : "Felt heat: safe"}</div>
      <div class="where">${room} · ${H.activity[h].toLowerCase()}</div>
      ${p.modelled ? `
      <div class="bar"><i style="width:${(corePct * 100).toFixed(0)}%;background:${st === "safe" ? "#64748b" : cssHeat(39 + corePct * 12)}"></i></div>
      <dl>
        <dt>Core temp</dt><dd>${fmt(H.t_core[h], 2)} °C</dd>
        <dt>Skin temp</dt><dd>${fmt(H.t_skin[h])} °C</dd>
        <dt>Skin wetness</dt><dd>${fmt(H.wet_pct[h], 0)} %</dd>
        <dt>Sweat rate</dt><dd>${fmt(H.sweat_gh[h], 0)} g/h</dd>
        <dt>Cardiac output</dt><dd>${fmt(H.cardiac_lh[h], 0)} L/h</dd>
        <dt>Room air · felt</dt><dd>${fmt(H.t_air[h])} · ${fmt(H.hi[h])} °C</dd>
        <dt>Air speed · fan</dt><dd>${fmt(H.v[h])} m/s · ${fan}</dd>
        <dt>Safe hours, week</dt><dd>${p.summary.safe_hours} / ${p.summary.hours_at_home}</dd>
      </dl>` : `
      <dl>
        <dt>Room air · felt</dt><dd>${fmt(H.t_air[h])} · ${fmt(H.hi[h])} °C</dd>
        <dt>Fan</dt><dd>${fan}</dd>
        <dt>Safe hours, week</dt><dd>${p.summary.safe_hours} / ${p.summary.hours_at_home}</dd>
      </dl>
      <p class="note">No validated body model for children: shown by the room's felt heat (limit ${sc.safe_limit_c} °C).</p>`}
    </div>`;
  f.el.innerHTML = `${card}<span class="tag-pill"><i class="dot st-${st}"></i><b>${first}</b><span class="mono">${value}</span></span>`;
}

function focusPerson(id, fromApp = false) {
  state.focus = fromApp ? id : state.focus === id ? null : id;
  renderAll();
  if (!fromApp) window.dispatchEvent(new CustomEvent("oasis3d-focus", { detail: state.focus }));
}

// ---------------------------------------------------------------- sun and time
function sunAt(h) {
  const hourOfDay = (h % 24) + 0.5;                      // middle of the hour, ~solar time
  const lat = THREE.MathUtils.degToRad(LAT), dec = THREE.MathUtils.degToRad(DECL);
  const ha = THREE.MathUtils.degToRad(15 * (hourOfDay - 12));
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha);
  const el = Math.asin(sinEl);
  let az = Math.atan2(Math.sin(ha), Math.cos(ha) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat)) + Math.PI; // from north, clockwise
  az -= THREE.MathUtils.degToRad(state.data.geometry.orientation_deg || 0);
  return { el, az };
}

function updateSun() {
  const { el, az } = sunAt(state.hour), c = state.center, R = c.span * 3;
  const up = Math.max(el, 0.05);
  const dir = new THREE.Vector3(Math.sin(az) * Math.cos(up), Math.sin(up), -Math.cos(az) * Math.cos(up));
  const target = P(c.cx, c.cy, 0);
  sun.position.copy(target.clone().add(dir.multiplyScalar(R)));
  sun.target.position.copy(target);
  const day = Math.max(0, Math.sin(el));
  sun.intensity = 2.6 * Math.min(1, day * 2.2);
  sun.castShadow = day > 0.02;
  hemi.intensity = 0.85 + 0.6 * Math.min(1, day * 3);
}

function clock(h) {
  const sc = state.data.scenario, day = Math.floor(h / 24), hh = h % 24;
  return `${sc.first_day + day} ${sc.month} · ${String(hh).padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------- readout (top right)
const roomName = (n) => n.replace("_", " ");
function renderSide() {
  const d = state.data, h = state.hour, g = d.geometry;
  const rows = Object.entries(g.rooms).map(([n, r]) => {
    const R = d.rooms[n];
    return `<li><i class="sw" style="background:${cssHeat(R.hi[h])}"></i><span>${roomName(n)}${r.fan ? "" : ' <span class="muted sm">no fan</span>'}</span>
      <span class="v">${fmt(R.hi[h])}</span><span class="v muted">${fmt(R.t[h])}</span></li>`;
  }).join("");
  $("v3-rooms").innerHTML = `<li class="hd"><i></i><span>Room</span><span>felt °C</span><span>air °C</span></li>${rows}`;
  const cut = d.cut[h];
  $("v3-clock").textContent = clock(h);
  const note = $("v3-clock-note");
  note.textContent = cut ? "Power cut: fans off" : `${sunAt(h).el > 0 ? "Daytime" : "Night"} · outdoors ${fmt(d.outdoor.t[h])} °C`;
  note.className = "sm" + (cut ? " cut" : "");
}

function renderRooms() {
  const d = state.data, h = state.hour;
  for (const [n, tiles] of Object.entries(floorTiles)) {
    const c = heatColor(d.rooms[n].hi[h]);
    for (const t of tiles) t.material.color.copy(c);
    roomTags[n].el.innerHTML = `${roomName(n)}<span>${fmt(d.rooms[n].hi[h])} °C felt</span>`;
  }
}

function renderAll() {
  if (!state.data) return;
  renderRooms(); placePeople(); renderSide(); updateSun();
}

// ---------------------------------------------------------------- views and loop
function setView(kind) {
  const c = state.center; if (!c) return;
  if (view.clientWidth === 0) { state.pendingView = kind; return; }   // tab hidden: frame it when shown
  state.pendingView = null;
  const fit = Math.max(1, 1.45 / Math.max(0.3, camera.aspect));         // a narrow panel needs more distance
  const target = P(c.cx, c.cy, 0.8);
  controls.target.copy(target);
  if (kind === "plan") camera.position.copy(target.clone().add(new THREE.Vector3(0, c.span * 2.3 * fit, 0.001)));
  else camera.position.copy(target.clone().add(new THREE.Vector3(c.span * 0.75, c.span * 1.45, c.span * 1.2).multiplyScalar(fit)));
  camera.updateProjectionMatrix();
  state.viewKind = kind;
  $("v3-view-3d").setAttribute("aria-pressed", kind === "3d");
  $("v3-view-plan").setAttribute("aria-pressed", kind === "plan");
}

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h); labels.setSize(w, h);
  camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  if (w > 0 && state.pendingView) setView(state.pendingView);
}
new ResizeObserver(resize).observe(view);

function loop() {
  requestAnimationFrame(loop);
  if (!state.data || view.clientWidth === 0) return;        // tab hidden
  for (const f of figures) if (f.group.visible) f.group.position.lerp(f.target, 0.18);
  controls.update();
  renderer.render(scene, camera);
  labels.render(scene, camera);
  declutter();
}

// Push person labels up on screen until none overlap (lowest label stays put)
function declutter() {
  const items = figures.filter((f) => f.group.visible).map((f) => {
    const r = f.el.getBoundingClientRect(), pad = parseFloat(f.el.style.paddingBottom) || 0;
    return { f, x0: r.left, x1: r.right, bottom: r.bottom, h: r.height - pad, pad };
  }).sort((a, b) => b.bottom - a.bottom);
  const placed = [];
  for (const it of items) {
    let shift = 0;
    const hit = (s) => placed.some((q) => it.x0 < q.x1 && q.x0 < it.x1 && it.bottom - s - it.h < q.bottom && q.top < it.bottom - s);
    while (hit(shift) && shift < 400) shift += 6;
    if (Math.abs(shift - it.pad) > 0.5) it.f.el.style.paddingBottom = shift + "px";
    // an open card that would leave the top of the view opens below the head instead
    const top = it.bottom - shift - it.h, below = it.f.el.classList.contains("below");
    if (!below && top < view.getBoundingClientRect().top + 8 && it.f.el.querySelector(".tag-card")) {
      it.f.el.classList.add("below"); it.f.tag.center.set(0.5, 0);
    } else if (below && !it.f.el.querySelector(".tag-card")) {
      it.f.el.classList.remove("below"); it.f.tag.center.set(0.5, 1);
    }
    placed.push({ x0: it.x0, x1: it.x1, bottom: it.bottom - shift, top: it.bottom - shift - it.h });
    // people above room names; an open card above everything (CSS2DRenderer resets z-index each frame)
    it.f.el.style.zIndex = it.f.el.querySelector(".tag-card") ? 100000 : 10000 + placed.length;
  }
}

function themeScene() {
  const css = getComputedStyle(document.documentElement);
  const bg = new THREE.Color(css.getPropertyValue("--viewport").trim() || "#dfe3e8");
  scene.background = bg;
  M.ground.color.copy(bg);
  GRID.major = new THREE.Color(css.getPropertyValue("--grid").trim() || "#c3c9d1");
  GRID.minor = GRID.major.clone().lerp(bg, 0.55);
  M.dim.color.copy(GRID.major).lerp(new THREE.Color(css.getPropertyValue("--fg").trim() || "#101216"), 0.35);
  if (state.data) show(state.data, { keepView: true });
}

// ---------------------------------------------------------------- data
// keepView: a re-run of the same model keeps the camera
function show(data, { keepView = false, hour = null } = {}) {
  const same = keepView && state.data && state.data.geometry.name === data.geometry.name
    && JSON.stringify(state.data.geometry.walls) === JSON.stringify(data.geometry.walls);
  const cam = camera.position.clone(), tgt = controls.target.clone();
  state.data = data;
  if (!same) state.focus = null;
  if (hour !== null) state.hour = hour;
  buildFlat(data.geometry);
  figures = data.people.map(makeFigure);
  if (same) { camera.position.copy(cam); controls.target.copy(tgt); } else setView(state.viewKind);
  renderAll();
}

function setHour(h) { state.hour = h; renderAll(); }

// ---------------------------------------------------------------- events
$("v3-all-details").addEventListener("change", (e) => { state.allDetails = e.target.checked; renderAll(); });
$("v3-view-3d").addEventListener("click", () => setView("3d"));
$("v3-view-plan").addEventListener("click", () => setView("plan"));
document.querySelectorAll("[data-walls]").forEach((b) => b.addEventListener("click", () => {
  state.wallMode = b.dataset.walls;
  document.querySelectorAll("[data-walls]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  if (state.data) show(state.data, { keepView: true });
}));
renderer.domElement.addEventListener("click", () => { if (state.focus) focusPerson(state.focus); });

// The tool's theme toggle sets data-theme on <html>
new MutationObserver(themeScene).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", themeScene);

// Felt-heat scale in the legend
$("v3-scale-bar").style.background = `linear-gradient(90deg, ${[27, 34, 40.9, 41, 47, 54].map((v) => `${cssHeat(v)} ${((v - 27) / 27 * 100).toFixed(1)}%`).join(", ")})`;
$("v3-scale-ticks").innerHTML = "<span>27</span><span>41 °C limit</span><span>54</span>";

themeScene();
resize();
loop();
window.OASIS3D = { show, setHour, focus: (id) => focusPerson(id, true) };
window.dispatchEvent(new Event("oasis3d-ready"));
