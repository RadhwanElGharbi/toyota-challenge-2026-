import { useState, useCallback, useEffect, useRef } from 'react';
import useWebSocket from './hooks/useWebSocket';
import Sidebar from './components/Sidebar';
import Arena from './components/Arena';
import Arena3D from './components/Arena3D';
import ViewToggle from './components/ViewToggle';
import BottomPanel from './components/BottomPanel';
import ActionWheel from './components/ActionWheel';
import './App.css';

const CHARGE_POS = { x_cm: 380, y_cm: 380 };
const CALIB_POS = { x_cm: 20, y_cm: 20 };
const CORRIDOR_HALF_W = 30;
const EDGE_SNAP = 30;

function snapToEdge(point) {
  const s = { x_cm: point.x_cm, y_cm: point.y_cm };
  let isEdge = false;
  if (s.x_cm <= EDGE_SNAP) { s.x_cm = 0; isEdge = true; }
  else if (s.x_cm >= 400 - EDGE_SNAP) { s.x_cm = 400; isEdge = true; }
  if (s.y_cm <= EDGE_SNAP) { s.y_cm = 0; isEdge = true; }
  else if (s.y_cm >= 400 - EDGE_SNAP) { s.y_cm = 400; isEdge = true; }
  return { point: s, isEdge };
}

function pointToSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
}

function segmentsIntersect(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d1 = (x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3);
  const d2 = (x4 - x3) * (y2 - y3) - (y4 - y3) * (x2 - x3);
  const d3 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
  const d4 = (x2 - x1) * (y4 - y1) - (y2 - y1) * (x4 - x1);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function pathIntersectsCorridor(robotData, pathWaypoints, corridor) {
  const cWps = corridor.waypoints;

  const pts = [];
  if (robotData?.x_cm != null && robotData?.y_cm != null) {
    pts.push({ x: robotData.x_cm, y: robotData.y_cm });
  }
  pathWaypoints.forEach(wp => pts.push({ x: wp.x_cm, y: wp.y_cm }));

  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = 0; j < cWps.length - 1; j++) {
      if (segmentsIntersect(
        pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y,
        cWps[j].x_cm, cWps[j].y_cm, cWps[j + 1].x_cm, cWps[j + 1].y_cm
      )) return true;

      if (pointToSegDist(pts[i].x, pts[i].y, cWps[j].x_cm, cWps[j].y_cm, cWps[j + 1].x_cm, cWps[j + 1].y_cm) < CORRIDOR_HALF_W) return true;
      if (pointToSegDist(pts[i + 1].x, pts[i + 1].y, cWps[j].x_cm, cWps[j].y_cm, cWps[j + 1].x_cm, cWps[j + 1].y_cm) < CORRIDOR_HALF_W) return true;
    }
  }

  return false;
}

