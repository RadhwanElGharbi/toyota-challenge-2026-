import { useState } from 'react';
import TaskBuilder from './TaskBuilder';
import TaskList from './TaskList';

const ROBOT_COLORS = ['#00aaff', '#ff0033', '#00cc88', '#ff8800', '#c084fc', '#fb923c', '#f472b6', '#a3e635'];

function getRobotColor(robotId, allIds) {
  const sorted = [...allIds].sort();
  const idx = sorted.indexOf(robotId);
  return ROBOT_COLORS[idx % ROBOT_COLORS.length];
}

const STATE_COLORS = {
  idle: 'rgba(255, 255, 255, 0.3)',
  executing_path: '#0088ff',
  paused: '#ff8800',
  error: '#ff0033',
  stopped: '#ff0033',
};

function fmt(val) {
  if (val == null) return '--';
  return Number(val).toFixed(1);
}

function batteryPercent(voltage) {
  if (voltage == null) return null;
  const FULL = 14.0;
  const EMPTY = 10.0;
  const pct = Math.round(((voltage - EMPTY) / (FULL - EMPTY)) * 100);
  return Math.max(0, Math.min(100, pct));
}

export default function Sidebar({
  robots, selectedRobot, onSelectRobot, sendCommand, connected,
  routeMode, onSetRoute,
  onDrawObstacle, drawObstacleMode,
  onPlaceStop, placeStopMode,
  obstacles, onDeleteObstacle,
  actionStops, onDeleteStop,
  tasks,
}) {
  const [taskBuilderOpen, setTaskBuilderOpen] = useState(false);
  const robotIds = Object.keys(robots).sort();
  const selected = selectedRobot && robots[selectedRobot] ? robots[selectedRobot] : null;

  const sendPause = () => {
    if (!selectedRobot) return;
    sendCommand({ type: 'pause', robot_id: selectedRobot, reason: 'gui' });
  };
  const sendResume = () => {
    if (!selectedRobot) return;
    sendCommand({ type: 'resume', robot_id: selectedRobot });
  };
  const sendStop = () => {
    if (!selectedRobot) return;
    sendCommand({ type: 'stop', robot_id: selectedRobot, reason: 'gui' });
  };
  const sendToggleGripper = () => {
    if (!selectedRobot) return;
    sendCommand({ type: 'toggle_gripper', robot_id: selectedRobot });
  };

  const sendCalibrate = () => {
    if (!selectedRobot) return;
    sendCommand({
      type: 'calibrate',
      robot_id: selectedRobot,
      x_cm: 20,
      y_cm: 20,
      theta_deg: 90,
    });
  };

  const sendToStop = (stop) => {
    if (!selectedRobot) return;
    sendCommand({
      type: 'plan_path',
      robot_id: selectedRobot,
      goal_x_cm: stop.x_cm,
      goal_y_cm: stop.y_cm,
      path_id: Date.now(),
    });
  };

  return (
    <>
      <div className="sidebar-header">
        <h1 className="sidebar-title">Fleet Command</h1>
        <div className="connection-status">
          <span className={`status-dot ${connected ? 'dot-connected' : 'dot-disconnected'}`} />
          <span>{connected ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>

      {/* Robot list */}
      <div className="card">
        <h3 className="card-title">Connected Robots</h3>
        <div className="robot-list">
          {robotIds.length === 0 && (
            <div className="no-robots">No robots connected</div>
          )}
          {robotIds.map(id => {
            const data = robots[id];
            const color = getRobotColor(id, robotIds);
            const stateColor = STATE_COLORS[data.state] || 'rgba(255, 255, 255, 0.3)';
            const isSelected = id === selectedRobot;
            return (
              <div
                key={id}
                className={`robot-item ${isSelected ? 'robot-item-selected' : ''}`}
                style={isSelected ? { borderLeftColor: color } : {}}
                onClick={() => onSelectRobot(id)}
              >
                <span className="robot-dot" style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}` }} />
                <span className="robot-name">{id}</span>
                <span className="robot-state" style={{ color: stateColor }}>{data.state || 'unknown'}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Robot info */}
      <div className="card">
        <h3 className="card-title">Robot Info</h3>
        {selected ? (
          <div className="info-grid">
            <div className="info-row"><span className="info-label">State</span><span className="info-value" style={{ color: STATE_COLORS[selected.state] || 'rgba(255, 255, 255, 0.3)' }}>{selected.state || '--'}</span></div>
            <div className="info-row"><span className="info-label">Position</span><span className="info-value">({fmt(selected.x_cm)}, {fmt(selected.y_cm)})</span></div>
            <div className="info-row"><span className="info-label">Heading</span><span className="info-value">{fmt(selected.theta_deg)}&deg;</span></div>
            <div className="info-row"><span className="info-label">Speed</span><span className="info-value">{selected.speed_cm_s != null ? `${fmt(selected.speed_cm_s)} cm/s` : '--'}</span></div>
            <div className="info-row"><span className="info-label">Ultrasonic F</span><span className="info-value">{selected.front_ultrasonic_cm != null ? `${fmt(selected.front_ultrasonic_cm)} cm` : '--'}</span></div>
            <div className="info-row"><span className="info-label">Ultrasonic L</span><span className="info-value">{selected.left_ultrasonic_cm != null ? `${fmt(selected.left_ultrasonic_cm)} cm` : '--'}</span></div>
            <div className="info-row"><span className="info-label">Gripper</span><span className="info-value" style={{ color: selected.gripper_closed ? '#ff8800' : '#00cc88' }}>{selected.gripper_closed ? 'CLOSED' : 'OPEN'}</span></div>
            <div className="info-row"><span className="info-label">Motors</span><span className="info-value">{selected.motor1_busy || selected.motor2_busy ? <span style={{ color: '#0088ff' }}>RUNNING</span> : <span style={{ color: 'rgba(255,255,255,0.3)' }}>IDLE</span>}</span></div>
            {selected.stall && <div className="info-row"><span className="info-label">Warning</span><span className="info-value" style={{ color: '#ff0033' }}>STALL DETECTED</span></div>}
            <div className="info-row"><span className="info-label">Uptime</span><span className="info-value">{selected.t_ms != null ? `${Math.floor(selected.t_ms / 60000)}:${String(Math.floor((selected.t_ms % 60000) / 1000)).padStart(2, '0')}` : '--'}</span></div>
            <div className="info-row"><span className="info-label">Path ID</span><span className="info-value">{selected.path_id != null && selected.path_id !== -1 ? selected.path_id : 'none'}</span></div>
            <div className="info-row"><span className="info-label">Waypoint</span><span className="info-value">{selected.waypoint_index != null && selected.waypoint_index !== -1 ? selected.waypoint_index : '--'}</span></div>
            <div className="info-row"><span className="info-label">Battery</span><span className="info-value" style={{ color: selected.battery_v != null && batteryPercent(selected.battery_v) <= 20 ? '#ff0033' : selected.battery_v != null && batteryPercent(selected.battery_v) <= 50 ? '#ff8800' : '#00cc88' }}>{selected.battery_v != null ? `${batteryPercent(selected.battery_v)}% (${fmt(selected.battery_v)}V)` : '--'}</span></div>
          </div>
        ) : (
          <div className="no-robots">Select a robot to view info</div>
        )}
      </div>

      {/* Controls */}
      <div className="card">
        <h3 className="card-title">Controls</h3>
        <div className="control-grid">
          <button className="btn btn-primary" disabled={!selectedRobot} onClick={sendPause}>Pause</button>
          <button className="btn btn-success" disabled={!selectedRobot} onClick={sendResume}>Resume</button>
          <button className="btn btn-danger" disabled={!selectedRobot} onClick={sendStop}>Stop</button>
          <button className="btn btn-secondary" disabled={!selectedRobot} onClick={sendToggleGripper}>Gripper</button>
        </div>
        <button
          className={`btn ${routeMode ? 'btn-mode-active' : 'btn-primary'}`}
          disabled={!selectedRobot}
          onClick={onSetRoute}
          style={{ width: '100%', marginTop: 6 }}
        >
          {routeMode ? 'Setting Route...' : 'Set Route'}
        </button>
        <button
          className="btn btn-calibrate"
          disabled={!selectedRobot}
          onClick={sendCalibrate}
          style={{ width: '100%', marginTop: 6 }}
        >
          Calibrate Position
        </button>
      </div>

      {/* Arena Tools */}
      <div className="card">
        <h3 className="card-title">Arena Tools</h3>
        <div className="control-grid">
          <button
            className={`btn ${drawObstacleMode ? 'btn-mode-active' : 'btn-outline'}`}
            onClick={onDrawObstacle}
          >
            Draw Obstacle
          </button>
          <button
            className={`btn ${placeStopMode ? 'btn-mode-active' : 'btn-outline'}`}
            onClick={onPlaceStop}
          >
            Place Stop
          </button>
        </div>
      </div>

      {/* Obstacles list */}
      {obstacles && obstacles.length > 0 && (
        <div className="card">
          <h3 className="card-title">Obstacles</h3>
          <div className="item-list">
            {obstacles.map(obs => (
              <div key={obs.id} className="item-row">
                <span className="item-icon" style={{ color: '#f87171' }}>
                  {obs.type === 'polygon' ? '◆' : '—'}
                </span>
                <span className="item-label">
                  {obs.type} ({obs.points.length} pts)
                </span>
                <button className="btn-remove" onClick={() => onDeleteObstacle(obs.id)}>&times;</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Action Stops list */}
      {actionStops && actionStops.length > 0 && (
        <div className="card">
          <h3 className="card-title">Action Stops</h3>
          <div className="item-list">
            {actionStops.map(stop => (
              <div key={stop.id} className="item-row">
                <span className="item-icon" style={{ color: '#22d3ee' }}>●</span>
                <span className="item-label">{stop.name}</span>
                {selectedRobot && (
                  <button
                    className="btn-go"
                    onClick={() => sendToStop(stop)}
                    title="Send robot here"
                  >
                    Go
                  </button>
                )}
                <button className="btn-remove" onClick={() => onDeleteStop(stop.id)}>&times;</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      <div className="card">
        <h3 className="card-title">Tasks</h3>
        <button
          className={`btn ${taskBuilderOpen ? 'btn-mode-active' : 'btn-primary'}`}
          disabled={!selectedRobot}
          onClick={() => setTaskBuilderOpen(v => !v)}
          style={{ width: '100%' }}
        >
          {taskBuilderOpen ? 'Close Builder' : 'Create Task'}
        </button>
        {taskBuilderOpen && (
          <TaskBuilder
            robots={robots}
            selectedRobot={selectedRobot}
            actionStops={actionStops}
            sendCommand={sendCommand}
            onClose={() => setTaskBuilderOpen(false)}
          />
        )}
      </div>

      <TaskList tasks={tasks || []} sendCommand={sendCommand} />
    </>
  );
}
