import { useRef, useMemo, useCallback, useState } from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Line, Text, Html } from '@react-three/drei';
import * as THREE from 'three';

const ARENA_CM = 400;
const ROBOT_LENGTH_CM = 40;
const ROBOT_WIDTH_CM = 30;
const ROBOT_COLORS = ['#00aaff', '#ff0033', '#00cc88', '#ff8800', '#c084fc', '#fb923c', '#f472b6', '#a3e635'];
const CM_TO_UNITS = 0.01; // 1 cm = 0.01 Three.js units → arena = 4x4

const CALIB_ZONE = { x: 0, y: 0, w: 40, h: 40 };
const CHARGE_ZONE = { x: 360, y: 360, w: 40, h: 40 };
const CORRIDOR_WIDTH_CM = 60;

function getRobotColor(robotId, allIds) {
  const sorted = [...allIds].sort();
  const idx = sorted.indexOf(robotId);
  return ROBOT_COLORS[idx % ROBOT_COLORS.length];
}

function cmToWorld(xCm, yCm, zCm = 0) {
  return [xCm * CM_TO_UNITS, zCm * CM_TO_UNITS, -yCm * CM_TO_UNITS];
}

function GroundPlane({ onArenaClick, onRightClick }) {
  const meshRef = useRef();

  const getArenaCm = useCallback((e) => {
    const point = e.point;
    const xCm = point.x / CM_TO_UNITS;
    const yCm = -point.z / CM_TO_UNITS;
    return {
      x_cm: Math.max(0, Math.min(ARENA_CM, Math.round(xCm * 10) / 10)),
      y_cm: Math.max(0, Math.min(ARENA_CM, Math.round(yCm * 10) / 10)),
    };
  }, []);

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    if (onArenaClick) onArenaClick(getArenaCm(e));
  }, [onArenaClick, getArenaCm]);

  const handleContextMenu = useCallback((e) => {
    e.stopPropagation();
    const cm = getArenaCm(e);
    if (onRightClick) {
      onRightClick({
        screenX: e.nativeEvent?.clientX ?? e.clientX ?? 0,
        screenY: e.nativeEvent?.clientY ?? e.clientY ?? 0,
        x_cm: cm.x_cm,
        y_cm: cm.y_cm,
      });
    }
  }, [onRightClick, getArenaCm]);

  return (
    <mesh
      ref={meshRef}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[ARENA_CM * CM_TO_UNITS / 2, -0.001, -ARENA_CM * CM_TO_UNITS / 2]}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <planeGeometry args={[ARENA_CM * CM_TO_UNITS, ARENA_CM * CM_TO_UNITS]} />
      <meshStandardMaterial color="#080810" transparent opacity={0.95} />
    </mesh>
  );
}

function ArenaBorder() {
  const s = ARENA_CM * CM_TO_UNITS;
  const points = [
    [0, 0, 0],
    [s, 0, 0],
    [s, 0, -s],
    [0, 0, -s],
    [0, 0, 0],
  ];
  return (
    <Line
      points={points}
      color="rgba(255,255,255,0.15)"
      lineWidth={1.5}
    />
  );
}

function AxisLabels() {
  const labels = [];
  for (let i = 0; i <= ARENA_CM; i += 100) {
    const pos = i * CM_TO_UNITS;
    labels.push(
      <Text
        key={`x-${i}`}
        position={[pos, 0.001, 0.12]}
        fontSize={0.08}
        color="rgba(255,255,255,0.25)"
        anchorX="center"
        anchorY="top"
      >
        {`${i}`}
      </Text>
    );
    labels.push(
      <Text
        key={`y-${i}`}
        position={[-0.12, 0.001, -pos]}
        fontSize={0.08}
        color="rgba(255,255,255,0.25)"
        anchorX="center"
        anchorY="top"
      >
        {`${i}`}
      </Text>
    );
  }
  return <>{labels}</>;
}

