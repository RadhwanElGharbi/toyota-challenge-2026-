import { useRef, useEffect, useCallback, useState } from 'react';

const ARENA_CM = 400;
const ROBOT_LENGTH_CM = 40;
const ROBOT_WIDTH_CM = 30;
const ROBOT_COLORS = ['#00aaff', '#ff0033', '#00cc88', '#ff8800', '#c084fc', '#fb923c', '#f472b6', '#a3e635'];

const CALIB_ZONE = { x: 0, y: 0, w: 40, h: 40 };
const CHARGE_ZONE = { x: 360, y: 360, w: 40, h: 40 };
const CORRIDOR_WIDTH_CM = 60;

function getRobotColor(robotId, allIds) {
  const sorted = [...allIds].sort();
  const idx = sorted.indexOf(robotId);
  return ROBOT_COLORS[idx % ROBOT_COLORS.length];
}

export default function Arena({ robots, robotHistory, selectedRobot, waypoints, activePaths, onArenaClick, onDoubleClick, onRightClick, corridor, crossWaypoints, obstacles, drawingPoints, actionStops, stopQueues, tasks, interactionMode }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [canvasSize, setCanvasSize] = useState(400);
  const [mousePos, setMousePos] = useState(null);
  const animRef = useRef(null);

  // Resize observer to keep canvas square
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        const size = Math.floor(Math.min(width, height));
        if (size > 0) setCanvasSize(size);
      }
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  const cmToCanvas = useCallback((xCm, yCm) => {
    const scale = canvasSize / ARENA_CM;
    return [
      xCm * scale,
      canvasSize - yCm * scale,
    ];
  }, [canvasSize]);

  const canvasToCm = useCallback((px, py) => {
    const scale = ARENA_CM / canvasSize;
    return [
      px * scale,
      (canvasSize - py) * scale,
    ];
  }, [canvasSize]);

  const handleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [xCm, yCm] = canvasToCm(px, py);
    const clampedX = Math.max(0, Math.min(ARENA_CM, Math.round(xCm * 10) / 10));
    const clampedY = Math.max(0, Math.min(ARENA_CM, Math.round(yCm * 10) / 10));

    const HIT = 20;
    for (const rid of Object.keys(robots)) {
      const d = robots[rid];
      if (d.x_cm != null && d.y_cm != null) {
        if (Math.abs(clampedX - d.x_cm) < HIT && Math.abs(clampedY - d.y_cm) < HIT) {
          const task = (tasks || []).find(t => t.robot_id === rid && t.status === 'active');
          const nextStep = task && task.current_step < task.steps.length ? task.steps[task.current_step] : null;
          setTooltip({ type: 'robot', screenX: e.clientX, screenY: e.clientY, robotId: rid, data: d, nextStep, taskName: task?.name });
          return;
        }
      }
    }

    for (const stop of (actionStops || [])) {
      if (Math.abs(clampedX - stop.x_cm) < HIT && Math.abs(clampedY - stop.y_cm) < HIT) {
        const q = (stopQueues || {})[stop.id] || [];
        setTooltip({ type: 'stop', screenX: e.clientX, screenY: e.clientY, stop, queue: q });
        return;
      }
    }

    setTooltip(null);
    if (onArenaClick) onArenaClick({ x_cm: clampedX, y_cm: clampedY });
  }, [canvasToCm, onArenaClick, robots, actionStops, stopQueues, tasks]);

  const handleMouseMove = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [xCm, yCm] = canvasToCm(px, py);
    if (xCm >= 0 && xCm <= ARENA_CM && yCm >= 0 && yCm <= ARENA_CM) {
      setMousePos({ x: Math.round(xCm * 10) / 10, y: Math.round(yCm * 10) / 10 });
    } else {
      setMousePos(null);
    }
  }, [canvasToCm]);

  const handleMouseLeave = useCallback(() => {
    setMousePos(null);
  }, []);

  const handleDoubleClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [xCm, yCm] = canvasToCm(px, py);
    const clampedX = Math.max(0, Math.min(ARENA_CM, Math.round(xCm * 10) / 10));
    const clampedY = Math.max(0, Math.min(ARENA_CM, Math.round(yCm * 10) / 10));
    if (onDoubleClick) onDoubleClick({ x_cm: clampedX, y_cm: clampedY });
  }, [canvasToCm, onDoubleClick]);

  const handleContextMenu = useCallback((e) => {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const [xCm, yCm] = canvasToCm(px, py);
    const clampedX = Math.max(0, Math.min(ARENA_CM, Math.round(xCm * 10) / 10));
    const clampedY = Math.max(0, Math.min(ARENA_CM, Math.round(yCm * 10) / 10));
    if (onRightClick) onRightClick({ screenX: e.clientX, screenY: e.clientY, x_cm: clampedX, y_cm: clampedY });
  }, [canvasToCm, onRightClick]);

  const longPressRef = useRef(null);
  const longPressFired = useRef(false);

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    longPressFired.current = false;
    longPressRef.current = setTimeout(() => {
      longPressFired.current = true;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const px = touch.clientX - rect.left;
      const py = touch.clientY - rect.top;
      const [xCm, yCm] = canvasToCm(px, py);
      const clampedX = Math.max(0, Math.min(ARENA_CM, Math.round(xCm * 10) / 10));
      const clampedY = Math.max(0, Math.min(ARENA_CM, Math.round(yCm * 10) / 10));
      if (onRightClick) onRightClick({ screenX: touch.clientX, screenY: touch.clientY, x_cm: clampedX, y_cm: clampedY });
    }, 1500);
  }, [canvasToCm, onRightClick]);

  const handleTouchEnd = useCallback((e) => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
    if (longPressFired.current) {
      e.preventDefault();
      longPressFired.current = false;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressRef.current) {
      clearTimeout(longPressRef.current);
      longPressRef.current = null;
    }
  }, []);

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvasSize;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const scale = size / ARENA_CM;

    // Background
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, size, size);

    // Minor grid (every 10cm)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= ARENA_CM; i += 10) {
      const p = i * scale;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Major grid (every 50cm)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= ARENA_CM; i += 50) {
      const p = i * scale;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.font = "10px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
    ctx.textAlign = 'center';
    for (let i = 0; i <= ARENA_CM; i += 50) {
      const px = i * scale;
      // X axis labels at bottom
      ctx.fillText(`${i}`, px, size - 4);
      // Y axis labels at left (remember Y is flipped)
      const py = size - i * scale;
      ctx.textAlign = 'left';
      ctx.fillText(`${i}`, 4, py - 4);
      ctx.textAlign = 'center';
    }

    // Calibration zone
    {
      const [cx1, cy1] = cmToCanvas(CALIB_ZONE.x, CALIB_ZONE.y + CALIB_ZONE.h);
      const cw = CALIB_ZONE.w * scale;
      const ch = CALIB_ZONE.h * scale;

      ctx.fillStyle = 'rgba(255, 217, 61, 0.04)';
      ctx.fillRect(cx1, cy1, cw, ch);

      ctx.strokeStyle = '#ffd93d';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.6;
      ctx.strokeRect(cx1, cy1, cw, ch);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      // Crosshair at zone center
      const crossX = cx1 + cw / 2;
      const crossY = cy1 + ch / 2;
      const crossR = 6;
      ctx.strokeStyle = '#ffd93d';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(crossX - crossR, crossY);
      ctx.lineTo(crossX + crossR, crossY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(crossX, crossY - crossR);
      ctx.lineTo(crossX, crossY + crossR);
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      // Label
      ctx.fillStyle = '#ffd93d';
      ctx.globalAlpha = 0.5;
      ctx.font = "bold 9px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('CALIBRATION', cx1 + cw / 2, cy1 - 4);
      ctx.globalAlpha = 1.0;
    }

    // Charging station zone
    {
      const [cx1, cy1] = cmToCanvas(CHARGE_ZONE.x, CHARGE_ZONE.y + CHARGE_ZONE.h);
      const cw = CHARGE_ZONE.w * scale;
      const ch = CHARGE_ZONE.h * scale;

      ctx.fillStyle = 'rgba(52, 211, 153, 0.04)';
      ctx.fillRect(cx1, cy1, cw, ch);

      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.6;
      ctx.strokeRect(cx1, cy1, cw, ch);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      const crossX = cx1 + cw / 2;
      const crossY = cy1 + ch / 2;
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(crossX - 6, crossY);
      ctx.lineTo(crossX + 6, crossY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(crossX, crossY - 6);
      ctx.lineTo(crossX, crossY + 6);
      ctx.stroke();
      ctx.globalAlpha = 1.0;

      ctx.fillStyle = '#34d399';
      ctx.globalAlpha = 0.5;
      ctx.font = "bold 9px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('CHARGING', cx1 + cw / 2, cy1 - 4);
      ctx.globalAlpha = 1.0;
    }

    // Obstacles
    (obstacles || []).forEach(obs => {
      const pts = obs.points.map(p => cmToCanvas(p.x_cm, p.y_cm));
      if (pts.length < 2) return;
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (obs.type === 'polygon') ctx.closePath();
      ctx.stroke();
      if (obs.type === 'polygon') {
        ctx.fillStyle = 'rgba(248, 113, 113, 0.12)';
        ctx.fill();
      }
      ctx.globalAlpha = 1.0;
      pts.forEach(([px, py]) => {
        ctx.fillStyle = '#f87171';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
      });
    });

    // Obstacle drawing preview
    if (drawingPoints && drawingPoints.length > 0) {
      const pts = drawingPoints.map(p => cmToCanvas(p.x_cm, p.y_cm));
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (mousePos) {
        const [mpx, mpy] = cmToCanvas(mousePos.x, mousePos.y);
        ctx.lineTo(mpx, mpy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
      pts.forEach(([px, py]) => {
        ctx.fillStyle = '#f87171';
        ctx.beginPath();
        ctx.arc(px, py, 4, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Action stops
    (actionStops || []).forEach(stop => {
      const [sx, sy] = cmToCanvas(stop.x_cm, stop.y_cm);
      ctx.fillStyle = '#22d3ee';
      ctx.beginPath();
      ctx.arc(sx, sy, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#22d3ee';
      ctx.globalAlpha = 0.8;
      ctx.font = "bold 9px 'IBM Plex Mono', 'SF Mono', monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(stop.name, sx, sy - 11);
      ctx.globalAlpha = 1.0;
    });

    const allIds = Object.keys(robots);

    // Draw waypoints (planned path — yellow diamonds)
    if (waypoints && waypoints.length > 0) {
      ctx.strokeStyle = '#ffd93d';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const [sx, sy] = cmToCanvas(waypoints[0].x_cm, waypoints[0].y_cm);
      ctx.moveTo(sx, sy);
      for (let i = 1; i < waypoints.length; i++) {
        const [wx, wy] = cmToCanvas(waypoints[i].x_cm, waypoints[i].y_cm);
        ctx.lineTo(wx, wy);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw waypoint markers
      waypoints.forEach((wp, idx) => {
        const [wx, wy] = cmToCanvas(wp.x_cm, wp.y_cm);
        // Diamond shape
        ctx.fillStyle = '#ffd93d';
        ctx.beginPath();
        ctx.moveTo(wx, wy - 7);
        ctx.lineTo(wx + 5, wy);
        ctx.lineTo(wx, wy + 7);
        ctx.lineTo(wx - 5, wy);
        ctx.closePath();
        ctx.fill();
        // Index label
        ctx.fillStyle = '#000';
        ctx.font = "bold 9px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${idx + 1}`, wx, wy);
      });
    }

    // Draw active paths (sent paths being executed)
    Object.entries(activePaths || {}).forEach(([robotId, pathData]) => {
      if (!pathData.waypoints || pathData.waypoints.length === 0) return;
      const color = getRobotColor(robotId, allIds);
      const wps = pathData.waypoints;

      // Connecting line from robot to waypoints
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      const robotData = robots[robotId];
      if (robotData && robotData.x_cm != null && robotData.y_cm != null) {
        const [rx, ry] = cmToCanvas(robotData.x_cm, robotData.y_cm);
        ctx.moveTo(rx, ry);
        for (let i = 0; i < wps.length; i++) {
          const [wx, wy] = cmToCanvas(wps[i].x_cm, wps[i].y_cm);
          ctx.lineTo(wx, wy);
        }
      } else {
        const [sx, sy] = cmToCanvas(wps[0].x_cm, wps[0].y_cm);
        ctx.moveTo(sx, sy);
        for (let i = 1; i < wps.length; i++) {
          const [wx, wy] = cmToCanvas(wps[i].x_cm, wps[i].y_cm);
          ctx.lineTo(wx, wy);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      // Waypoint markers
      wps.forEach((wp, idx) => {
        const [wx, wy] = cmToCanvas(wp.x_cm, wp.y_cm);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(wx, wy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;
        // Index
        ctx.fillStyle = '#000';
        ctx.font = "bold 8px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${idx + 1}`, wx, wy);
      });
    });

    // Draw each robot
    allIds.forEach((robotId) => {
      const data = robots[robotId];
      if (data.x_cm == null || data.y_cm == null) return;

      const color = getRobotColor(robotId, allIds);
      const x = data.x_cm;
      const y = data.y_cm;
      const theta = data.theta_deg ?? 0;
      const thetaRad = (theta * Math.PI) / 180;

      // Trail from history
      const history = robotHistory[robotId];
      if (history && history.length > 1) {
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const [hx0, hy0] = cmToCanvas(history[0].x, history[0].y);
        ctx.moveTo(hx0, hy0);
        for (let i = 1; i < history.length; i++) {
          const [hx, hy] = cmToCanvas(history[i].x, history[i].y);
          ctx.lineTo(hx, hy);
        }
        ctx.stroke();
        ctx.globalAlpha = 1.0;
      }

      const [cx, cy] = cmToCanvas(x, y);

      // Safety box (40cm x 30cm, rotated — length along heading)
      const halfLen = (ROBOT_LENGTH_CM / 2) * scale;
      const halfWid = (ROBOT_WIDTH_CM / 2) * scale;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-thetaRad);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(-halfLen, -halfWid, halfLen * 2, halfWid * 2);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;
      ctx.restore();

      // Front ultrasonic ray
      if (data.front_ultrasonic_cm != null && data.front_ultrasonic_cm > 0 && data.front_ultrasonic_cm <= 200) {
        const rayLen = data.front_ultrasonic_cm * scale;
        const endX = cx + rayLen * Math.cos(-thetaRad);
        const endY = cy + rayLen * Math.sin(-thetaRad);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1.0;
      }

      // Robot circle with glow
      ctx.shadowColor = color;
      ctx.shadowBlur = 8;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Heading arrow
      const arrowLen = 20;
      const arrowX = cx + arrowLen * Math.cos(-thetaRad);
      const arrowY = cy + arrowLen * Math.sin(-thetaRad);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(arrowX, arrowY);
      ctx.stroke();
      // Arrowhead
      const headLen = 6;
      const headAngle = 0.5;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(arrowX, arrowY);
      ctx.lineTo(
        arrowX - headLen * Math.cos(-thetaRad - headAngle),
        arrowY - headLen * Math.sin(-thetaRad - headAngle)
      );
      ctx.lineTo(
        arrowX - headLen * Math.cos(-thetaRad + headAngle),
        arrowY - headLen * Math.sin(-thetaRad + headAngle)
      );
      ctx.closePath();
      ctx.fill();

      // Selected indicator
      if (robotId === selectedRobot) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 13, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Label
      ctx.fillStyle = '#ffffff';
      ctx.font = "11px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(robotId, cx, cy - 16);
    });

    // Corridor
    if (corridor && corridor.waypoints && corridor.waypoints.length >= 2) {
      const cWps = corridor.waypoints;
      const corridorPx = CORRIDOR_WIDTH_CM * scale;

      // Thick corridor fill
      ctx.save();
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.1)';
      ctx.lineWidth = corridorPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      const [cf0x, cf0y] = cmToCanvas(cWps[0].x_cm, cWps[0].y_cm);
      ctx.moveTo(cf0x, cf0y);
      for (let i = 1; i < cWps.length; i++) {
        const [cwx, cwy] = cmToCanvas(cWps[i].x_cm, cWps[i].y_cm);
        ctx.lineTo(cwx, cwy);
      }
      ctx.stroke();
      ctx.restore();

      // Dashed border at corridor width
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = corridorPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = 0.15;
      ctx.setLineDash([10, 6]);
      ctx.beginPath();
      ctx.moveTo(cf0x, cf0y);
      for (let i = 1; i < cWps.length; i++) {
        const [cwx, cwy] = cmToCanvas(cWps[i].x_cm, cWps[i].y_cm);
        ctx.lineTo(cwx, cwy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      // Center line
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cf0x, cf0y);
      for (let i = 1; i < cWps.length; i++) {
        const [cwx, cwy] = cmToCanvas(cWps[i].x_cm, cWps[i].y_cm);
        ctx.lineTo(cwx, cwy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      // Entry / exit markers
      ctx.fillStyle = '#fbbf24';
      ctx.beginPath();
      ctx.arc(cf0x, cf0y, 5, 0, Math.PI * 2);
      ctx.fill();
      const [clx, cly] = cmToCanvas(cWps[cWps.length - 1].x_cm, cWps[cWps.length - 1].y_cm);
      ctx.beginPath();
      ctx.arc(clx, cly, 5, 0, Math.PI * 2);
      ctx.fill();

      // CROSSING label at midpoint
      const midIdx = Math.floor(cWps.length / 2);
      const [mcx, mcy] = cmToCanvas(cWps[midIdx].x_cm, cWps[midIdx].y_cm);
      ctx.fillStyle = '#fbbf24';
      ctx.globalAlpha = 0.7;
      ctx.font = "bold 11px 'JetBrains Mono', 'SF Mono', Consolas, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('CROSSING', mcx, mcy);
      ctx.globalAlpha = 1.0;
    }

    // Cross mode preview (multi-point path being built)
    if (crossWaypoints && crossWaypoints.length > 0) {
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      const [cp0x, cp0y] = cmToCanvas(crossWaypoints[0].x_cm, crossWaypoints[0].y_cm);
      ctx.moveTo(cp0x, cp0y);
      for (let i = 1; i < crossWaypoints.length; i++) {
        const [cpx, cpy] = cmToCanvas(crossWaypoints[i].x_cm, crossWaypoints[i].y_cm);
        ctx.lineTo(cpx, cpy);
      }
      if (mousePos) {
        const [mpx, mpy] = cmToCanvas(mousePos.x, mousePos.y);
        ctx.lineTo(mpx, mpy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1.0;

      crossWaypoints.forEach((wp) => {
        const [wpx, wpy] = cmToCanvas(wp.x_cm, wp.y_cm);
        ctx.fillStyle = '#fbbf24';
        ctx.beginPath();
        ctx.arc(wpx, wpy, 5, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    animRef.current = requestAnimationFrame(draw);
  }, [robots, robotHistory, selectedRobot, waypoints, activePaths, canvasSize, cmToCanvas, corridor, crossWaypoints, mousePos, obstacles, drawingPoints, actionStops]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(draw);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [draw]);

  return (
    <div className="arena-container" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="arena-canvas"
        style={{ width: canvasSize, height: canvasSize, cursor: interactionMode !== 'none' ? 'crosshair' : 'default' }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      />
      {mousePos && (
        <div className="arena-mouse-pos">
          ({mousePos.x}, {mousePos.y}) cm
        </div>
      )}
      {tooltip && (
        <div
          className="arena-tooltip glass"
          style={{ left: Math.min(tooltip.screenX + 12, window.innerWidth - 220), top: tooltip.screenY - 10 }}
          onClick={(e) => { e.stopPropagation(); setTooltip(null); }}
        >
          {tooltip.type === 'robot' && (
            <>
              <div className="tt-title">{tooltip.robotId}</div>
              <div className="tt-row"><span>Speed</span><span>{tooltip.data.speed_cm_s != null ? `${Number(tooltip.data.speed_cm_s).toFixed(1)} cm/s` : '--'}</span></div>
              <div className="tt-row"><span>Heading</span><span>{tooltip.data.theta_deg != null ? `${Number(tooltip.data.theta_deg).toFixed(0)}°` : '--'}</span></div>
              <div className="tt-row"><span>Battery</span><span>{tooltip.data.battery_v != null ? `${Number(tooltip.data.battery_v).toFixed(1)}V` : '--'}</span></div>
              <div className="tt-row"><span>Gripper</span><span>{tooltip.data.gripper_closed ? 'CLOSED' : 'OPEN'}</span></div>
              {tooltip.taskName && <div className="tt-row"><span>Task</span><span>{tooltip.taskName}</span></div>}
              {tooltip.nextStep && <div className="tt-row"><span>Next</span><span>{tooltip.nextStep.type === 'navigate' ? `Go → ${tooltip.nextStep.stop_name || 'point'}` : tooltip.nextStep.type}</span></div>}
            </>
          )}
          {tooltip.type === 'stop' && (
            <>
              <div className="tt-title">{tooltip.stop.name}</div>
              <div className="tt-row"><span>Position</span><span>({tooltip.stop.x_cm}, {tooltip.stop.y_cm})</span></div>
              {tooltip.queue.length === 0 ? (
                <div className="tt-empty">No robots queued</div>
              ) : (
                tooltip.queue.map((entry, i) => (
                  <div key={i} className="tt-queue-row">
                    <span className="tt-queue-pos">#{entry.queue_position}</span>
                    <span className="tt-queue-robot">{entry.robot_id}</span>
                    <span className="tt-queue-eta">~{entry.est_wait_s}s</span>
                  </div>
                ))
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
