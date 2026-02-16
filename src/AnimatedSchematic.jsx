import { useState, useEffect, useRef, useMemo } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const ELEM_W = 64;
const ELEM_H = 56;
const GAP = 12;
const WIRE = 20;
const WALL_W = 14;
const PAD = 30;
const MAX_STRETCH_PX = 28;
const PRE_LOAD_FRAMES = 8; // idle frames before t=0

// ─── Compute max absolute element strain across all frames ──────────────────
function computeMaxElementStrain(data) {
    let mx = 0.0001;
    if (!data) return mx;
    for (const pt of data) {
        if (!pt.elementStrains) continue;
        for (const id of Object.keys(pt.elementStrains)) {
            mx = Math.max(mx, Math.abs(pt.elementStrains[id]));
        }
    }
    return mx;
}

// ─── Convert element strains to pixel stretches ─────────────────────────────
function strainsToPixels(elementStrains, maxStrain) {
    if (!elementStrains) return null;
    const result = {};
    for (const [id, val] of Object.entries(elementStrains)) {
        result[id] = (val / maxStrain) * MAX_STRETCH_PX;
    }
    return result;
}

// ─── Measure node at REST (no stretch) ──────────────────────────────────────
function measureNodeRest(node) {
    if (node.type === "spring" || node.type === "dashpot") {
        return { w: ELEM_W + WIRE * 2, h: ELEM_H };
    }
    if (node.type === "series") {
        let w = WIRE;
        let maxH = 0;
        for (const c of node.children) {
            const m = measureNodeRest(c);
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
            const m = measureNodeRest(node.children[i]);
            maxW = Math.max(maxW, m.w);
            totalH += m.h;
            if (i > 0) totalH += GAP;
        }
        return { w: maxW + WIRE * 2 + 16, h: totalH };
    }
    return { w: 0, h: 0 };
}

// ─── Measure node with stretch ──────────────────────────────────────────────
function measureNode(node, stretchPx) {
    const s = stretchPx ? (stretchPx[node.id] || 0) : 0;
    if (node.type === "spring" || node.type === "dashpot") {
        return { w: ELEM_W + WIRE * 2 + s, h: ELEM_H };
    }
    if (node.type === "series") {
        let w = WIRE;
        let maxH = 0;
        for (const c of node.children) {
            const m = measureNode(c, stretchPx);
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
            const m = measureNode(node.children[i], stretchPx);
            maxW = Math.max(maxW, m.w);
            totalH += m.h;
            if (i > 0) totalH += GAP;
        }
        return { w: maxW + WIRE * 2 + 16, h: totalH };
    }
    return { w: 0, h: 0 };
}

// ─── Draw spring ────────────────────────────────────────────────────────────
function drawSpring(x, y, w, h, node, stretch, showRef) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const baseW = ELEM_W * 0.7;
    const sw = baseW + stretch * 0.7;
    const sh = ELEM_H * 0.35;
    const x0 = cx - sw / 2;
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

    // Reference dashed lines: show rest-width boundaries at current element position
    const refElems = [];
    if (showRef) {
        const restW = ELEM_W + WIRE * 2;
        // Left boundary at element start
        refElems.push(
            <line key={node.id + "_refL"} x1={x} y1={cy - ELEM_H / 2 + 4} x2={x} y2={cy + ELEM_H / 2 - 4}
                stroke="#b8543f" strokeWidth={1} strokeDasharray="3 2" opacity={0.45} />
        );
        // Right boundary at rest width from start
        refElems.push(
            <line key={node.id + "_refR"} x1={x + restW} y1={cy - ELEM_H / 2 + 4} x2={x + restW} y2={cy + ELEM_H / 2 - 4}
                stroke="#b8543f" strokeWidth={1} strokeDasharray="3 2" opacity={0.45} />
        );
    }

    return (
        <g key={node.id}>
            {refElems}
            <path d={path} fill="none" stroke="#b8543f" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
            <text x={cx} y={cy - ELEM_H / 2 + 2} textAnchor="middle" fontSize="10" fill="#94785a"
                fontFamily="'DM Mono', monospace" fontWeight={600}>E={node.E}</text>
        </g>
    );
}

