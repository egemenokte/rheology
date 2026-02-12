import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Laplace-domain solver ───────────────────────────────────────────────────
// Spring: Z(s) = E
// Dashpot: Z(s) = η·s
// Series: 1/Z = Σ(1/Zᵢ)  →  compliances add
// Parallel: Z = Σ(Zᵢ)    →  impedances add

function impedance(node, s) {
  if (node.type === "spring") return node.E;
  if (node.type === "dashpot") return node.eta * s;
  if (node.type === "series") {
    let totalCompliance = 0;
    for (const child of node.children) {
      const z = impedance(child, s);
      if (Math.abs(z) < 1e-30) return 0;
      totalCompliance += 1 / z;
    }
    return totalCompliance === 0 ? Infinity : 1 / totalCompliance;
  }
  if (node.type === "parallel") {
    let totalZ = 0;
    for (const child of node.children) {
      totalZ += impedance(child, s);
    }
    return totalZ;
  }
  return 0;
}

// Stehfest algorithm for numerical inverse Laplace transform
function stehfestCoeffs(N) {
  const V = new Array(N).fill(0);
  for (let i = 1; i <= N; i++) {
    let sum = 0;
    const kMin = Math.floor((i + 1) / 2);
    const kMax = Math.min(i, N / 2);
    for (let k = kMin; k <= kMax; k++) {
      const num = Math.pow(k, N / 2) * factorial(2 * k);
      const den =
        factorial(N / 2 - k) *
        factorial(k) *
        factorial(k - 1) *
        factorial(i - k) *
        factorial(2 * k - i);
      sum += num / den;
    }
    V[i - 1] = Math.pow(-1, i + N / 2) * sum;
  }
  return V;
}

