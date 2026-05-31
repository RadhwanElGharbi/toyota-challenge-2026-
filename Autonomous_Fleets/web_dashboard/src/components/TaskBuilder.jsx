import { useState } from 'react';

const STEP_ICONS = {
  navigate: '→',
  gripper_close: '✊',
  gripper_open: '✋',
  wait: '⏱',
};

export default function TaskBuilder({ robots, selectedRobot, actionStops, sendCommand, onClose }) {
  const [taskName, setTaskName] = useState('');
  const [steps, setSteps] = useState([]);
  const [recurring, setRecurring] = useState('once');
  const [repeatCount, setRepeatCount] = useState(3);
  const [addingNav, setAddingNav] = useState(false);
  const [waitDuration, setWaitDuration] = useState(3);
  const [addingWait, setAddingWait] = useState(false);

  const addNavigateStep = (stop) => {
    setSteps(prev => [...prev, {
      type: 'navigate', stop_id: stop.id, stop_name: stop.name,
      goal_x_cm: stop.x_cm, goal_y_cm: stop.y_cm,
    }]);
    setAddingNav(false);
  };

  const addGripperStep = (action) => {
    setSteps(prev => [...prev, { type: action }]);
  };

  const addWaitStep = () => {
    setSteps(prev => [...prev, { type: 'wait', duration_s: parseFloat(waitDuration) || 3 }]);
    setAddingWait(false);
  };

  const removeStep = (idx) => {
    setSteps(prev => prev.filter((_, i) => i !== idx));
  };

  const moveStep = (idx, dir) => {
    setSteps(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return next;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const handleAssign = () => {
    if (!selectedRobot || steps.length === 0) return;
    const task = {
      id: `task_${Date.now()}`,
      name: taskName || `Task for ${selectedRobot}`,
      robot_id: selectedRobot,
      steps,
      recurring: recurring === 'count' ? String(repeatCount) : recurring,
    };
    sendCommand({ type: 'create_task', task });
    onClose();
  };

  const stepLabel = (step) => {
    switch (step.type) {
      case 'navigate': return `Go to ${step.stop_name || 'unknown'}`;
      case 'gripper_close': return 'Close Gripper (pick up)';
      case 'gripper_open': return 'Open Gripper (drop off)';
      case 'wait': return `Wait ${step.duration_s}s`;
      default: return step.type;
    }
  };

  return (
    <div className="task-builder">
      <input
        className="task-name-input"
        type="text"
        placeholder="Task name..."
        value={taskName}
        onChange={e => setTaskName(e.target.value)}
      />

      <div className="task-step-list">
        {steps.length === 0 && (
          <div className="no-robots">Add steps below</div>
        )}
        {steps.map((step, idx) => (
          <div key={idx} className="task-step-item">
            <span className="task-step-icon">{STEP_ICONS[step.type] || '?'}</span>
            <span className="task-step-label">{stepLabel(step)}</span>
            <button className="btn-step-move" onClick={() => moveStep(idx, -1)} disabled={idx === 0}>↑</button>
            <button className="btn-step-move" onClick={() => moveStep(idx, 1)} disabled={idx === steps.length - 1}>↓</button>
            <button className="btn-remove" onClick={() => removeStep(idx)}>&times;</button>
          </div>
        ))}
      </div>

      <div className="add-step-grid">
        <button className="btn btn-outline" onClick={() => setAddingNav(v => !v)}>
          + Navigate
        </button>
        <button className="btn btn-outline" onClick={() => addGripperStep('gripper_close')}>
          + Close Gripper
        </button>
        <button className="btn btn-outline" onClick={() => addGripperStep('gripper_open')}>
          + Open Gripper
        </button>
        <button className="btn btn-outline" onClick={() => setAddingWait(v => !v)}>
          + Wait
        </button>
      </div>

      {addingNav && (
        <div className="step-picker">
          {(!actionStops || actionStops.length === 0) ? (
            <div className="no-robots">No action stops placed yet</div>
          ) : (
            actionStops.map(stop => (
              <button
                key={stop.id}
                className="btn btn-outline step-pick-btn"
                onClick={() => addNavigateStep(stop)}
              >
                {stop.name}
              </button>
            ))
          )}
        </div>
      )}

      {addingWait && (
        <div className="step-picker" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            className="task-name-input"
            style={{ width: 60 }}
            value={waitDuration}
            onChange={e => setWaitDuration(e.target.value)}
            min={1}
            max={60}
          />
          <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>seconds</span>
          <button className="btn btn-outline" onClick={addWaitStep}>Add</button>
        </div>
      )}

      <div className="recurring-picker">
        <span className="recurring-label">Repeat:</span>
        <select
          className="recurring-select"
          value={recurring}
          onChange={e => setRecurring(e.target.value)}
        >
          <option value="once">Once</option>
          <option value="loop">Loop forever</option>
          <option value="count">N times</option>
        </select>
        {recurring === 'count' && (
          <input
            type="number"
            className="task-name-input"
            style={{ width: 50 }}
            value={repeatCount}
            onChange={e => setRepeatCount(e.target.value)}
            min={1}
            max={999}
          />
        )}
      </div>

      <div className="path-actions">
        <button className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          onClick={handleAssign}
          disabled={!selectedRobot || steps.length === 0}
        >
          Assign Task
        </button>
      </div>
    </div>
  );
}