// ─── Draw dashpot ───────────────────────────────────────────────────────────
function drawDashpot(x, y, w, h, node, stretch, showRef) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const dw = ELEM_W * 0.32;
    const dh = ELEM_H * 0.38;
    const col = "#5b7a6a";

    const pistonShift = stretch * 0.4;
    const cylLeft = cx - dw / 2 - pistonShift * 0.3;
    const cylRight = cx + dw / 2 + pistonShift * 0.3;

    const refElems = [];
    if (showRef) {
        const restW = ELEM_W + WIRE * 2;
        refElems.push(
            <line key={node.id + "_refL"} x1={x} y1={cy - ELEM_H / 2 + 4} x2={x} y2={cy + ELEM_H / 2 - 4}
                stroke="#5b7a6a" strokeWidth={1} strokeDasharray="3 2" opacity={0.45} />
        );
        refElems.push(
            <line key={node.id + "_refR"} x1={x + restW} y1={cy - ELEM_H / 2 + 4} x2={x + restW} y2={cy + ELEM_H / 2 - 4}
                stroke="#5b7a6a" strokeWidth={1} strokeDasharray="3 2" opacity={0.45} />
        );
    }

    return (
        <g key={node.id}>
            {refElems}
            <line x1={x} y1={cy} x2={cylLeft} y2={cy} stroke={col} strokeWidth={2.2} />
            <line x1={cylLeft} y1={cy - dh} x2={cylLeft} y2={cy + dh} stroke={col} strokeWidth={2.5} strokeLinecap="round" />
            <line x1={cylRight} y1={cy - dh} x2={cx - dw * 0.1 + pistonShift * 0.15} y2={cy - dh} stroke={col} strokeWidth={2.2} />
            <line x1={cylRight} y1={cy + dh} x2={cx - dw * 0.1 + pistonShift * 0.15} y2={cy + dh} stroke={col} strokeWidth={2.2} />
            <line x1={cylRight} y1={cy - dh} x2={cylRight} y2={cy + dh} stroke={col} strokeWidth={2.2} />
            <line x1={cylRight} y1={cy} x2={x + w} y2={cy} stroke={col} strokeWidth={2.2} />
            <text x={cx} y={cy - ELEM_H / 2 + 2} textAnchor="middle" fontSize="10" fill="#5a7868"
                fontFamily="'DM Mono', monospace" fontWeight={600}>η={node.eta}</text>
        </g>
    );
}

// ─── Draw node recursively ──────────────────────────────────────────────────
function drawNode(node, x, y, availW, availH, stretchPx, showRef) {
    const s = stretchPx ? (stretchPx[node.id] || 0) : 0;
    if (node.type === "spring") return [drawSpring(x, y, availW, availH, node, s, showRef)];
    if (node.type === "dashpot") return [drawDashpot(x, y, availW, availH, node, s, showRef)];

    let elements = [];
    const m = measureNode(node, stretchPx);

    if (node.type === "series") {
        let cx = x + WIRE;
        const cy = y + availH / 2;
        elements.push(<line key={node.id + "_wl"} x1={x} y1={cy} x2={x + WIRE} y2={cy} stroke="#555" strokeWidth={1.5} />);
        for (const child of node.children) {
            const cm = measureNode(child, stretchPx);
            elements = elements.concat(drawNode(child, cx, y + (availH - cm.h) / 2, cm.w, cm.h, stretchPx, showRef));
            cx += cm.w;
        }
        elements.push(<line key={node.id + "_wr"} x1={cx} y1={cy} x2={cx + WIRE} y2={cy} stroke="#555" strokeWidth={1.5} />);
    }

    if (node.type === "parallel") {
        const innerW = m.w - WIRE * 2 - 16;
        const cxStart = x + 8 + WIRE;
        let cy = y;
        const juncL = x + 8;
        const juncR = x + m.w - 8;
        const juncY = y + m.h / 2;
        const childMidYs = [];
        let tempCy = y;
        for (let i = 0; i < node.children.length; i++) {
            const cm = measureNode(node.children[i], stretchPx);
            childMidYs.push(tempCy + cm.h / 2);
            tempCy += cm.h + GAP;
        }
        cy = y;
        for (let i = 0; i < node.children.length; i++) {
            const child = node.children[i];
            const cm = measureNode(child, stretchPx);
            const childX = cxStart + (innerW - cm.w) / 2;
            elements = elements.concat(drawNode(child, childX, cy, cm.w, cm.h, stretchPx, showRef));
            const childMidY = childMidYs[i];
            elements.push(<line key={node.id + "_pl" + i} x1={juncL} y1={childMidY} x2={childX} y2={childMidY} stroke="#555" strokeWidth={1.5} />);
            elements.push(<line key={node.id + "_pr" + i} x1={childX + cm.w} y1={childMidY} x2={juncR} y2={childMidY} stroke="#555" strokeWidth={1.5} />);
            cy += cm.h + GAP;
        }
        const topY = childMidYs[0];
        const botY = childMidYs[childMidYs.length - 1];
        elements.push(<line key={node.id + "_busl"} x1={juncL} y1={topY} x2={juncL} y2={botY} stroke="#555" strokeWidth={1.5} />);
        elements.push(<line key={node.id + "_busr"} x1={juncR} y1={topY} x2={juncR} y2={botY} stroke="#555" strokeWidth={1.5} />);
        elements.push(<line key={node.id + "_wl"} x1={x} y1={juncY} x2={juncL} y2={juncY} stroke="#555" strokeWidth={1.5} />);
        elements.push(<line key={node.id + "_wr"} x1={juncR} y1={juncY} x2={x + m.w} y2={juncY} stroke="#555" strokeWidth={1.5} />);
    }
    return elements;
}

