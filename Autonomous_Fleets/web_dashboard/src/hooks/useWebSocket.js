import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL = `ws://${window.location.hostname}:8765`;
const RECONNECT_INTERVAL = 3000;
const MAX_HISTORY = 500;

export default function useWebSocket() {
  const [robots, setRobots] = useState({});
  const [connected, setConnected] = useState(false);
  const robotHistoryRef = useRef({});
  const [historyVersion, setHistoryVersion] = useState(0);
  const planResultRef = useRef(null);
  const [planResultVersion, setPlanResultVersion] = useState(0);
  const [tasks, setTasks] = useState([]);
  const [stopQueues, setStopQueues] = useState({});
  const savedStateRef = useRef(null);
  const [savedStateVersion, setSavedStateVersion] = useState(0);
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);

  const appendHistory = useCallback((robotId, data) => {
    if (!robotHistoryRef.current[robotId]) {
      robotHistoryRef.current[robotId] = [];
    }
    const history = robotHistoryRef.current[robotId];
    const x = data.x_cm;
    const y = data.y_cm;
    const theta = data.theta_deg;
    if (x != null && y != null) {
      history.push({ x, y, theta: theta ?? 0 });
      if (history.length > MAX_HISTORY) {
        history.splice(0, history.length - MAX_HISTORY);
      }
    }
    setHistoryVersion(v => v + 1);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    ws.onclose = () => {
      setConnected(false);
      reconnectTimer.current = setTimeout(connect, RECONNECT_INTERVAL);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'full_state':
            if (msg.robots) {
              setRobots(msg.robots);
              // Build history for all robots
              Object.entries(msg.robots).forEach(([id, data]) => {
                appendHistory(id, data);
              });
            }
            break;
          case 'robot_update':
            if (msg.robot_id && msg.data) {
              setRobots(prev => ({
                ...prev,
                [msg.robot_id]: { ...prev[msg.robot_id], ...msg.data }
              }));
              appendHistory(msg.robot_id, msg.data);
            }
            break;
          case 'robot_disconnected':
            if (msg.robot_id) {
              setRobots(prev => {
                const next = { ...prev };
                delete next[msg.robot_id];
                return next;
              });
              delete robotHistoryRef.current[msg.robot_id];
              setHistoryVersion(v => v + 1);
            }
            break;
          case 'plan_result':
            if (msg.robot_id) {
              planResultRef.current = msg;
              setPlanResultVersion(v => v + 1);
            }
            break;
          case 'task_update':
            if (msg.task) {
              setTasks(prev => {
                const idx = prev.findIndex(t => t.id === msg.task.id);
                if (idx >= 0) {
                  const next = [...prev];
                  next[idx] = msg.task;
                  return next;
                }
                return [...prev, msg.task];
              });
            }
            break;
          case 'tasks_list':
            if (msg.tasks) setTasks(msg.tasks);
            break;
          case 'saved_state':
            savedStateRef.current = msg;
            setSavedStateVersion(v => v + 1);
            break;
          case 'stop_queues':
            if (msg.queues) setStopQueues(msg.queues);
            break;
          default:
            break;
        }
      } catch (e) {
        // ignore malformed messages
      }
    };
  }, [appendHistory]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect]);

  const sendCommand = useCallback((commandObj) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'command', command: commandObj }));
    }
  }, []);

  return {
    robots,
    connected,
    sendCommand,
    robotHistory: robotHistoryRef.current,
    historyVersion,
    planResult: planResultRef.current,
    planResultVersion,
    tasks,
    stopQueues,
    savedState: savedStateRef.current,
    savedStateVersion,
  };
}