function factorial(n) {
  if (n < 0) return Infinity;
  if (n <= 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

const STEHFEST_N = 12;
const coeffs = stehfestCoeffs(STEHFEST_N);

function inverseLaplace(F, t) {
  if (t <= 0) return 0;
  const ln2_over_t = Math.LN2 / t;
  let sum = 0;
  for (let i = 0; i < STEHFEST_N; i++) {
    const s = (i + 1) * ln2_over_t;
    sum += coeffs[i] * F(s);
  }
  return sum * ln2_over_t;
}

// Compute creep compliance J(t) and relaxation modulus E(t)
// With Boltzmann superposition for load removal at t1:
//   ε(t) = σ₀·J(t) for t ≤ t1
//   ε(t) = σ₀·J(t) − σ₀·J(t−t1) for t > t1

function creepAtTime(model, t, sigma0) {
  if (t <= 0) {
    const z0 = impedance(model, 1e12);
    return z0 === 0 ? 0 : sigma0 / z0;
  }
  return inverseLaplace((s) => {
    const z = impedance(model, s);
    return z === 0 ? 1e30 : sigma0 / (s * z);
  }, t);
}

function relaxAtTime(model, t, eps0) {
  if (t <= 0) {
    const z0 = impedance(model, 1e12);
    return eps0 * z0;
  }
  return inverseLaplace((s) => {
    return (eps0 * impedance(model, s)) / s;
  }, t);
}

// Instant elastic response: Z at s→∞ gives the glassy (instantaneous) modulus
function instantElasticStrain(model, sigma0) {
  const zInf = impedance(model, 1e15);
  return zInf === 0 ? 0 : sigma0 / zInf;
}

function instantElasticStress(model, eps0) {
  const zInf = impedance(model, 1e15);
  return eps0 * zInf;
}

function computeCreep(model, tMax, nPoints, sigma0, tRemoval) {
  const data = [];
  // If tRemoval is set, ensure we have a point exactly at tRemoval
  // and compute the instant elastic recovery analytically
  const instantDrop = instantElasticStrain(model, sigma0);
  
  for (let i = 0; i <= nPoints; i++) {
    const t = (i / nPoints) * tMax;
    
    // Inject exact points at tRemoval
    if (tRemoval != null && i > 0) {
      const tPrev = ((i - 1) / nPoints) * tMax;
      if (tPrev < tRemoval && t >= tRemoval) {
        // Value just before removal
        const valBefore = creepAtTime(model, tRemoval, sigma0);
        data.push({ t: parseFloat(tRemoval.toFixed(6)), value: parseFloat(valBefore.toFixed(6)), load: sigma0 });
        // Instant elastic recovery: subtract the instantaneous elastic strain
        const valAfter = valBefore - instantDrop;
        data.push({ t: parseFloat(tRemoval.toFixed(6)), value: parseFloat(valAfter.toFixed(6)), load: 0 });
        if (Math.abs(t - tRemoval) < (tMax / nPoints) * 0.5) continue;
      }
    }
    
    let val;
    if (tRemoval != null && t > tRemoval) {
      val = creepAtTime(model, t, sigma0) - creepAtTime(model, t - tRemoval, sigma0);
    } else {
      val = creepAtTime(model, t, sigma0);
    }
    data.push({
      t: parseFloat(t.toFixed(6)),
      value: parseFloat(val.toFixed(6)),
      load: (tRemoval != null && t > tRemoval) ? 0 : sigma0,
    });
  }
  return data;
}

function computeRelaxation(model, tMax, nPoints, eps0, tRemoval) {
  const data = [];
  const instantDrop = instantElasticStress(model, eps0);
  
  for (let i = 0; i <= nPoints; i++) {
    const t = (i / nPoints) * tMax;
    
    if (tRemoval != null && i > 0) {
      const tPrev = ((i - 1) / nPoints) * tMax;
      if (tPrev < tRemoval && t >= tRemoval) {
        const valBefore = relaxAtTime(model, tRemoval, eps0);
        data.push({ t: parseFloat(tRemoval.toFixed(6)), value: parseFloat(valBefore.toFixed(6)), load: eps0 });
        const valAfter = valBefore - instantDrop;
        data.push({ t: parseFloat(tRemoval.toFixed(6)), value: parseFloat(valAfter.toFixed(6)), load: 0 });
        if (Math.abs(t - tRemoval) < (tMax / nPoints) * 0.5) continue;
      }
    }
    
    let val;
    if (tRemoval != null && t > tRemoval) {
      val = relaxAtTime(model, t, eps0) - relaxAtTime(model, t - tRemoval, eps0);
    } else {
      val = relaxAtTime(model, t, eps0);
    }
    data.push({
      t: parseFloat(t.toFixed(6)),
      value: parseFloat(val.toFixed(6)),
      load: (tRemoval != null && t > tRemoval) ? 0 : eps0,
    });
  }
  return data;
}

// ─── Preset models ──────────────────────────────────────────────────────────
const PRESETS = {
  maxwell: {
    name: "Maxwell",
    model: { type: "series", id: "root", children: [
      { type: "spring", id: "s1", E: 100 },
      { type: "dashpot", id: "d1", eta: 50 },
    ]},
  },
  voigt: {
    name: "Voigt (Kelvin)",
    model: { type: "parallel", id: "root", children: [
      { type: "spring", id: "s1", E: 100 },
      { type: "dashpot", id: "d1", eta: 50 },
    ]},
  },
  "std-3-maxwell": {
    name: "Standard Linear Solid (3-elem Maxwell)",
    model: { type: "parallel", id: "root", children: [
      { type: "spring", id: "s1", E: 60 },
      { type: "series", id: "arm", children: [
        { type: "spring", id: "s2", E: 100 },
        { type: "dashpot", id: "d1", eta: 50 },
      ]},
    ]},
  },
  "std-3-voigt": {
    name: "Standard Linear Solid (3-elem Voigt)",
    model: { type: "series", id: "root", children: [
      { type: "spring", id: "s1", E: 100 },
      { type: "parallel", id: "arm", children: [
        { type: "spring", id: "s2", E: 60 },
        { type: "dashpot", id: "d1", eta: 50 },
      ]},
    ]},
  },
  burgers: {
    name: "Burgers (4-element)",
    model: { type: "series", id: "root", children: [
      { type: "spring", id: "s1", E: 100 },
      { type: "dashpot", id: "d1", eta: 200 },
      { type: "parallel", id: "kv", children: [
        { type: "spring", id: "s2", E: 80 },
        { type: "dashpot", id: "d2", eta: 40 },
      ]},
    ]},
  },
  "gen-maxwell": {
    name: "Generalized Maxwell (Prony)",
    model: { type: "parallel", id: "root", children: [
      { type: "spring", id: "s_eq", E: 30 },
      { type: "series", id: "arm1", children: [
        { type: "spring", id: "s1", E: 80 },
        { type: "dashpot", id: "d1", eta: 40 },
      ]},
      { type: "series", id: "arm2", children: [
        { type: "spring", id: "s2", E: 50 },
        { type: "dashpot", id: "d2", eta: 120 },
      ]},
    ]},
  },
};

// ─── ID generator ───────────────────────────────────────────────────────────
let _idCounter = 100;
function genId() { return "n" + (_idCounter++); }

// ─── Deep clone with new IDs ───────────────────────────────────────────────
function cloneModel(node) {
  const n = { ...node, id: genId() };
  if (n.children) n.children = n.children.map(cloneModel);
  return n;
}

// ─── Tree manipulation helpers ──────────────────────────────────────────────
function updateNode(tree, id, updater) {
  if (tree.id === id) return updater(tree);
  if (tree.children) {
    return { ...tree, children: tree.children.map((c) => updateNode(c, id, updater)) };
  }
  return tree;
}

function removeNode(tree, id) {
  if (tree.id === id) return null;
  if (tree.children) {
    const newChildren = tree.children.map((c) => removeNode(c, id)).filter(Boolean);
    return { ...tree, children: newChildren };
  }
  return tree;
}

function addChild(tree, parentId, child) {
  if (tree.id === parentId && tree.children) {
    return { ...tree, children: [...tree.children, child] };
  }
  if (tree.children) {
    return { ...tree, children: tree.children.map((c) => addChild(c, parentId, child)) };
  }
  return tree;
}

// ─── Schematic Drawing (SVG) ────────────────────────────────────────────────
const ELEM_W = 64;
const ELEM_H = 56;
const GAP = 12;
const WIRE = 20;

function measureNode(node) {
  if (node.type === "spring" || node.type === "dashpot") {
    return { w: ELEM_W + WIRE * 2, h: ELEM_H };
  }
  if (node.type === "series") {
    let w = WIRE;
    let maxH = 0;
    for (const c of node.children) {
      const m = measureNode(c);
      w += m.w;
      maxH = Math.max(maxH, m.h);
    }
    w += WIRE;
    return { w, h: maxH };
  }
  if (node.type === "parallel") {
    let maxW = 0;
    let totalH = 0;
    for (let i = 0; i < node.children.length; i++) {
      const m = measureNode(node.children[i]);
      maxW = Math.max(maxW, m.w);
      totalH += m.h;
      if (i > 0) totalH += GAP;
    }
    return { w: maxW + WIRE * 2 + 16, h: totalH };
  }
  return { w: 0, h: 0 };
}

function drawSpring(x, y, w, h, node, selectedId, onSelect) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const sw = ELEM_W * 0.7;
  const sh = ELEM_H * 0.35;
  const x0 = cx - sw / 2;
  const isSel = selectedId === node.id;
  const n = 5;
  const segW = sw / n;
  let path = `M ${x} ${cy} L ${x0} ${cy}`;
  for (let i = 0; i < n; i++) {
    const sx = x0 + i * segW;
    path += ` L ${sx + segW * 0.25} ${cy - sh}`;
    path += ` L ${sx + segW * 0.75} ${cy + sh}`;
    path += ` L ${sx + segW} ${cy}`;
  }
  path += ` L ${x + w} ${cy}`;
  return [
    <g key={node.id} onClick={(e) => { e.stopPropagation(); onSelect(node.id); }} style={{ cursor: "pointer" }}>
      <rect x={x + WIRE} y={cy - ELEM_H / 2} width={ELEM_W} height={ELEM_H} fill={isSel ? "rgba(59,130,246,0.08)" : "transparent"} stroke={isSel ? "#3b82f6" : "transparent"} strokeWidth={2} rx={6} />
      <path d={path} fill="none" stroke={isSel ? "#3b82f6" : "#b8543f"} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
      <text x={cx} y={cy - ELEM_H / 2 + 2} textAnchor="middle" fontSize="10" fill="#94785a" fontFamily="'DM Mono', monospace" fontWeight={600}>E={node.E}</text>
    </g>
  ];
}

function drawDashpot(x, y, w, h, node, selectedId, onSelect) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dw = ELEM_W * 0.32;
  const dh = ELEM_H * 0.38;
  const isSel = selectedId === node.id;
  const col = isSel ? "#3b82f6" : "#5b7a6a";
  // Standard dashpot: left wire → piston rod → [piston plate inside cylinder] → cylinder base → right wire
  // All connections at cy (centerline)
  const cylLeft = cx - dw / 2;
  const cylRight = cx + dw / 2;
  return [
    <g key={node.id} onClick={(e) => { e.stopPropagation(); onSelect(node.id); }} style={{ cursor: "pointer" }}>
      <rect x={x + WIRE} y={cy - ELEM_H / 2} width={ELEM_W} height={ELEM_H} fill={isSel ? "rgba(59,130,246,0.08)" : "transparent"} stroke={isSel ? "#3b82f6" : "transparent"} strokeWidth={2} rx={6} />
      {/* Left wire from edge to piston rod */}
      <line x1={x} y1={cy} x2={cylLeft} y2={cy} stroke={col} strokeWidth={2.2} />
      {/* Piston plate (vertical line inside cylinder) */}
      <line x1={cylLeft} y1={cy - dh} x2={cylLeft} y2={cy + dh} stroke={col} strokeWidth={2.5} strokeLinecap="round" />
      {/* Cylinder: open on left, closed on right — U shape open left */}
      <line x1={cylRight} y1={cy - dh} x2={cx - dw * 0.1} y2={cy - dh} stroke={col} strokeWidth={2.2} />
      <line x1={cylRight} y1={cy + dh} x2={cx - dw * 0.1} y2={cy + dh} stroke={col} strokeWidth={2.2} />
      <line x1={cylRight} y1={cy - dh} x2={cylRight} y2={cy + dh} stroke={col} strokeWidth={2.2} />
      {/* Right wire from cylinder to edge */}
      <line x1={cylRight} y1={cy} x2={x + w} y2={cy} stroke={col} strokeWidth={2.2} />
      {/* Label above */}
      <text x={cx} y={cy - ELEM_H / 2 + 2} textAnchor="middle" fontSize="10" fill="#5a7868" fontFamily="'DM Mono', monospace" fontWeight={600}>η={node.eta}</text>
    </g>
  ];
}