function ArenaGrid() {
  return (
    <Grid
      position={[ARENA_CM * CM_TO_UNITS / 2, 0, -ARENA_CM * CM_TO_UNITS / 2]}
      args={[ARENA_CM * CM_TO_UNITS, ARENA_CM * CM_TO_UNITS]}
      cellSize={0.5}
      cellThickness={0.5}
      cellColor="#111122"
      sectionSize={1}
      sectionThickness={1}
      sectionColor="#1a1a2e"
      fadeDistance={20}
      infiniteGrid={false}
    />
  );
}

function ChargingZone() {
  const x1 = CHARGE_ZONE.x * CM_TO_UNITS;
  const y1 = CHARGE_ZONE.y * CM_TO_UNITS;
  const w = CHARGE_ZONE.w * CM_TO_UNITS;
  const h = CHARGE_ZONE.h * CM_TO_UNITS;
  const cx = x1 + w / 2;
  const cz = -(y1 + h / 2);
  const crossR = 0.06;

  const borderPoints = [
    [x1, 0.002, -y1],
    [x1 + w, 0.002, -y1],
    [x1 + w, 0.002, -(y1 + h)],
    [x1, 0.002, -(y1 + h)],
    [x1, 0.002, -y1],
  ];

  return (
    <group>
      <mesh position={[cx, 0.001, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color="#34d399" transparent opacity={0.04} side={THREE.DoubleSide} />
      </mesh>
      <Line
        points={borderPoints}
        color="#34d399"
        lineWidth={1.5}
        transparent
        opacity={0.6}
        dashed
        dashSize={0.06}
        gapSize={0.04}
      />
      <Line
        points={[[cx - crossR, 0.003, cz], [cx + crossR, 0.003, cz]]}
        color="#34d399"
        lineWidth={1}
        transparent
        opacity={0.4}
      />
      <Line
        points={[[cx, 0.003, cz - crossR], [cx, 0.003, cz + crossR]]}
        color="#34d399"
        lineWidth={1}
        transparent
        opacity={0.4}
      />
      <Text
        position={[cx, 0.003, -y1 + 0.06]}
        fontSize={0.06}
        color="#34d399"
        anchorX="center"
        anchorY="bottom"
        fillOpacity={0.5}
      >
        CHARGING
      </Text>
    </group>
  );
}

function CorridorOverlay3D({ corridor }) {
  if (!corridor || !corridor.waypoints || corridor.waypoints.length < 2) return null;

  const wps = corridor.waypoints;
  const corridorW = CORRIDOR_WIDTH_CM * CM_TO_UNITS;

  return (
    <group>
      {wps.map((wp, i) => {
        if (i >= wps.length - 1) return null;
        const next = wps[i + 1];
        const dx = next.x_cm - wp.x_cm;
        const dy = next.y_cm - wp.y_cm;
        const len = Math.sqrt(dx * dx + dy * dy) * CM_TO_UNITS;
        const midX = (wp.x_cm + next.x_cm) / 2;
        const midY = (wp.y_cm + next.y_cm) / 2;
        const [mx, , mz] = cmToWorld(midX, midY, 0);
        const rotY = -Math.atan2(dy, dx);

        return (
          <group key={i} position={[mx, 0.004, mz]} rotation={[0, rotY, 0]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[len, corridorW]} />
              <meshBasicMaterial color="#fbbf24" transparent opacity={0.06} side={THREE.DoubleSide} />
            </mesh>
          </group>
        );
      })}

      {wps.map((wp, i) => {
        const [wx, , wz] = cmToWorld(wp.x_cm, wp.y_cm, 0);
        return (
          <mesh key={`cap-${i}`} position={[wx, 0.004, wz]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[corridorW / 2, 32]} />
            <meshBasicMaterial color="#fbbf24" transparent opacity={0.06} side={THREE.DoubleSide} />
          </mesh>
        );
      })}

      {wps.length > 1 && (
        <Line
          points={wps.map(wp => cmToWorld(wp.x_cm, wp.y_cm, 0.006))}
          color="#fbbf24"
          lineWidth={2}
          transparent
          opacity={0.5}
          dashed
          dashSize={0.06}
          gapSize={0.04}
        />
      )}

      {wps.map((wp, i) => {
        const [wx, , wz] = cmToWorld(wp.x_cm, wp.y_cm, 0.008);
        const isEnd = i === 0 || i === wps.length - 1;
        return (
          <mesh key={`node-${i}`} position={[wx, 0.008, wz]}>
            <sphereGeometry args={[isEnd ? 0.05 : 0.03, 16, 16]} />
            <meshStandardMaterial
              color="#fbbf24"
              emissive="#fbbf24"
              emissiveIntensity={0.5}
              transparent
              opacity={0.8}
            />
          </mesh>
        );
      })}

      {(() => {
        const mid = wps[Math.floor(wps.length / 2)];
        const [lx, , lz] = cmToWorld(mid.x_cm, mid.y_cm, 0);
        return (
          <Text
            position={[lx, 0.15, lz]}
            fontSize={0.08}
            color="#fbbf24"
            anchorX="center"
            anchorY="middle"
            fillOpacity={0.6}
          >
            CROSSING
          </Text>
        );
      })()}
    </group>
  );
}

function CrossPreview3D({ crossWaypoints }) {
  if (!crossWaypoints || crossWaypoints.length === 0) return null;

  const points = crossWaypoints.map(wp => cmToWorld(wp.x_cm, wp.y_cm, 0.006));

  return (
    <group>
      {points.length > 1 && (
        <Line
          points={points}
          color="#fbbf24"
          lineWidth={2}
          transparent
          opacity={0.4}
          dashed
          dashSize={0.05}
          gapSize={0.04}
        />
      )}
      {crossWaypoints.map((wp, i) => {
        const [wx, , wz] = cmToWorld(wp.x_cm, wp.y_cm, 0.008);
        return (
          <mesh key={i} position={[wx, 0.008, wz]}>
            <sphereGeometry args={[0.04, 16, 16]} />
            <meshStandardMaterial
              color="#fbbf24"
              emissive="#fbbf24"
              emissiveIntensity={0.5}
              transparent
              opacity={0.7}
            />
          </mesh>
        );
      })}
    </group>
  );
}

function CalibrationZone() {
  const x1 = CALIB_ZONE.x * CM_TO_UNITS;
  const y1 = CALIB_ZONE.y * CM_TO_UNITS;
  const w = CALIB_ZONE.w * CM_TO_UNITS;
  const h = CALIB_ZONE.h * CM_TO_UNITS;
  const cx = x1 + w / 2;
  const cz = -(y1 + h / 2);
  const crossR = 0.06;

  const borderPoints = [
    [x1, 0.002, -y1],
    [x1 + w, 0.002, -y1],
    [x1 + w, 0.002, -(y1 + h)],
    [x1, 0.002, -(y1 + h)],
    [x1, 0.002, -y1],
  ];

  return (
    <group>
      {/* Fill */}
      <mesh position={[cx, 0.001, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[w, h]} />
        <meshBasicMaterial color="#ffd93d" transparent opacity={0.04} side={THREE.DoubleSide} />
      </mesh>

      {/* Border */}
      <Line
        points={borderPoints}
        color="#ffd93d"
        lineWidth={1.5}
        transparent
        opacity={0.6}
        dashed
        dashSize={0.06}
        gapSize={0.04}
      />

      {/* Crosshair */}
      <Line
        points={[[cx - crossR, 0.003, cz], [cx + crossR, 0.003, cz]]}
        color="#ffd93d"
        lineWidth={1}
        transparent
        opacity={0.4}
      />
      <Line
        points={[[cx, 0.003, cz - crossR], [cx, 0.003, cz + crossR]]}
        color="#ffd93d"
        lineWidth={1}
        transparent
        opacity={0.4}
      />

      {/* Label */}
      <Text
        position={[cx, 0.003, -y1 + 0.06]}
        fontSize={0.06}
        color="#ffd93d"
        anchorX="center"
        anchorY="bottom"
        fillOpacity={0.5}
      >
        CALIBRATION
      </Text>
    </group>
  );
}

function RobotModel({ robotId, data, allIds, isSelected, tasks }) {
  const [showInfo, setShowInfo] = useState(false);
  const color = getRobotColor(robotId, allIds);
  const meshRef = useRef();
  const arrowRef = useRef();

  const x = data.x_cm ?? 0;
  const y = data.y_cm ?? 0;
  const theta = data.theta_deg ?? 0;
  const thetaRad = (theta * Math.PI) / 180;

  const [wx, wy, wz] = cmToWorld(x, y, 0);
  const bodyHeight = 0.12;
  const pos = [wx, bodyHeight / 2 + 0.001, wz];

  const bodyW = ROBOT_WIDTH_CM * CM_TO_UNITS;
  const bodyL = ROBOT_LENGTH_CM * CM_TO_UNITS;
  const halfW = bodyW / 2;
  const halfL = bodyL / 2;

  return (
    <group position={[wx, 0, wz]} rotation={[0, thetaRad - Math.PI / 2, 0]}>
      {/* Robot body — width along X, length along Z (front = -Z) */}
      <mesh position={[0, bodyHeight / 2 + 0.001, 0]} castShadow>
        <boxGeometry args={[bodyW, bodyHeight, bodyL]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={isSelected ? 0.6 : 0.3}
          metalness={0.4}
          roughness={0.6}
        />
      </mesh>

      {/* Direction indicator (front arrow) */}
      <mesh position={[0, bodyHeight / 2 + 0.001, -(halfL + 0.05)]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <coneGeometry args={[0.04, 0.08, 8]} />
        <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.3} />
      </mesh>

      {/* Selection ring */}
      {isSelected && (
        <mesh position={[0, 0.005, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[halfL, halfL + 0.03, 32]} />
          <meshBasicMaterial color={color} transparent opacity={0.7} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Glow point light */}
      <pointLight color={color} intensity={isSelected ? 1.5 : 0.6} distance={1} position={[0, 0.15, 0]} />

      {/* Label */}
      <Html position={[0, 0.25, 0]} center distanceFactor={4}>
        <div
          style={{ cursor: 'pointer', userSelect: 'none' }}
          onClick={(e) => { e.stopPropagation(); setShowInfo(v => !v); }}
        >
          <div style={{
            color: '#fff', fontSize: '11px',
            fontFamily: "'IBM Plex Mono', monospace",
            background: 'rgba(0,0,0,0.7)', padding: '1px 6px',
            border: `1px solid ${color}`, whiteSpace: 'nowrap',
          }}>
            {robotId}
          </div>
          {showInfo && (() => {
            const task = (tasks || []).find(t => t.robot_id === robotId && t.status === 'active');
            const ns = task && task.current_step < task.steps.length ? task.steps[task.current_step] : null;
            return (
              <div className="arena-tooltip" style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 4, width: 170, zIndex: 100 }}>
                <div className="tt-row"><span>Speed</span><span>{data.speed_cm_s != null ? `${Number(data.speed_cm_s).toFixed(1)}` : '--'}</span></div>
                <div className="tt-row"><span>Heading</span><span>{data.theta_deg != null ? `${Number(data.theta_deg).toFixed(0)}°` : '--'}</span></div>
                <div className="tt-row"><span>Battery</span><span>{data.battery_v != null ? `${Number(data.battery_v).toFixed(1)}V` : '--'}</span></div>
                <div className="tt-row"><span>Gripper</span><span>{data.gripper_closed ? 'CLOSED' : 'OPEN'}</span></div>
                {task && <div className="tt-row"><span>Task</span><span>{task.name}</span></div>}
                {ns && <div className="tt-row"><span>Next</span><span>{ns.type === 'navigate' ? `→ ${ns.stop_name || 'point'}` : ns.type}</span></div>}
              </div>
            );
          })()}
        </div>
      </Html>

      {/* Front ultrasonic ray */}
      {data.front_ultrasonic_cm != null && data.front_ultrasonic_cm > 0 && data.front_ultrasonic_cm <= 200 && (
        <Line
          points={[
            [0, bodyHeight / 2, -halfL],
            [0, bodyHeight / 2, -halfL - data.front_ultrasonic_cm * CM_TO_UNITS],
          ]}
          color={color}
          lineWidth={1}
          transparent
          opacity={0.4}
          dashed
          dashSize={0.03}
          gapSize={0.03}
        />
      )}

      {/* Safety box */}
      <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[bodyW, bodyL]} />
        <meshBasicMaterial color={color} transparent opacity={0.06} side={THREE.DoubleSide} />
      </mesh>
      <Line
        points={[
          [-halfW, 0.003, -halfL],
          [halfW, 0.003, -halfL],
          [halfW, 0.003, halfL],
          [-halfW, 0.003, halfL],
          [-halfW, 0.003, -halfL],
        ]}
        color={color}
        lineWidth={1}
        transparent
        opacity={0.25}
        dashed
        dashSize={0.04}
        gapSize={0.03}
      />
    </group>
  );
}

function RobotTrail({ robotId, history, allIds }) {
  const color = getRobotColor(robotId, allIds);

  const points = useMemo(() => {
    if (!history || history.length < 2) return null;
    return history.map(h => cmToWorld(h.x, h.y, 0.005));
  }, [history]);

  if (!points) return null;

  return (
    <Line
      points={points}
      color={color}
      lineWidth={1.5}
      transparent
      opacity={0.3}
    />
  );
}

function WaypointMarkers({ waypoints }) {
  if (!waypoints || waypoints.length === 0) return null;

  const linePoints = waypoints.map(wp => cmToWorld(wp.x_cm, wp.y_cm, 0.01));

  return (
    <group>
      {waypoints.length > 1 && (
        <Line
          points={linePoints}
          color="#ffd93d"
          lineWidth={2}
          dashed
          dashSize={0.06}
          gapSize={0.04}
        />
      )}
      {waypoints.map((wp, idx) => {
        const [wx, wy, wz] = cmToWorld(wp.x_cm, wp.y_cm, 0.01);
        return (
          <group key={idx} position={[wx, wy, wz]}>
            <mesh rotation={[0, Math.PI / 4, 0]}>
              <boxGeometry args={[0.08, 0.08, 0.08]} />
              <meshStandardMaterial
                color="#ffd93d"
                emissive="#ffd93d"
                emissiveIntensity={0.5}
                metalness={0.3}
                roughness={0.5}
              />
            </mesh>
            <Html position={[0, 0.08, 0]} center style={{ pointerEvents: 'none' }}>
              <div style={{
                color: '#000',
                fontSize: '10px',
                fontWeight: 'bold',
                fontFamily: "'JetBrains Mono', monospace",
                background: '#ffd93d',
                padding: '0 4px',
                borderRadius: '2px',
                userSelect: 'none',
              }}>
                {idx + 1}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function ActivePathMarkers({ activePaths, allIds, robots }) {
  return Object.entries(activePaths || {}).map(([robotId, pathData]) => {
    if (!pathData.waypoints || pathData.waypoints.length === 0) return null;
    const color = getRobotColor(robotId, allIds);
    const wps = pathData.waypoints;
    const robotData = robots[robotId];
    const linePoints = [];
    if (robotData && robotData.x_cm != null && robotData.y_cm != null) {
      linePoints.push(cmToWorld(robotData.x_cm, robotData.y_cm, 0.01));
    }
    wps.forEach(wp => linePoints.push(cmToWorld(wp.x_cm, wp.y_cm, 0.01)));

    return (
      <group key={robotId}>
        {linePoints.length > 1 && (
          <Line
            points={linePoints}
            color={color}
            lineWidth={2}
            transparent
            opacity={0.6}
            dashed
            dashSize={0.08}
            gapSize={0.04}
          />
        )}
        {wps.map((wp, idx) => {
          const [wx, wy, wz] = cmToWorld(wp.x_cm, wp.y_cm, 0.015);
          return (
            <mesh key={idx} position={[wx, wy, wz]}>
              <sphereGeometry args={[0.04, 16, 16]} />
              <meshStandardMaterial
                color={color}
                emissive={color}
                emissiveIntensity={0.4}
                transparent
                opacity={0.8}
              />
            </mesh>
          );
        })}
      </group>
    );
  });
}

function Obstacles3D({ obstacles, drawingPoints }) {
  return (
    <group>
      {(obstacles || []).map(obs => {
        if (obs.points.length < 2) return null;
        const pts = obs.points.map(p => cmToWorld(p.x_cm, p.y_cm, 0.005));
        const closed = obs.type === 'polygon';
        const linePoints = closed ? [...pts, pts[0]] : pts;
        return (
          <group key={obs.id}>
            <Line points={linePoints} color="#f87171" lineWidth={2} transparent opacity={0.8} />
            {obs.points.map((p, i) => {
              const [wx, wy, wz] = cmToWorld(p.x_cm, p.y_cm, 0.008);
              return (
                <mesh key={i} position={[wx, wy, wz]}>
                  <sphereGeometry args={[0.025, 8, 8]} />
                  <meshBasicMaterial color="#f87171" />
                </mesh>
              );
            })}
            {closed && obs.points.length >= 3 && (
              <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
                <shapeGeometry args={[(() => {
                  const shape = new THREE.Shape();
                  const first = obs.points[0];
                  shape.moveTo(first.x_cm * CM_TO_UNITS, first.y_cm * CM_TO_UNITS);
                  for (let i = 1; i < obs.points.length; i++) {
                    shape.lineTo(obs.points[i].x_cm * CM_TO_UNITS, obs.points[i].y_cm * CM_TO_UNITS);
                  }
                  shape.closePath();
                  return shape;
                })()]} />
                <meshBasicMaterial color="#f87171" transparent opacity={0.1} side={THREE.DoubleSide} />
              </mesh>
            )}
          </group>
        );
      })}
      {drawingPoints && drawingPoints.length > 0 && (
        <group>
          <Line
            points={drawingPoints.map(p => cmToWorld(p.x_cm, p.y_cm, 0.006))}
            color="#f87171"
            lineWidth={2}
            transparent
            opacity={0.6}
            dashed
            dashSize={0.06}
            gapSize={0.04}
          />
          {drawingPoints.map((p, i) => {
            const [wx, wy, wz] = cmToWorld(p.x_cm, p.y_cm, 0.008);
            return (
              <mesh key={i} position={[wx, wy, wz]}>
                <sphereGeometry args={[0.03, 8, 8]} />
                <meshBasicMaterial color="#f87171" />
              </mesh>
            );
          })}
        </group>
      )}
    </group>
  );
}

function ActionStops3D({ actionStops, stopQueues }) {
  const [expanded, setExpanded] = useState(null);
  if (!actionStops || actionStops.length === 0) return null;
  return (
    <group>
      {actionStops.map(stop => {
        const [wx, wy, wz] = cmToWorld(stop.x_cm, stop.y_cm, 0);
        const q = (stopQueues || {})[stop.id] || [];
        const isExpanded = expanded === stop.id;
        return (
          <group key={stop.id} position={[wx, 0, wz]}>
            <mesh position={[0, 0.04, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 0.08, 16]} />
              <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={0.4} />
            </mesh>
            <mesh position={[0, 0.003, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.06, 0.08, 16]} />
              <meshBasicMaterial color="#22d3ee" transparent opacity={0.3} side={THREE.DoubleSide} />
            </mesh>
            <Html position={[0, 0.14, 0]} center distanceFactor={4}>
              <div
                style={{ cursor: 'pointer', userSelect: 'none' }}
                onClick={(e) => { e.stopPropagation(); setExpanded(isExpanded ? null : stop.id); }}
              >
                <div style={{
                  color: '#22d3ee', fontSize: '10px', fontWeight: 'bold',
                  fontFamily: "'IBM Plex Mono', monospace",
                  background: 'rgba(0,0,0,0.6)', padding: '1px 5px',
                  whiteSpace: 'nowrap',
                }}>
                  {stop.name} {q.length > 0 ? `(${q.length})` : ''}
                </div>
                {isExpanded && (
                  <div className="arena-tooltip" style={{ position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 4, width: 180, zIndex: 100 }}>
                    {q.length === 0 ? (
                      <div className="tt-empty">No queue</div>
                    ) : (
                      q.map((entry, i) => (
                        <div key={i} className="tt-queue-row">
                          <span className="tt-queue-pos">#{entry.queue_position}</span>
                          <span className="tt-queue-robot">{entry.robot_id}</span>
                          <span className="tt-queue-eta">~{entry.est_wait_s}s</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function SceneLighting() {
  return (
    <>
      <ambientLight intensity={0.3} />
      <directionalLight position={[3, 5, 2]} intensity={0.8} color="#b0c4de" castShadow />
      <directionalLight position={[-2, 3, -3]} intensity={0.3} color="#4466aa" />
      <pointLight position={[2, 2, -2]} intensity={0.3} color="#0044aa" />
    </>
  );
}

export default function Arena3D({ robots, robotHistory, selectedRobot, waypoints, activePaths, onArenaClick, onDoubleClick, onRightClick, corridor, crossWaypoints, obstacles, drawingPoints, actionStops, stopQueues, tasks, interactionMode }) {
  const allIds = Object.keys(robots);
  const arenaCenter = (ARENA_CM * CM_TO_UNITS) / 2;
  const longPressTimer = useRef(null);
  const longPressFired = useRef(false);

  const handleTouchStart = useCallback((e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      if (onRightClick) {
        onRightClick({
          screenX: touch.clientX,
          screenY: touch.clientY,
          x_cm: 200,
          y_cm: 200,
        });
      }
    }, 1500);
  }, [onRightClick]);

  const handleTouchEnd = useCallback((e) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (longPressFired.current) {
      e.preventDefault();
      longPressFired.current = false;
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  return (
    <div
      style={{ width: '100%', height: '100%', cursor: interactionMode !== 'none' ? 'crosshair' : 'default' }}
      onContextMenu={(e) => e.preventDefault()}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      <Canvas
        camera={{
          position: [arenaCenter + 1.5, 2.5, 1.5],
          fov: 50,
          near: 0.01,
          far: 100,
        }}
        shadows
        style={{ background: '#030306' }}
        gl={{ antialias: true }}
      >
        <fog attach="fog" args={['#030306', 6, 15]} />

        <SceneLighting />

        <GroundPlane onArenaClick={onArenaClick} onRightClick={onRightClick} />
        <ArenaBorder />
        <ArenaGrid />
        <AxisLabels />
        <CalibrationZone />
        <ChargingZone />
        <CorridorOverlay3D corridor={corridor} />
        <CrossPreview3D crossWaypoints={crossWaypoints} />
        <Obstacles3D obstacles={obstacles} drawingPoints={drawingPoints} />
        <ActionStops3D actionStops={actionStops} stopQueues={stopQueues} />

        <WaypointMarkers waypoints={waypoints} />
        <ActivePathMarkers activePaths={activePaths} allIds={allIds} robots={robots} />

        {allIds.map(robotId => (
          <RobotTrail
            key={`trail-${robotId}`}
            robotId={robotId}
            history={robotHistory[robotId]}
            allIds={allIds}
          />
        ))}

        {allIds.map(robotId => {
          const data = robots[robotId];
          if (data.x_cm == null || data.y_cm == null) return null;
          return (
            <RobotModel
              key={robotId}
              robotId={robotId}
              data={data}
              allIds={allIds}
              isSelected={robotId === selectedRobot}
              tasks={tasks}
            />
          );
        })}

        <OrbitControls
          target={[arenaCenter, 0, -arenaCenter]}
          enableDamping
          dampingFactor={0.1}
          maxPolarAngle={Math.PI / 2 - 0.05}
          minDistance={0.5}
          maxDistance={10}
        />
      </Canvas>
    </div>
  );
}
