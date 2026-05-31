import { useState } from 'react';

export default function BottomPanel({ robots, selectedRobot, waypoints, setWaypoints, sendCommand, onPathSent, routeMode, onCancelRoute }) {
  const [turnSpeed, setTurnSpeed] = useState(150);
  const [driveSpeed, setDriveSpeed] = useState(200);

  const removeWaypoint = (idx) => {
    setWaypoints(prev => prev.filter((_, i) => i !== idx));
  };

  const clearWaypoints = () => {
    setWaypoints([]);
  };

  const sendPath = () => {
    if (!selectedRobot || waypoints.length === 0) return;
    const wps = waypoints.map(wp => ({ x_cm: wp.x_cm, y_cm: wp.y_cm }));
    sendCommand({
      type: 'path_assignment',
      robot_id: selectedRobot,
      path_id: Date.now(),
      replace_existing: true,
      waypoints: wps,
      motion: {
        turn_speed_deg_per_sec: parseInt(turnSpeed) || 150,
        drive_speed_deg_per_sec: parseInt(driveSpeed) || 200,
      },
    });
    onPathSent(selectedRobot, wps);
    setWaypoints([]);
  };

  const canSendPath = selectedRobot && waypoints.length > 0;

  return (
    <div className="card bottom-card">
      <h3 className="card-title">Path Planner</h3>
      <p className="hint-text">
        {routeMode
          ? 'Click on the arena to add waypoints'
          : 'Select a robot and press Set Route to plan a path'}
      </p>

      <div className="waypoint-list">
        {waypoints.length === 0 && (
          <div className="no-robots">No waypoints added</div>
        )}
        {waypoints.map((wp, idx) => (
          <div key={idx} className="waypoint-item">
            <span className="waypoint-index">{idx + 1}.</span>
            <span className="waypoint-coords">({wp.x_cm}, {wp.y_cm})</span>
            <button className="btn-remove" onClick={() => removeWaypoint(idx)}>&times;</button>
          </div>
        ))}
      </div>

      <div className="speed-inputs">
        <div className="speed-field">
          <label>Turn speed</label>
          <input
            type="number"
            value={turnSpeed}
            onChange={e => setTurnSpeed(e.target.value)}
            min={1}
            max={999}
          />
        </div>
        <div className="speed-field">
          <label>Drive speed</label>
          <input
            type="number"
            value={driveSpeed}
            onChange={e => setDriveSpeed(e.target.value)}
            min={1}
            max={999}
          />
        </div>
      </div>

      <div className="path-actions">
        {routeMode && (
          <button className="btn btn-outline" onClick={onCancelRoute}>Cancel</button>
        )}
        <button className="btn btn-outline" onClick={clearWaypoints} disabled={waypoints.length === 0}>Clear All</button>
        <button className="btn btn-primary" onClick={sendPath} disabled={!canSendPath}>Send Path</button>
      </div>
    </div>
  );
}