function drawNode(node, x, y, availW, availH, selectedId, onSelect) {
  if (node.type === "spring") return drawSpring(x, y, availW, availH, node, selectedId, onSelect);
  if (node.type === "dashpot") return drawDashpot(x, y, availW, availH, node, selectedId, onSelect);

  let elements = [];
  const m = measureNode(node);

  if (node.type === "series") {
    let cx = x + WIRE;
    const cy = y + availH / 2;
    elements.push(<line key={node.id + "_wl"} x1={x} y1={cy} x2={x + WIRE} y2={cy} stroke="#555" strokeWidth={1.5} />);
    for (const child of node.children) {
      const cm = measureNode(child);
      const childElems = drawNode(child, cx, y + (availH - cm.h) / 2, cm.w, cm.h, selectedId, onSelect);
      elements = elements.concat(childElems);
      cx += cm.w;
    }
    elements.push(<line key={node.id + "_wr"} x1={cx} y1={cy} x2={cx + WIRE} y2={cy} stroke="#555" strokeWidth={1.5} />);
  }

  if (node.type === "parallel") {
    const innerW = m.w - WIRE * 2 - 16;
    const cxStart = x + 8 + WIRE;
    let cy = y;
    const juncL = x + 8;  // left junction x (where vertical split happens)
    const juncR = x + m.w - 8;  // right junction x (where vertical merge happens)
    const juncY = y + m.h / 2;  // center y for lead wires

    // Collect child midY positions for vertical bus sizing
    const childMidYs = [];
    let tempCy = y;
    for (let i = 0; i < node.children.length; i++) {
      const cm = measureNode(node.children[i]);
      childMidYs.push(tempCy + cm.h / 2);
      tempCy += cm.h + GAP;
    }

    // Draw children and their horizontal connections
    cy = y;
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const cm = measureNode(child);
      const childX = cxStart + (innerW - cm.w) / 2;
      const childElems = drawNode(child, childX, cy, cm.w, cm.h, selectedId, onSelect);
      elements = elements.concat(childElems);
      const childMidY = childMidYs[i];
      // Horizontal wire from left bus to child
      elements.push(<line key={node.id + "_pl" + i} x1={juncL} y1={childMidY} x2={childX} y2={childMidY} stroke="#555" strokeWidth={1.5} />);
      // Horizontal wire from child to right bus
      elements.push(<line key={node.id + "_pr" + i} x1={childX + cm.w} y1={childMidY} x2={juncR} y2={childMidY} stroke="#555" strokeWidth={1.5} />);
      cy += cm.h + GAP;
    }

    // Vertical bus lines connecting all branches
    const topY = childMidYs[0];
    const botY = childMidYs[childMidYs.length - 1];
    elements.push(<line key={node.id + "_busl"} x1={juncL} y1={topY} x2={juncL} y2={botY} stroke="#555" strokeWidth={1.5} />);
    elements.push(<line key={node.id + "_busr"} x1={juncR} y1={topY} x2={juncR} y2={botY} stroke="#555" strokeWidth={1.5} />);

    // Lead wires from outer edges to the junction, at the vertical center
    elements.push(<line key={node.id + "_wl"} x1={x} y1={juncY} x2={juncL} y2={juncY} stroke="#555" strokeWidth={1.5} />);
    elements.push(<line key={node.id + "_wr"} x1={juncR} y1={juncY} x2={x + m.w} y2={juncY} stroke="#555" strokeWidth={1.5} />);
  }

  return elements;
}