// ─── Fixed Wall ─────────────────────────────────────────────────────────────
function FixedWall({ x, y, height }) {
    const lines = [];
    const spacing = 5;
    const nLines = Math.ceil(height / spacing) + 1;
    for (let i = 0; i < nLines; i++) {
        const ly = y + i * spacing;
        if (ly <= y + height) {
            lines.push(<line key={"h" + i} x1={x} y1={ly} x2={x - 7} y2={ly + 7} stroke="#7a7466" strokeWidth={1.2} />);
        }
    }
    return (
        <g>
            <line x1={x} y1={y} x2={x} y2={y + height} stroke="#c0b8a8" strokeWidth={2.5} />
            {lines}
        </g>
    );
}

// ─── Load Arrow ─────────────────────────────────────────────────────────────
function LoadArrow({ x, y, isActive, mode, magnitude }) {
    const col = isActive ? (mode === "creep" ? "#b8543f" : "#5b8a6a") : "#3a3628";
    const label = mode === "creep" ? `σ₀=${magnitude}` : `ε₀=${magnitude}`;
    return (
        <g>
            <line x1={x} y1={y} x2={x + 22} y2={y} stroke={col} strokeWidth={2.5} />
            <polygon points={`${x + 22},${y - 5} ${x + 30},${y} ${x + 22},${y + 5}`} fill={col} />
            <text x={x + 15} y={y - 10} textAnchor="middle" fontSize="9" fill={col}
                fontFamily="'DM Mono', monospace" fontWeight={600}>{label}</text>
        </g>
    );
}

