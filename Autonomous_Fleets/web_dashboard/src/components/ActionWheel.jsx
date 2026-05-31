import { useState, useEffect, useCallback } from 'react';

const IR = 30;
const OR = 80;

const ACTIONS = [
  { id: 'move',      label: 'Move',      s: -45, e: 45,  color: '#00aaff' },
  { id: 'calibrate', label: 'Calibrate', s: 45,  e: 135, color: '#c084fc' },
  { id: 'cross',     label: 'Cross',     s: 135, e: 225, color: '#fbbf24' },
  { id: 'charge',    label: 'Charge',    s: 225, e: 315, color: '#34d399' },
];

const SEP_WIDTH = 1.2;

const d2r = (d) => d * Math.PI / 180;

function arc(s, e, ri, ro) {
  const cs = Math.cos(d2r(s)), ss = Math.sin(d2r(s));
  const ce = Math.cos(d2r(e)), se = Math.sin(d2r(e));
  const lg = e - s > 180 ? 1 : 0;
  return `M${ro*cs},${ro*ss}A${ro},${ro},0,${lg},1,${ro*ce},${ro*se}L${ri*ce},${ri*se}A${ri},${ri},0,${lg},0,${ri*cs},${ri*ss}Z`;
}

function hitTest(cx, cy, mx, my) {
  const dx = mx - cx, dy = my - cy;
  if (dx * dx + dy * dy < 18 * 18) return null;
  let a = Math.atan2(dy, dx) * 180 / Math.PI;
  if (a < -45) a += 360;
  if (a < 45) return 'move';
  if (a < 135) return 'calibrate';
  if (a < 225) return 'cross';
  return 'charge';
}

function sepLine(angleDeg, ri, ro) {
  const r = d2r(angleDeg);
  return `M${ri*Math.cos(r)},${ri*Math.sin(r)}L${ro*Math.cos(r)},${ro*Math.sin(r)}`;
}

export default function ActionWheel({ x, y, onSelect, onClose, hasRobot }) {
  const [hov, setHov] = useState(null);
  const [vis, setVis] = useState(false);

  useEffect(() => {
    requestAnimationFrame(() => setVis(true));
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [onClose]);

  const onMM = useCallback((e) => setHov(hitTest(x, y, e.clientX, e.clientY)), [x, y]);

  const onCl = useCallback((e) => {
    const id = hitTest(x, y, e.clientX, e.clientY);
    if (!id) { onClose(); return; }
    if (id !== 'cross' && !hasRobot) return;
    onSelect(id);
  }, [x, y, onSelect, onClose, hasRobot]);

  const onTouchEnd = useCallback((e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    if (!touch) return;
    const id = hitTest(x, y, touch.clientX, touch.clientY);
    if (!id) { onClose(); return; }
    if (id !== 'cross' && !hasRobot) return;
    onSelect(id);
  }, [x, y, onSelect, onClose, hasRobot]);

  const onTouchMove = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch) return;
    setHov(hitTest(x, y, touch.clientX, touch.clientY));
  }, [x, y]);

  const MR = (IR + OR) / 2;

  return (
    <div
      className="aw-backdrop"
      onMouseMove={onMM}
      onClick={onCl}
      onTouchEnd={onTouchEnd}
      onTouchMove={onTouchMove}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      style={{ cursor: hov && (hov === 'cross' || hasRobot) ? 'pointer' : 'default' }}
    >
      <svg
        className={`aw-svg ${vis ? 'aw-in' : ''}`}
        style={{ left: x - 100, top: y - 100 }}
        width="200" height="200"
        viewBox="-100 -100 200 200"
      >
        {ACTIONS.map((a) => {
          const h = hov === a.id;
          const dis = a.id !== 'cross' && !hasRobot;
          const mr = d2r((a.s + a.e) / 2);
          return (
            <g key={a.id}>
              <path
                d={arc(a.s, a.e, IR, OR)}
                fill={dis ? 'rgba(25,25,32,0.7)' : h ? a.color : 'rgba(18,18,24,0.92)'}
                stroke="none"
                style={{ transition: 'fill .12s' }}
              />
              <text
                x={MR * Math.cos(mr)} y={MR * Math.sin(mr) + 1}
                textAnchor="middle" dominantBaseline="central"
                fill={dis ? 'rgba(255,255,255,0.15)' : h ? '#000' : 'rgba(255,255,255,0.7)'}
                fontSize="10" fontWeight="600"
                fontFamily="Inter,system-ui,sans-serif"
                letterSpacing="0.4"
                style={{ pointerEvents: 'none', transition: 'fill .12s' }}
              >
                {a.label}
              </text>
            </g>
          );
        })}

        {[-45, 45, 135, 225].map(angle => (
          <path
            key={angle}
            d={sepLine(angle, IR - 1, OR + 1)}
            stroke="rgba(0,0,0,0.8)"
            strokeWidth={SEP_WIDTH}
            fill="none"
            style={{ pointerEvents: 'none' }}
          />
        ))}

        <circle cx="0" cy="0" r={IR} fill="rgba(0,0,0,0.85)" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
        <circle cx="0" cy="0" r="2.5" fill="rgba(255,255,255,0.2)" />
        <circle cx="0" cy="0" r={OR} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="0.5" />
      </svg>
    </div>
  );
}