// ─── Schematic Component ────────────────────────────────────────────────────
function Schematic({ model, selectedId, onSelect }) {
  const m = measureNode(model);
  const pad = 30;
  const w = m.w + pad * 2;
  const h = m.h + pad * 2;
  const elements = drawNode(model, pad, pad, m.w, m.h, selectedId, onSelect);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxHeight: 260, display: "block" }}>
      {elements}
      <circle cx={pad} cy={pad + m.h / 2} r={5} fill="#333" />
      <circle cx={pad + m.w} cy={pad + m.h / 2} r={5} fill="#333" />
    </svg>
  );
}

// ─── Node description helper ────────────────────────────────────────────────
function describeNode(node) {
  if (node.type === "spring") return `Spring (E=${node.E})`;
  if (node.type === "dashpot") return `Dashpot (η=${node.eta})`;
  if (node.type === "series") return "Series group";
  if (node.type === "parallel") return "Parallel group";
  return "";
}

function findNode(tree, id) {
  if (tree.id === id) return tree;
  if (tree.children) {
    for (const c of tree.children) {
      const found = findNode(c, id);
      if (found) return found;
    }
  }
  return null;
}

function findParent(tree, id) {
  if (tree.children) {
    for (const c of tree.children) {
      if (c.id === id) return tree;
      const found = findParent(c, id);
      if (found) return found;
    }
  }
  return null;
}

function countElements(node) {
  if (node.type === "spring" || node.type === "dashpot") return 1;
  if (node.children) return node.children.reduce((a, c) => a + countElements(c), 0);
  return 0;
}

// ─── Known model label detection ─────────────────────────────────────────────
function identifyModel(node) {
  // Flatten to a signature
  function sig(n) {
    if (n.type === "spring") return "S";
    if (n.type === "dashpot") return "D";
    if (n.type === "series") return "ser(" + n.children.map(sig).sort().join(",") + ")";
    if (n.type === "parallel") return "par(" + n.children.map(sig).sort().join(",") + ")";
    return "?";
  }
  const s = sig(node);
  const known = {
    "ser(D,S)": "Maxwell Model",
    "par(D,S)": "Kelvin–Voigt Model",
    "par(S,ser(D,S))": "Standard Linear Solid (Zener / 3-elem Maxwell)",
    "ser(S,par(D,S))": "Standard Linear Solid (3-elem Voigt)",
    "ser(D,S,par(D,S))": "Burgers Model",
    "ser(D,par(D,S),S)": "Burgers Model",
    "ser(S,D,par(D,S))": "Burgers Model",
  };
  return known[s] || null;
}