// ─── Count leaf elements ────────────────────────────────────────────────────
function countLeaves(node) {
    if (node.type === "spring" || node.type === "dashpot") return 1;
    if (node.children) return node.children.reduce((a, c) => a + countLeaves(c), 0);
    return 0;
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function AnimatedSchematic({ model, creepData, relaxData, sigma0, eps0, onTimeChange }) {
    const [animMode, setAnimMode] = useState("creep");
    const [playing, setPlaying] = useState(false);
    const [frameIndex, setFrameIndex] = useState(-1); // -1 = static/reset
    const [speed, setSpeed] = useState(1);
    const animRef = useRef(null);
    const lastTimeRef = useRef(null);

    const data = animMode === "creep" ? creepData : relaxData;
    const magnitude = animMode === "creep" ? sigma0 : eps0;

    // Augment data with pre-load frames (t < 0, zero strain)
    const augmentedData = useMemo(() => {
        if (!data || data.length === 0) return [];
        const zeroStrains = {};
        if (data[0].elementStrains) {
            for (const id of Object.keys(data[0].elementStrains)) zeroStrains[id] = 0;
        }
        const preFrames = [];
        for (let i = 0; i < PRE_LOAD_FRAMES; i++) {
            const tPre = -((PRE_LOAD_FRAMES - i) / PRE_LOAD_FRAMES) * 0.5; // t from -0.5 to ~0
            preFrames.push({ t: parseFloat(tPre.toFixed(4)), value: 0, load: 0, elementStrains: zeroStrains });
        }
        return [...preFrames, ...data];
    }, [data]);

    const totalFrames = augmentedData.length;
    const isAnimating = frameIndex >= 0;

    // Notify parent of current animation time (use original t values for chart tracker)
    useEffect(() => {
        if (onTimeChange) {
            if (isAnimating && frameIndex >= 0 && frameIndex < augmentedData.length) {
                const pt = augmentedData[frameIndex];
                if (pt.t >= 0) {
                    onTimeChange({ t: pt.t, value: pt.value, mode: animMode, active: true });
                } else {
                    onTimeChange({ t: null, value: null, mode: animMode, active: true });
                }
            } else {
                onTimeChange({ t: null, value: null, mode: animMode, active: false });
            }
        }
    }, [frameIndex, animMode, isAnimating]);

    // Max element strain for normalization
    const maxStrain = computeMaxElementStrain(data);

    // Current frame
    const currentData = (isAnimating && frameIndex < augmentedData.length) ? augmentedData[frameIndex] : null;
    const isLoadActive = currentData ? Math.abs(currentData.load) > 0 : false;
    const stretchPx = currentData ? strainsToPixels(currentData.elementStrains, maxStrain) : null;

    // Animation loop
    useEffect(() => {
        if (!playing || totalFrames === 0) return;
        const fpsDuration = 1000 / (30 * speed);
        const animate = (timestamp) => {
            if (lastTimeRef.current === null) lastTimeRef.current = timestamp;
            if (timestamp - lastTimeRef.current >= fpsDuration) {
                lastTimeRef.current = timestamp;
                setFrameIndex(prev => {
                    const next = prev < 0 ? 0 : prev + 1;
                    if (next >= totalFrames) { setPlaying(false); return totalFrames - 1; }
                    return next;
                });
            }
            animRef.current = requestAnimationFrame(animate);
        };
        animRef.current = requestAnimationFrame(animate);
        return () => { if (animRef.current) cancelAnimationFrame(animRef.current); lastTimeRef.current = null; };
    }, [playing, totalFrames, speed]);

    // Reset when model or data changes
    useEffect(() => { setPlaying(false); setFrameIndex(-1); }, [model, creepData, relaxData]);

    const handlePlay = () => {
        if (frameIndex >= totalFrames - 1 || frameIndex < 0) setFrameIndex(0);
        setPlaying(true);
    };
    const handlePause = () => setPlaying(false);
    const handleReset = () => { setPlaying(false); setFrameIndex(-1); };
    const handleScrub = (e) => { setFrameIndex(parseInt(e.target.value, 10)); if (playing) setPlaying(false); };

    // ─── Fixed viewBox: always based on rest dimensions + max possible stretch ──
    const restM = measureNodeRest(model);
    const nLeaves = countLeaves(model);
    const maxExtraW = nLeaves * MAX_STRETCH_PX; // max total stretch in px
    const arrowW = 40;
    const wallOffset = WALL_W + 8;
    // viewBox is always large enough for full stretch
    const svgW = wallOffset + PAD + restM.w + maxExtraW + PAD + arrowW;
    const svgH = restM.h + PAD * 2;
    const modelX = wallOffset + PAD; // left anchor never moves
    const modelY = PAD;
    const midY = modelY + restM.h / 2;

    // Measure actual stretched width for drawing
    const actualM = measureNode(model, stretchPx);
    const elements = drawNode(model, modelX, modelY, actualM.w, actualM.h, stretchPx, isAnimating);

    // Styles
    const btn = {
        padding: "4px 10px", borderRadius: 5, border: "1px solid #3a3628",
        background: "#23201a", color: "#c0b8a8", cursor: "pointer", fontSize: 13,
        fontFamily: "'DM Mono', monospace", transition: "all 0.15s",
        display: "flex", alignItems: "center", justifyContent: "center", minWidth: 30, height: 26,
    };
    const activeBtn = { ...btn, background: "#2a3040", borderColor: "#3b5278", color: "#a8c7fa" };
    const modeBtn = (m) => ({
        ...btn, fontSize: 11, padding: "3px 10px",
        ...(animMode === m ? { background: "#2a3040", borderColor: "#3b5278", color: m === "creep" ? "#b8543f" : "#5b8a6a" } : {}),
    });

    const tNow = currentData ? currentData.t : null;
    const valNow = currentData ? currentData.value : null;
    const isPreLoad = tNow !== null && tNow < 0;

    return (
        <div>
            <svg viewBox={`0 0 ${svgW} ${svgH}`} width="100%" style={{ maxHeight: 260, display: "block" }}>
                {/* Wall always at fixed position */}
                <FixedWall x={wallOffset} y={midY - restM.h / 2 - 6} height={restM.h + 12} />
                <line x1={wallOffset} y1={midY} x2={modelX} y2={midY} stroke="#555" strokeWidth={1.5} />
                {elements}
                <line x1={modelX + actualM.w} y1={midY} x2={modelX + actualM.w + 8} y2={midY} stroke="#555" strokeWidth={1.5} />
                {isAnimating ? (
                    <LoadArrow x={modelX + actualM.w + 8} y={midY} isActive={isLoadActive} mode={animMode} magnitude={magnitude} />
                ) : (
                    <>
                        <circle cx={modelX - PAD} cy={midY} r={5} fill="#333" />
                        <circle cx={modelX + restM.w} cy={midY} r={5} fill="#333" />
                    </>
                )}
                {/* Pre-load indicator */}
                {isPreLoad && (
                    <text x={svgW / 2} y={svgH - 6} textAnchor="middle" fontSize="10" fill="#7a7466"
                        fontFamily="'DM Mono', monospace" fontStyle="italic">
                        before loading (rest state)
                    </text>
                )}
            </svg>

            {/* Controls */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                <button onClick={() => { setAnimMode("creep"); setPlaying(false); setFrameIndex(-1); }} style={modeBtn("creep")}>Creep</button>
                <button onClick={() => { setAnimMode("relax"); setPlaying(false); setFrameIndex(-1); }} style={modeBtn("relax")}>Relax</button>
                <span style={{ width: 1, height: 20, background: "#2a2720", margin: "0 2px" }} />
                {!playing
                    ? <button onClick={handlePlay} style={btn} title="Play">▶</button>
                    : <button onClick={handlePause} style={activeBtn} title="Pause">⏸</button>
                }
                <button onClick={handleReset} style={btn} title="Reset">⟲</button>
                <select value={speed} onChange={e => setSpeed(parseFloat(e.target.value))}
                    style={{
                        padding: "3px 6px", borderRadius: 4, border: "1px solid #3a3628", background: "#0e0d0b",
                        color: "#c0b8a8", fontSize: 11, fontFamily: "'DM Mono', monospace", cursor: "pointer"
                    }}>
                    <option value={0.25}>0.25×</option>
                    <option value={0.5}>0.5×</option>
                    <option value={1}>1×</option>
                    <option value={2}>2×</option>
                    <option value={4}>4×</option>
                </select>
                {isAnimating && (
                    <>
                        <input type="range" min={0} max={Math.max(0, totalFrames - 1)} value={Math.max(0, frameIndex)}
                            onChange={handleScrub}
                            style={{ flex: 1, minWidth: 80, accentColor: animMode === "creep" ? "#b8543f" : "#5b8a6a", cursor: "pointer" }} />
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: "#7a7466", whiteSpace: "nowrap" }}>
                            {isPreLoad ? (
                                <span style={{ fontStyle: "italic" }}>rest</span>
                            ) : (
                                <>
                                    t={tNow?.toFixed(2)} &nbsp;
                                    <span style={{ color: animMode === "creep" ? "#b8543f" : "#5b8a6a" }}>
                                        {animMode === "creep" ? "ε" : "σ"}={valNow?.toFixed(4)}
                                    </span>
                                </>
                            )}
                        </span>
                    </>
                )}
            </div>
        </div>
    );
}
