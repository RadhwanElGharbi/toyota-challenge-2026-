const STATUS_COLORS = {
  active: '#60a5fa',
  paused: '#fbbf24',
  completed: '#34d399',
  error: '#f87171',
  pending: 'rgba(255,255,255,0.3)',
};

const STEP_ICONS = {
  navigate: '→',
  gripper_close: '✊',
  gripper_open: '✋',
  wait: '⏱',
};

function stepLabel(step) {
  switch (step.type) {
    case 'navigate': return step.stop_name || 'Navigate';
    case 'gripper_close': return 'Close Gripper';
    case 'gripper_open': return 'Open Gripper';
    case 'wait': return `Wait ${step.duration_s || 3}s`;
    default: return step.type;
  }
}

export default function TaskList({ tasks, sendCommand }) {
  const activeTasks = tasks.filter(t => t.status !== 'completed');

  if (activeTasks.length === 0) return null;

  return (
    <div className="card">
      <h3 className="card-title">Active Tasks</h3>
      <div className="task-list">
        {activeTasks.map(task => {
          const totalSteps = task.steps?.length || 0;
          const progress = totalSteps > 0 ? Math.min(task.current_step / totalSteps, 1) : 0;
          const statusColor = STATUS_COLORS[task.status] || 'rgba(255,255,255,0.3)';

          return (
            <div key={task.id} className="task-card">
              <div className="task-header">
                <span className="task-card-name">{task.name}</span>
                <span className="task-status-badge" style={{ color: statusColor, borderColor: statusColor }}>
                  {task.status}
                </span>
              </div>

              <div className="task-meta">
                {task.robot_id}
                {task.recurring !== 'once' && (
                  <span> · {task.recurring === 'loop' ? 'looping' : `${task.iterations_done}/${task.recurring}`}</span>
                )}
              </div>

              <div className="task-progress">
                <div
                  className="task-progress-fill"
                  style={{ width: `${progress * 100}%`, background: statusColor }}
                />
              </div>

              <div className="task-steps-mini">
                {(task.steps || []).map((step, idx) => (
                  <span
                    key={idx}
                    className={`task-step-dot ${idx === task.current_step && task.status === 'active' ? 'task-step-current' : ''} ${idx < task.current_step ? 'task-step-done' : ''}`}
                    title={stepLabel(step)}
                  >
                    {STEP_ICONS[step.type] || '?'}
                  </span>
                ))}
              </div>

              {task.error_message && (
                <div className="task-error">{task.error_message}</div>
              )}

              <div className="task-actions">
                {task.status === 'active' && (
                  <button className="btn btn-outline" onClick={() => sendCommand({ type: 'pause_task', task_id: task.id })}>
                    Pause
                  </button>
                )}
                {task.status === 'paused' && (
                  <button className="btn btn-outline" onClick={() => sendCommand({ type: 'resume_task', task_id: task.id })}>
                    Resume
                  </button>
                )}
                {(task.status === 'active' || task.status === 'paused') && (
                  <button className="btn btn-danger" onClick={() => sendCommand({ type: 'cancel_task', task_id: task.id })}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