// ─── Main App ───────────────────────────────────────────────────────────────
export default function App() {
  const [model, setModel] = useState(cloneModel(PRESETS["std-3-maxwell"].model));
  const [selectedId, setSelectedId] = useState(null);
  const [sigma0, setSigma0] = useState(1);
  const [eps0, setEps0] = useState(1);
  const [tMax, setTMax] = useState(10);
  const [tRemoval, setTRemoval] = useState(5);
  const [enableRemoval, setEnableRemoval] = useState(true);
  const [nPoints, setNPoints] = useState(200);
  const [plotData, setPlotData] = useState(null);
  const [activeTab, setActiveTab] = useState("build");
  const [computing, setComputing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const selectedNode = selectedId ? findNode(model, selectedId) : null;
  const parentOfSelected = selectedId ? findParent(model, selectedId) : null;
  const modelName = identifyModel(model);

  const compute = useCallback(() => {
    setComputing(true);
    setTimeout(() => {
      try {
        const rem = enableRemoval ? tRemoval : null;
        const creepData = computeCreep(model, tMax, nPoints, sigma0, rem);
        const relaxData = computeRelaxation(model, tMax, nPoints, eps0, rem);
        setPlotData({ creep: creepData, relax: relaxData });
      } catch (e) {
        console.error(e);
      }
      setComputing(false);
    }, 50);
  }, [model, tMax, nPoints, sigma0, eps0, tRemoval, enableRemoval]);

  // Auto-compute on model change
  useEffect(() => {
    compute();
  }, [compute]);

  const handlePreset = (key) => {
    setModel(cloneModel(PRESETS[key].model));
    setSelectedId(null);
  };

  const handleAddSpring = (parentId) => {
    setModel(addChild(model, parentId, { type: "spring", id: genId(), E: 100 }));
  };
  const handleAddDashpot = (parentId) => {
    setModel(addChild(model, parentId, { type: "dashpot", id: genId(), eta: 50 }));
  };
  const handleAddSeries = (parentId) => {
    setModel(addChild(model, parentId, { type: "series", id: genId(), children: [
      { type: "spring", id: genId(), E: 100 },
      { type: "dashpot", id: genId(), eta: 50 },
    ]}));
  };
  const handleAddParallel = (parentId) => {
    setModel(addChild(model, parentId, { type: "parallel", id: genId(), children: [
      { type: "spring", id: genId(), E: 100 },
      { type: "dashpot", id: genId(), eta: 50 },
    ]}));
  };
  const handleRemove = (id) => {
    if (id === model.id) return; // can't remove root
    const newModel = removeNode(model, id);
    if (newModel) {
      setModel(newModel);
      setSelectedId(null);
    }
  };

  const handleParamChange = (id, key, val) => {
    if (val <= 0) return;
    setModel(updateNode(model, id, (n) => ({ ...n, [key]: val })));
  };

  // Buffered numeric input: allows empty field while typing, applies value on blur or valid input
  function NumericInput({ value, onChange, style: inputStyle, ...rest }) {
    const [buf, setBuf] = useState(String(value));
    const lastApplied = useRef(value);
    // Sync buf when external value changes (e.g. preset load)
    useEffect(() => {
      if (value !== lastApplied.current) {
        setBuf(String(value));
        lastApplied.current = value;
      }
    }, [value]);
    const handleChange = (e) => {
      setBuf(e.target.value);
    };
    const commit = () => {
      const num = parseFloat(buf);
      if (!isNaN(num) && num > 0) {
        lastApplied.current = num;
        onChange(num);
      } else {
        // Revert to last valid value
        setBuf(String(lastApplied.current));
      }
    };
    const handleBlur = () => commit();
    const handleKeyDown = (e) => {
      if (e.key === "Enter") {
        e.target.blur();
      }
    };
    return (
      <input
        type="text"
        inputMode="decimal"
        value={buf}
        onChange={handleChange}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={inputStyle}
        {...rest}
      />
    );
  }

  const inputStyle = { width: 80, padding: "4px 8px", borderRadius: 4, border: "1px solid #3a3628", background: "#0e0d0b", color: "#e8e0d0", fontSize: 13, fontFamily: "'DM Mono', monospace" };
  const wideInputStyle = { ...inputStyle, width: 100 };

  const handleConvertGroup = (id, newType) => {
    setModel(updateNode(model, id, (n) => ({ ...n, type: newType })));
  };

  // Tree view component
  // Small SVG icons for tree view
  function SeriesIcon({ color }) {
    return (
      <svg width="20" height="14" viewBox="0 0 20 14" style={{ flexShrink: 0 }}>
        <line x1="0" y1="7" x2="6" y2="7" stroke={color} strokeWidth={2} />
        <circle cx="8" cy="7" r={2.5} fill="none" stroke={color} strokeWidth={1.5} />
        <line x1="10" y1="7" x2="13" y2="7" stroke={color} strokeWidth={2} />
        <circle cx="15" cy="7" r={2.5} fill="none" stroke={color} strokeWidth={1.5} />
        <line x1="17" y1="7" x2="20" y2="7" stroke={color} strokeWidth={2} />
      </svg>
    );
  }
  function ParallelIcon({ color }) {
    return (
      <svg width="20" height="14" viewBox="0 0 20 14" style={{ flexShrink: 0 }}>
        <line x1="0" y1="7" x2="4" y2="7" stroke={color} strokeWidth={2} />
        <line x1="4" y1="3" x2="4" y2="11" stroke={color} strokeWidth={2} />
        <line x1="4" y1="3" x2="16" y2="3" stroke={color} strokeWidth={1.5} />
        <line x1="4" y1="11" x2="16" y2="11" stroke={color} strokeWidth={1.5} />
        <line x1="16" y1="3" x2="16" y2="11" stroke={color} strokeWidth={2} />
        <line x1="16" y1="7" x2="20" y2="7" stroke={color} strokeWidth={2} />
      </svg>
    );
  }

  function TreeView({ node, depth = 0 }) {
    const isSel = selectedId === node.id;
    const isGroup = node.type === "series" || node.type === "parallel";
    const dotColor = node.type === "spring" ? "#b8543f" : node.type === "dashpot" ? "#5b7a6a" : null;
    const labelText = node.type === "spring" ? `Spring  E = ${node.E}`
      : node.type === "dashpot" ? `Dashpot  η = ${node.eta}`
      : node.type === "series" ? "Series"
      : "Parallel";
    const groupColor = isSel ? "#a8c7fa" : "#8a8272";
    return (
      <div style={{ marginLeft: depth * 16 }}>
        <div
          onClick={(e) => { e.stopPropagation(); setSelectedId(node.id); }}
          style={{
            padding: "5px 10px",
            margin: "2px 0",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "'DM Mono', monospace",
            background: isSel ? "#2a3040" : "transparent",
            color: isSel ? "#a8c7fa" : "#c0b8a8",
            border: isSel ? "1px solid #3b5278" : "1px solid transparent",
            transition: "all 0.15s",
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          {dotColor && <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />}
          {node.type === "series" && <SeriesIcon color={groupColor} />}
          {node.type === "parallel" && <ParallelIcon color={groupColor} />}
          {labelText}
        </div>
        {isGroup && node.children.map((c) => <TreeView key={c.id} node={c} depth={depth + 1} />)}
      </div>
    );
  }

  const tabStyle = (tab) => ({
    padding: "8px 20px",
    border: "none",
    borderBottom: activeTab === tab ? "2px solid #a8c7fa" : "2px solid transparent",
    background: "transparent",
    color: activeTab === tab ? "#a8c7fa" : "#7a7466",
    cursor: "pointer",
    fontSize: 13,
    fontFamily: "'DM Mono', monospace",
    fontWeight: 600,
    letterSpacing: 1,
    textTransform: "uppercase",
  });

  const btnStyle = {
    padding: "5px 12px",
    borderRadius: 6,
    border: "1px solid #3a3628",
    background: "#23201a",
    color: "#c0b8a8",
    cursor: "pointer",
    fontSize: 12,
    fontFamily: "'DM Mono', monospace",
    transition: "all 0.15s",
  };

  const dangerBtn = { ...btnStyle, borderColor: "#5a2020", color: "#e88" };

  return (
    <div style={{
      minHeight: "100vh",
      background: "#141210",
      color: "#c0b8a8",
      fontFamily: "'Source Serif 4', 'Georgia', serif",
      padding: 0,
      margin: 0,
    }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Source+Serif+4:ital,opsz,wght@0,8..60,300..900;1,8..60,300..900&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{
        borderBottom: "1px solid #2a2720",
        padding: "16px 32px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        {/* Logo: spring + dashpot mini icon */}
        <svg width="36" height="24" viewBox="0 0 36 24" style={{ flexShrink: 0 }}>
          {/* Spring */}
          <path d="M 1 12 L 3 12 L 4.5 5 L 7.5 19 L 10.5 5 L 13.5 19 L 15 12 L 17 12" fill="none" stroke="#b8543f" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
          {/* Dashpot */}
          <line x1="19" y1="12" x2="24" y2="12" stroke="#5b7a6a" strokeWidth={1.8} />
          <line x1="24" y1="6" x2="24" y2="18" stroke="#5b7a6a" strokeWidth={2} strokeLinecap="round" />
          <line x1="28" y1="6" x2="26" y2="6" stroke="#5b7a6a" strokeWidth={1.8} />
          <line x1="28" y1="18" x2="26" y2="18" stroke="#5b7a6a" strokeWidth={1.8} />
          <line x1="28" y1="6" x2="28" y2="18" stroke="#5b7a6a" strokeWidth={1.8} />
          <line x1="28" y1="12" x2="35" y2="12" stroke="#5b7a6a" strokeWidth={1.8} />
        </svg>
        <h1 style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 700,
          color: "#e8e0d0",
          letterSpacing: -0.5,
        }}>
          Viscoelastic Model Builder
        </h1>
        {modelName && (
          <span style={{
            fontSize: 13,
            fontFamily: "'DM Mono', monospace",
            color: "#6a9f7a",
            background: "#1a2a1e",
            padding: "3px 10px",
            borderRadius: 20,
            border: "1px solid #2a3a2e",
          }}>
            {modelName}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: "#5a5444", fontFamily: "'DM Mono', monospace", marginRight: 8 }}>
          {countElements(model)} elements
        </span>
        <button
          onClick={() => setShowInfo(true)}
          style={{
            width: 28, height: 28, borderRadius: "50%",
            border: "1px solid #3a3628", background: "#23201a",
            color: "#a8c7fa", cursor: "pointer",
            fontSize: 15, fontWeight: 700, fontFamily: "'DM Mono', monospace",
            display: "flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1,
          }}
          title="About this tool"
        >?</button>
        <span style={{ fontSize: 11, color: "#5a5444", fontFamily: "'DM Mono', monospace", marginLeft: 4 }}>
          by <a href="https://egemenokte.com" target="_blank" rel="noopener noreferrer" style={{ color: "#7a8a9a", textDecoration: "none", borderBottom: "1px solid #3a3628" }}>Egemen Okte</a>
        </span>
      </div>

      {/* Info Modal */}
      {showInfo && (
        <div style={{
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.65)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }} onClick={() => setShowInfo(false)}>
          <div style={{
            background: "#1c1a16", border: "1px solid #2a2720", borderRadius: 12,
            padding: "28px 32px", maxWidth: 520, width: "90%",
            maxHeight: "80vh", overflow: "auto",
            color: "#c0b8a8", fontFamily: "'Source Serif 4', Georgia, serif",
            fontSize: 14, lineHeight: 1.7,
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18, color: "#e8e0d0" }}>About This Tool</h2>
              <button onClick={() => setShowInfo(false)} style={{ background: "none", border: "none", color: "#7a7466", fontSize: 20, cursor: "pointer", padding: "0 4px" }}>&times;</button>
            </div>
            <p style={{ margin: "0 0 12px 0" }}>
              This interactive tool lets you build arbitrary viscoelastic rheological models by combining springs (elastic elements) and dashpots (viscous elements) in series and parallel arrangements. It then computes and plots both the <strong style={{ color: "#b8543f" }}>creep response</strong> (strain under constant stress) and <strong style={{ color: "#5b8a6a" }}>relaxation response</strong> (stress under constant strain).
            </p>
            <p style={{ margin: "0 0 12px 0" }}>
              <strong style={{ color: "#e8e0d0" }}>How it works:</strong> Each element is treated as a mechanical impedance in the Laplace domain. A spring has impedance Z(s) = E, and a dashpot has Z(s) = ηs. Series elements combine like parallel resistors (compliances add) and parallel elements combine like series resistors (impedances add). The time-domain response is recovered via numerical inverse Laplace transform using the Stehfest algorithm.
            </p>
            <p style={{ margin: "0 0 12px 0" }}>
              <strong style={{ color: "#e8e0d0" }}>Load removal and recovery:</strong> When enabled, the tool uses the Boltzmann superposition principle to simulate what happens after the load is removed at a given time t₁. It superimposes a negative step at t₁ onto the original response, so the total response for t {">"} t₁ becomes R(t) minus R(t - t₁). This reveals whether the material recovers fully, partially, or not at all.
            </p>
            <p style={{ margin: "0 0 12px 0" }}>
              <strong style={{ color: "#e8e0d0" }}>How to use:</strong>
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              1. Pick a preset from the <em>Presets</em> tab or build your own model in the <em>Build</em> tab.
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              2. Click any element in the schematic or tree to select it. You can edit its properties, add children to groups, remove elements, or convert groups between series and parallel.
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              3. Adjust loading magnitudes, time range, and load removal settings in the <em>Params</em> tab. Values are applied when you press Enter or click away from the input field.
            </p>
            <p style={{ margin: "0 0 6px 0" }}>
              4. The creep and relaxation curves update automatically as you modify the model.
            </p>
            <p style={{ margin: "16px 0 0 0", fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#5a5444" }}>
              This approach generalizes classic models (Maxwell, Kelvin-Voigt, Standard Linear Solid, Burgers, generalized Prony series) to handle any tree-structured spring-dashpot network.
            </p>
          </div>
        </div>
      )}

      <div style={{ display: "flex", height: "calc(100vh - 62px)" }}>
        {/* Left panel */}
        <div style={{
          width: 320,
          minWidth: 320,
          borderRight: "1px solid #2a2720",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Tabs */}
          <div style={{ display: "flex", borderBottom: "1px solid #2a2720" }}>
            <button style={tabStyle("build")} onClick={() => setActiveTab("build")}>Build</button>
            <button style={tabStyle("presets")} onClick={() => setActiveTab("presets")}>Presets</button>
            <button style={tabStyle("params")} onClick={() => setActiveTab("params")}>Params</button>
          </div>

          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            {activeTab === "presets" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <p style={{ fontSize: 12, color: "#7a7466", margin: "0 0 8px 0", fontFamily: "'DM Mono', monospace" }}>Load a classic model:</p>
                {Object.entries(PRESETS).map(([k, v]) => (
                  <button key={k} style={{ ...btnStyle, textAlign: "left", padding: "8px 14px" }} onClick={() => handlePreset(k)}>
                    {v.name}
                  </button>
                ))}
              </div>
            )}

            {activeTab === "build" && (
              <div>
                <p style={{ fontSize: 12, color: "#7a7466", margin: "0 0 12px 0", fontFamily: "'DM Mono', monospace" }}>
                  Click an element in the schematic or tree to select it. Add/remove elements from groups.
                </p>
                <TreeView node={model} />
                {selectedNode && (
                  <div style={{ marginTop: 16, padding: 12, background: "#1c1a16", borderRadius: 8, border: "1px solid #2a2720" }}>
                    <div style={{ fontSize: 13, fontFamily: "'DM Mono', monospace", color: "#a8c7fa", marginBottom: 10 }}>
                      {describeNode(selectedNode)}
                    </div>

                    {selectedNode.type === "spring" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466" }}>E =</label>
                        <NumericInput
                          key={selectedId + "_E"}
                          value={selectedNode.E}
                          onChange={(v) => handleParamChange(selectedId, "E", v)}
                          style={inputStyle}
                        />
                      </div>
                    )}
                    {selectedNode.type === "dashpot" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466" }}>η =</label>
                        <NumericInput
                          key={selectedId + "_eta"}
                          value={selectedNode.eta}
                          onChange={(v) => handleParamChange(selectedId, "eta", v)}
                          style={inputStyle}
                        />
                      </div>
                    )}
                    {(selectedNode.type === "series" || selectedNode.type === "parallel") && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button style={btnStyle} onClick={() => handleAddSpring(selectedId)}>+ Spring</button>
                          <button style={btnStyle} onClick={() => handleAddDashpot(selectedId)}>+ Dashpot</button>
                        </div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button style={btnStyle} onClick={() => handleAddSeries(selectedId)}>+ Series arm</button>
                          <button style={btnStyle} onClick={() => handleAddParallel(selectedId)}>+ Parallel arm</button>
                        </div>
                        <div style={{ marginTop: 6 }}>
                          <button style={btnStyle} onClick={() => handleConvertGroup(selectedId, selectedNode.type === "series" ? "parallel" : "series")}>
                            ↔ Convert to {selectedNode.type === "series" ? "Parallel" : "Series"}
                          </button>
                        </div>
                      </div>
                    )}
                    {selectedId !== model.id && (
                      <button style={{ ...dangerBtn, marginTop: 10 }} onClick={() => handleRemove(selectedId)}>
                        ✕ Remove
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === "params" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <p style={{ fontSize: 12, color: "#7a7466", margin: 0, fontFamily: "'DM Mono', monospace" }}>Loading & simulation parameters</p>
                <div>
                  <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466", display: "block", marginBottom: 4 }}>σ₀ (creep stress)</label>
                  <NumericInput value={sigma0} onChange={setSigma0} style={wideInputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466", display: "block", marginBottom: 4 }}>ε₀ (relaxation strain)</label>
                  <NumericInput value={eps0} onChange={setEps0} style={wideInputStyle} />
                </div>
                <div>
                  <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466", display: "block", marginBottom: 4 }}>t_max (time range)</label>
                  <NumericInput value={tMax} onChange={setTMax} style={wideInputStyle} />
                </div>
                <div style={{ padding: "10px 0 4px 0", borderTop: "1px solid #2a2720" }}>
                  <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#a8c7fa", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <input type="checkbox" checked={enableRemoval} onChange={(e) => setEnableRemoval(e.target.checked)}
                      style={{ accentColor: "#a8c7fa" }} />
                    Load removal &amp; recovery
                  </label>
                </div>
                {enableRemoval && (
                  <div>
                    <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466", display: "block", marginBottom: 4 }}>t_removal (load removed at)</label>
                    <NumericInput value={tRemoval} onChange={setTRemoval} style={wideInputStyle} />
                  </div>
                )}
                <div>
                  <label style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: "#7a7466", display: "block", marginBottom: 4 }}>Resolution (points)</label>
                  <NumericInput value={nPoints} onChange={(v) => setNPoints(Math.round(v))} style={wideInputStyle} />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Main area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "auto" }}>
          {/* Schematic */}
          <div style={{
            padding: "16px 32px",
            borderBottom: "1px solid #2a2720",
            background: "#18160f",
          }}>
            <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#5a5444", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
              Rheological Schematic
            </div>
            <Schematic model={model} selectedId={selectedId} onSelect={setSelectedId} />
          </div>

          {/* Plots */}
          <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "16px 32px", gap: 16 }}>
            {computing && (
              <div style={{ textAlign: "center", padding: 30, color: "#7a7466", fontFamily: "'DM Mono', monospace", fontSize: 13 }}>
                Computing...
              </div>
            )}
            {plotData && !computing && (
              <>
                {/* Creep */}
                <div style={{ flex: 1, minHeight: 280 }}>
                  <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#5a5444", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                    Creep Response — ε(t) at σ₀ = {sigma0}{enableRemoval ? `, load removed at t = ${tRemoval}` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 0 }}>
                    <div style={{ flex: 1 }}>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={plotData.creep} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                          <CartesianGrid stroke="#2a2720" strokeDasharray="3 3" />
                          <XAxis dataKey="t" type="number" domain={[0, "auto"]} stroke="#5a5444" tick={{ fontSize: 11, fontFamily: "'DM Mono', monospace" }} label={{ value: "t", position: "insideBottomRight", offset: -5, style: { fontSize: 12, fill: "#7a7466" } }} />
                          <YAxis stroke="#5a5444" tick={{ fontSize: 11, fontFamily: "'DM Mono', monospace" }} label={{ value: "ε(t)", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 12, fill: "#7a7466" } }} />
                          <Tooltip
                            contentStyle={{ background: "#1c1a16", border: "1px solid #2a2720", borderRadius: 6, fontSize: 12, fontFamily: "'DM Mono', monospace" }}
                            labelStyle={{ color: "#7a7466" }}
                            labelFormatter={(val) => `t = ${parseFloat(val).toFixed(4)}`}
                            formatter={(value, name) => [parseFloat(value).toFixed(4), name]}
                          />
                          {enableRemoval && <ReferenceLine x={tRemoval} stroke="#a8c7fa" strokeDasharray="6 3" strokeWidth={1.5} label={{ value: "unload", position: "top", fill: "#a8c7fa", fontSize: 10, fontFamily: "'DM Mono', monospace" }} />}
                          <Line type="monotone" dataKey="value" stroke="#b8543f" strokeWidth={2.5} dot={false} name="ε(t)" />
                        </LineChart>
                      </ResponsiveContainer>
                      {/* Loading profile mini-chart */}
                      <ResponsiveContainer width="100%" height={60}>
                        <LineChart data={plotData.creep} margin={{ top: 2, right: 20, left: 10, bottom: 5 }}>
                          <XAxis dataKey="t" type="number" domain={[0, "auto"]} stroke="#5a5444" tick={{ fontSize: 9, fontFamily: "'DM Mono', monospace" }} />
                          <YAxis stroke="#5a5444" tick={{ fontSize: 9, fontFamily: "'DM Mono', monospace" }} domain={[0, 'auto']} label={{ value: "σ", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 10, fill: "#7a7466" } }} />
                          {enableRemoval && <ReferenceLine x={tRemoval} stroke="#a8c7fa" strokeDasharray="4 2" strokeWidth={1} />}
                          <Line type="stepAfter" dataKey="load" stroke="#7a7466" strokeWidth={1.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                {/* Relaxation */}
                <div style={{ flex: 1, minHeight: 280 }}>
                  <div style={{ fontSize: 11, fontFamily: "'DM Mono', monospace", color: "#5a5444", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                    Relaxation Response — σ(t) at ε₀ = {eps0}{enableRemoval ? `, load removed at t = ${tRemoval}` : ""}
                  </div>
                  <div style={{ display: "flex", gap: 0 }}>
                    <div style={{ flex: 1 }}>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={plotData.relax} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                          <CartesianGrid stroke="#2a2720" strokeDasharray="3 3" />
                          <XAxis dataKey="t" type="number" domain={[0, "auto"]} stroke="#5a5444" tick={{ fontSize: 11, fontFamily: "'DM Mono', monospace" }} label={{ value: "t", position: "insideBottomRight", offset: -5, style: { fontSize: 12, fill: "#7a7466" } }} />
                          <YAxis stroke="#5a5444" tick={{ fontSize: 11, fontFamily: "'DM Mono', monospace" }} label={{ value: "σ(t)", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 12, fill: "#7a7466" } }} />
                          <Tooltip
                            contentStyle={{ background: "#1c1a16", border: "1px solid #2a2720", borderRadius: 6, fontSize: 12, fontFamily: "'DM Mono', monospace" }}
                            labelStyle={{ color: "#7a7466" }}
                            labelFormatter={(val) => `t = ${parseFloat(val).toFixed(4)}`}
                            formatter={(value, name) => [parseFloat(value).toFixed(4), name]}
                          />
                          {enableRemoval && <ReferenceLine x={tRemoval} stroke="#a8c7fa" strokeDasharray="6 3" strokeWidth={1.5} label={{ value: "unload", position: "top", fill: "#a8c7fa", fontSize: 10, fontFamily: "'DM Mono', monospace" }} />}
                          <Line type="monotone" dataKey="value" stroke="#5b8a6a" strokeWidth={2.5} dot={false} name="σ(t)" />
                        </LineChart>
                      </ResponsiveContainer>
                      {/* Loading profile mini-chart */}
                      <ResponsiveContainer width="100%" height={60}>
                        <LineChart data={plotData.relax} margin={{ top: 2, right: 20, left: 10, bottom: 5 }}>
                          <XAxis dataKey="t" type="number" domain={[0, "auto"]} stroke="#5a5444" tick={{ fontSize: 9, fontFamily: "'DM Mono', monospace" }} />
                          <YAxis stroke="#5a5444" tick={{ fontSize: 9, fontFamily: "'DM Mono', monospace" }} domain={[0, 'auto']} label={{ value: "ε", angle: -90, position: "insideLeft", offset: 10, style: { fontSize: 10, fill: "#7a7466" } }} />
                          {enableRemoval && <ReferenceLine x={tRemoval} stroke="#a8c7fa" strokeDasharray="4 2" strokeWidth={1} />}
                          <Line type="stepAfter" dataKey="load" stroke="#7a7466" strokeWidth={1.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