export default function App() {
  const { robots, connected, sendCommand, robotHistory, historyVersion, tasks, stopQueues, savedState, savedStateVersion } = useWebSocket();
  const [selectedRobot, setSelectedRobot] = useState(null);
  const [waypoints, setWaypoints] = useState([]);
  const [activePaths, setActivePaths] = useState({});
  const [viewMode, setViewMode] = useState('2d');
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 768);
  const [bottomOpen, setBottomOpen] = useState(false);
  const prevStates = useRef({});

  const [routeMode, setRouteMode] = useState(false);
  const [actionWheel, setActionWheel] = useState(null);
  const [crossMode, setCrossMode] = useState(false);
  const [crossWaypoints, setCrossWaypoints] = useState([]);
  const [corridor, setCorridor] = useState(null);
  const [pausedForCrossing, setPausedForCrossing] = useState([]);
  const [obstacles, setObstacles] = useState([]);
  const [drawObstacleMode, setDrawObstacleMode] = useState(false);
  const [drawingPoints, setDrawingPoints] = useState([]);
  const [actionStops, setActionStops] = useState([]);
  const [placeStopMode, setPlaceStopMode] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (savedState && !loadedRef.current) {
      loadedRef.current = true;
      if (savedState.obstacles) setObstacles(savedState.obstacles);
      if (savedState.action_stops) setActionStops(savedState.action_stops);
    }
  }, [savedStateVersion]);

  const handleArenaClick = useCallback((point) => {
    if (crossMode) {
      const { point: snapped, isEdge } = snapToEdge(point);

      if (crossWaypoints.length === 0) {
        if (!isEdge) return;
        setCrossWaypoints([snapped]);
      } else if (isEdge) {
        const finalWps = [...crossWaypoints, snapped];
        const newCorridor = { waypoints: finalWps };
        setCorridor(newCorridor);
        setCrossMode(false);
        setCrossWaypoints([]);

        const toPause = [];
        Object.entries(activePaths).forEach(([robotId, pathData]) => {
          if (pathData.waypoints?.length > 0) {
            if (pathIntersectsCorridor(robots[robotId], pathData.waypoints, newCorridor)) {
              toPause.push(robotId);
            }
          }
        });
        toPause.forEach(id => sendCommand({ type: 'pause', robot_id: id, reason: 'crossing' }));
        setPausedForCrossing(toPause);
      } else {
        setCrossWaypoints(prev => [...prev, point]);
      }
      return;
    }

    if (drawObstacleMode) {
      const CLOSE_DIST = 15;
      if (drawingPoints.length >= 3) {
        const first = drawingPoints[0];
        const dx = point.x_cm - first.x_cm;
        const dy = point.y_cm - first.y_cm;
        if (Math.sqrt(dx * dx + dy * dy) < CLOSE_DIST) {
          const newObs = { id: `obs_${Date.now()}`, type: 'polygon', points: [...drawingPoints] };
          setObstacles(prev => [...prev, newObs]);
          setDrawingPoints([]);
          setDrawObstacleMode(false);
          return;
        }
      }
      setDrawingPoints(prev => [...prev, point]);
      return;
    }

    if (placeStopMode) {
      const name = window.prompt('Action stop name:');
      if (name && name.trim()) {
        setActionStops(prev => [...prev, { id: `stop_${Date.now()}`, name: name.trim(), x_cm: point.x_cm, y_cm: point.y_cm }]);
      }
      setPlaceStopMode(false);
      return;
    }

    if (routeMode) {
      setWaypoints(prev => [...prev, point]);
    }
  }, [crossMode, crossWaypoints, activePaths, robots, sendCommand, drawObstacleMode, drawingPoints, placeStopMode, routeMode]);

  const handleArenaRightClick = useCallback((data) => {
    if (crossMode) {
      setCrossMode(false);
      setCrossWaypoints([]);
    }
    setActionWheel({
      screenX: data.screenX,
      screenY: data.screenY,
      x_cm: data.x_cm,
      y_cm: data.y_cm,
    });
  }, [crossMode]);

  const handleActionSelect = useCallback((actionId) => {
    const pos = actionWheel;
    setActionWheel(null);

    const sendPath = (target) => {
      if (!selectedRobot) return;
      const wps = [{ x_cm: target.x_cm, y_cm: target.y_cm }];
      sendCommand({
        type: 'path_assignment',
        robot_id: selectedRobot,
        path_id: Date.now(),
        replace_existing: true,
        waypoints: wps,
        motion: { turn_speed_deg_per_sec: 150, drive_speed_deg_per_sec: 200 },
      });
      setActivePaths(prev => ({ ...prev, [selectedRobot]: { waypoints: wps } }));
    };

    switch (actionId) {
      case 'move':
        sendPath({ x_cm: pos.x_cm, y_cm: pos.y_cm });
        break;
      case 'charge':
        sendPath(CHARGE_POS);
        break;
      case 'calibrate':
        if (selectedRobot) {
          sendCommand({
            type: 'calibrate',
            robot_id: selectedRobot,
            x_cm: CALIB_POS.x_cm,
            y_cm: CALIB_POS.y_cm,
            theta_deg: 0,
          });
        }
        break;
      case 'cross':
        setCrossMode(true);
        setCrossWaypoints([]);
        break;
    }
  }, [actionWheel, selectedRobot, sendCommand]);

  const handleActionClose = useCallback(() => setActionWheel(null), []);

  const clearCorridor = useCallback(() => {
    pausedForCrossing.forEach(id => sendCommand({ type: 'resume', robot_id: id }));
    setPausedForCrossing([]);
    setCorridor(null);
  }, [pausedForCrossing, sendCommand]);

  const handleArenaDoubleClick = useCallback((point) => {
    if (drawObstacleMode && drawingPoints.length >= 1) {
      const allPts = [...drawingPoints, point];
      const type = allPts.length === 2 ? 'line' : 'polygon';
      setObstacles(prev => [...prev, { id: `obs_${Date.now()}`, type, points: allPts }]);
      setDrawingPoints([]);
      setDrawObstacleMode(false);
    }
  }, [drawObstacleMode, drawingPoints]);

  useEffect(() => {
    const fn = (e) => {
      if (e.key === 'Escape') {
        if (crossMode) { setCrossMode(false); setCrossWaypoints([]); }
        if (drawObstacleMode) { setDrawObstacleMode(false); setDrawingPoints([]); }
        if (placeStopMode) { setPlaceStopMode(false); }
        if (routeMode) { setRouteMode(false); setWaypoints([]); }
      }
    };
    window.addEventListener('keydown', fn);
    return () => window.removeEventListener('keydown', fn);
  }, [crossMode, drawObstacleMode, placeStopMode, routeMode]);

  const handleSetRoute = useCallback(() => {
    if (!selectedRobot) return;
    setRouteMode(true);
    setWaypoints([]);
    setBottomOpen(true);
  }, [selectedRobot]);

  const handleCancelRoute = useCallback(() => {
    setRouteMode(false);
    setWaypoints([]);
  }, []);

  const handleSelectRobot = useCallback((robotId) => {
    setSelectedRobot(robotId);
    if (routeMode) { setRouteMode(false); setWaypoints([]); }
  }, [routeMode]);

  const handlePathSent = useCallback((robotId, sentWaypoints) => {
    setRouteMode(false);
    setActivePaths(prev => ({
      ...prev,
      [robotId]: { waypoints: sentWaypoints },
    }));
  }, []);

  const handleDeleteObstacle = useCallback((id) => {
    setObstacles(prev => prev.filter(o => o.id !== id));
  }, []);

  const handleDeleteStop = useCallback((id) => {
    setActionStops(prev => prev.filter(s => s.id !== id));
  }, []);

  useEffect(() => {
    sendCommand({ type: 'set_obstacles', obstacles });
  }, [obstacles, sendCommand]);

  useEffect(() => {
    sendCommand({ type: 'set_action_stops', stops: actionStops });
  }, [actionStops, sendCommand]);

  useEffect(() => {
    Object.entries(robots).forEach(([id, data]) => {
      prevStates.current[id] = data.state;
    });
  }, [robots]);

  const ArenaComponent = viewMode === '2d' ? Arena : Arena3D;

  return (
    <div className="app-layout">
      <div className="arena-fullscreen">
        <ArenaComponent
          robots={robots}
          robotHistory={robotHistory}
          selectedRobot={selectedRobot}
          waypoints={waypoints}
          activePaths={activePaths}
          onArenaClick={handleArenaClick}
          onDoubleClick={handleArenaDoubleClick}
          onRightClick={handleArenaRightClick}
          corridor={corridor}
          crossWaypoints={crossMode ? crossWaypoints : null}
          obstacles={obstacles}
          drawingPoints={drawObstacleMode ? drawingPoints : null}
          actionStops={actionStops}
          stopQueues={stopQueues}
          tasks={tasks}
          interactionMode={routeMode ? 'route' : drawObstacleMode ? 'drawObstacle' : placeStopMode ? 'placeStop' : crossMode ? 'cross' : 'none'}
        />
      </div>

      <ViewToggle mode={viewMode} onToggle={setViewMode} />

      {crossMode && (
        <div className="cross-mode-banner glass">
          {crossWaypoints.length === 0
            ? 'Click on an arena edge to start crossing path'
            : 'Click to add waypoints • Click on an edge to finish • ESC to cancel'}
        </div>
      )}

      {drawObstacleMode && (
        <div className="cross-mode-banner glass" style={{ color: '#f87171' }}>
          {drawingPoints.length === 0
            ? 'Click to place obstacle points • Double-click to finish • ESC to cancel'
            : `${drawingPoints.length} point${drawingPoints.length > 1 ? 's' : ''} • Click near first to close polygon • Double-click to finish • ESC to cancel`}
        </div>
      )}

      {placeStopMode && (
        <div className="cross-mode-banner glass" style={{ color: '#22d3ee' }}>
          Click on the arena to place an action stop • ESC to cancel
        </div>
      )}

      {routeMode && (
        <div className="cross-mode-banner glass" style={{ color: '#a5b4fc' }}>
          Click to add waypoints • Send Path when ready • ESC to cancel
        </div>
      )}

      {corridor && (
        <button className="btn-clear-crossing glass" onClick={clearCorridor}>
          &times; Clear Crossing
        </button>
      )}

      {actionWheel && (
        <ActionWheel
          x={actionWheel.screenX}
          y={actionWheel.screenY}
          onSelect={handleActionSelect}
          onClose={handleActionClose}
          hasRobot={!!selectedRobot}
        />
      )}

      <button
        className={`panel-toggle toggle-sidebar ${sidebarOpen ? 'shifted' : ''}`}
        onClick={() => setSidebarOpen(v => !v)}
        title={sidebarOpen ? 'Hide panel' : 'Show panel'}
      >
        {sidebarOpen ? '←' : '→'}
      </button>

      <button
        className="panel-toggle toggle-bottom"
        onClick={() => setBottomOpen(v => !v)}
        title={bottomOpen ? 'Hide planner' : 'Show planner'}
      >
        {bottomOpen ? '↓' : '↑'}
      </button>

      <div className={`sidebar-overlay glass ${sidebarOpen ? '' : 'collapsed'}`}>
        <Sidebar
          robots={robots}
          selectedRobot={selectedRobot}
          onSelectRobot={handleSelectRobot}
          sendCommand={sendCommand}
          connected={connected}
          routeMode={routeMode}
          onSetRoute={handleSetRoute}
          onDrawObstacle={() => { setDrawObstacleMode(true); setDrawingPoints([]); }}
          drawObstacleMode={drawObstacleMode}
          onPlaceStop={() => setPlaceStopMode(true)}
          placeStopMode={placeStopMode}
          obstacles={obstacles}
          onDeleteObstacle={handleDeleteObstacle}
          actionStops={actionStops}
          onDeleteStop={handleDeleteStop}
          tasks={tasks}
        />
      </div>

      <div className={`bottom-overlay glass ${bottomOpen ? '' : 'collapsed'} ${sidebarOpen ? '' : 'sidebar-gone'}`}>
        <BottomPanel
          robots={robots}
          selectedRobot={selectedRobot}
          waypoints={waypoints}
          setWaypoints={setWaypoints}
          sendCommand={sendCommand}
          onPathSent={handlePathSent}
          routeMode={routeMode}
          onCancelRoute={handleCancelRoute}
        />
      </div>
    </div>
  );
}
