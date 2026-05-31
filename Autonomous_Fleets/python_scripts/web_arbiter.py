import json
import asyncio
import heapq
import math
import os
from collections import deque
from pathlib import Path
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Optional

import websockets

HOST = "0.0.0.0"
PORT = 9000

DATA_DIR = Path(__file__).parent / "data"
OBSTACLES_FILE = DATA_DIR / "obstacles.json"
ACTION_STOPS_FILE = DATA_DIR / "action_stops.json"
TASKS_FILE = DATA_DIR / "tasks.json"


def _ensure_data_dir():
    DATA_DIR.mkdir(exist_ok=True)


def _save_json(path: Path, data) -> None:
    _ensure_data_dir()
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    tmp.replace(path)


def _load_json(path: Path, default=None):
    if path.exists():
        try:
            with open(path) as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return default if default is not None else []
WS_PORT = 8765
MAX_CLIENTS = 10
GRID_CELL_CM = 10.0
GRID_DIM_CELLS = 40

# Exclusion zones (row_min, row_max, col_min, col_max) — blocked unless robot's goal is inside
EXCLUSION_ZONES = [
    (0, 3, 0, 3),      # calibration: (0,0)-(40,40) cm
    (36, 39, 36, 39),   # charging: (360,360)-(400,400) cm
]


def exclusion_zone_cells(exclude_goal: tuple[int, int] | None = None) -> set[tuple[int, int]]:
    cells = set()
    for (r_min, r_max, c_min, c_max) in EXCLUSION_ZONES:
        for r in range(r_min, r_max + 1):
            for c in range(c_min, c_max + 1):
                cells.add((r, c))
    if exclude_goal and exclude_goal in cells:
        goal_zone = None
        for (r_min, r_max, c_min, c_max) in EXCLUSION_ZONES:
            if r_min <= exclude_goal[0] <= r_max and c_min <= exclude_goal[1] <= c_max:
                goal_zone = (r_min, r_max, c_min, c_max)
                break
        if goal_zone:
            r_min, r_max, c_min, c_max = goal_zone
            for r in range(r_min, r_max + 1):
                for c in range(c_min, c_max + 1):
                    cells.discard((r, c))
    return cells


@dataclass
class ClientSession:
    client_id: int
    conn: socket.socket
    addr: tuple
    name: str = ""
    robot_id: Optional[str] = None
    state: str = "connected"
    last_heartbeat: float = field(default_factory=time.time)
    last_telemetry: Optional[dict] = None
    last_status: Optional[dict] = None
    current_path_id: Optional[str] = None
    current_waypoint_index: Optional[int] = None
    send_lock: threading.Lock = field(default_factory=threading.Lock)
    pending_waypoints: list[dict] = field(default_factory=list)
    pending_motion: Optional[dict] = None
    sequence_path_id: Optional[int] = None
    active_subpath_id: Optional[int] = None
    awaiting_path_ack: bool = False
    awaiting_path_complete: bool = False
    pose_offset: Optional[dict] = None
    active_task_id: Optional[str] = None


@dataclass
class Task:
    id: str
    name: str
    robot_id: str
    steps: list = field(default_factory=list)
    recurring: str = "once"
    status: str = "pending"
    current_step: int = 0
    iterations_done: int = 0
    created_at: float = field(default_factory=time.time)
    error_message: Optional[str] = None


clients_lock = threading.Lock()

# keyed by client_id
client_sessions: Dict[int, ClientSession] = {}

# keyed by robot_id
robots_by_id: Dict[str, int] = {}

next_client_id = 1
next_robot_path_id = 1000

# Obstacle and action stop storage (loaded from disk)
_ensure_data_dir()
obstacles: list[dict] = _load_json(OBSTACLES_FILE, [])
action_stops: list[dict] = _load_json(ACTION_STOPS_FILE, [])

# Time-space reservation table: (time_step, row, col) -> robot_id
reservation_table: Dict[tuple, str] = {}
current_time_step: int = 0

# Robot: 45cm x 45cm body. Centers must stay >= 45cm apart.
# 45cm / 10cm = 4.5 → 5 cells. Two blocks of half=H clear at 2H+1 → H=2.
ROBOT_FOOTPRINT_HALF = 2  # 5x5 reservation block per robot
ROBOT_RADIUS_CELLS = 3   # inflation for static obstacles (22.5cm → 3 cells)

# Task storage
tasks: Dict[str, "Task"] = {}
tasks_lock = threading.Lock()

# Stop queue: stop_id -> ordered list of task_ids waiting to use that stop
stop_queues: Dict[str, list[str]] = {}
stop_queues_lock = threading.Lock()


def _task_to_dict(t) -> dict:
    return {
        "id": t.id, "name": t.name, "robot_id": t.robot_id,
        "steps": t.steps, "recurring": t.recurring,
        "status": t.status, "current_step": t.current_step,
        "iterations_done": t.iterations_done,
        "error_message": t.error_message,
    }


def _save_tasks() -> None:
    with tasks_lock:
        data = [_task_to_dict(t) for t in tasks.values()]
    _save_json(TASKS_FILE, data)


def _load_tasks() -> None:
    raw = _load_json(TASKS_FILE, [])
    for td in raw:
        t = Task(
            id=td.get("id", ""), name=td.get("name", ""),
            robot_id=td.get("robot_id", ""),
            steps=td.get("steps", []),
            recurring=td.get("recurring", "once"),
            status=td.get("status", "completed"),
            current_step=td.get("current_step", 0),
            iterations_done=td.get("iterations_done", 0),
            error_message=td.get("error_message"),
        )
        if t.status == "active":
            t.status = "paused"
        tasks[t.id] = t


_load_tasks()


# ============================================================
# WebSocketBridge  (replaces TelemetryGUI)
# ============================================================
class WebSocketBridge:
    """Broadcasts robot state to browser clients over WebSocket
    and relays browser commands back to the TCP command sender."""

    def __init__(self, command_sender):
        self.command_sender = command_sender
        self._ws_clients: set = set()
        self._robot_states: Dict[str, dict] = {}
        self._lock = threading.Lock()
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ----------------------------------------------------------
    # Called from TCP handler threads
    # ----------------------------------------------------------
    def update_robot(self, robot_id: str, telemetry_dict: dict) -> None:
        with self._lock:
            self._robot_states[robot_id] = dict(telemetry_dict)

        payload = json.dumps({
            "type": "robot_update",
            "robot_id": robot_id,
            "data": telemetry_dict,
        })

        self._broadcast(payload)

    def remove_robot(self, robot_id: str) -> None:
        with self._lock:
            self._robot_states.pop(robot_id, None)

        payload = json.dumps({
            "type": "robot_disconnected",
            "robot_id": robot_id,
        })

        self._broadcast(payload)

    # ----------------------------------------------------------
    # Internal helpers
    # ----------------------------------------------------------
    def _broadcast(self, payload: str) -> None:
        if self._loop is None:
            return
        asyncio.run_coroutine_threadsafe(self._async_broadcast(payload), self._loop)

    async def _async_broadcast(self, payload: str) -> None:
        stale = set()
        for ws in list(self._ws_clients):
            try:
                await ws.send(payload)
            except websockets.exceptions.ConnectionClosed:
                stale.add(ws)
        self._ws_clients -= stale

    # ----------------------------------------------------------
    # WebSocket handler (one per browser connection)
    # ----------------------------------------------------------
    async def _ws_handler(self, websocket):
        self._ws_clients.add(websocket)
        try:
            # Send full state snapshot on connect
            with self._lock:
                snapshot = dict(self._robot_states)
            await websocket.send(json.dumps({
                "type": "full_state",
                "robots": snapshot,
            }))

            with tasks_lock:
                tl = [{"id": t.id, "name": t.name, "robot_id": t.robot_id,
                       "steps": t.steps, "recurring": t.recurring,
                       "status": t.status, "current_step": t.current_step,
                       "iterations_done": t.iterations_done,
                       "error_message": t.error_message} for t in tasks.values()]
            await websocket.send(json.dumps({"type": "tasks_list", "tasks": tl}))

            await websocket.send(json.dumps({
                "type": "saved_state",
                "obstacles": obstacles,
                "action_stops": action_stops,
            }))

            # Listen for commands from the browser
            async for raw in websocket:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if msg.get("type") == "command":
                    command_dict = msg.get("command")
                    if isinstance(command_dict, dict):
                        self.command_sender(command_dict)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._ws_clients.discard(websocket)

    # ----------------------------------------------------------
    # Run (blocks the calling thread like gui.run() did)
    # ----------------------------------------------------------
    def run(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)

        async def _serve():
            async with websockets.serve(
                self._ws_handler,
                "0.0.0.0",
                WS_PORT,
            ):
                print(f"WebSocket server on ws://localhost:{WS_PORT}")
                await asyncio.Future()

        self._loop.run_until_complete(_serve())


# ============================================================
# Networking helpers  (identical to central-arbiter.py)
# ============================================================
def send_json(conn: socket.socket, message: dict) -> None:
    data = json.dumps(message) + "\n"
    conn.sendall(data.encode("utf-8"))


def recv_lines(conn: socket.socket):
    buffer = ""
    while True:
        data = conn.recv(4096)
        if not data:
            break

        buffer += data.decode("utf-8", errors="replace")

        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if line:
                yield line


def get_session(client_id: int) -> Optional[ClientSession]:
    with clients_lock:
        return client_sessions.get(client_id)


def get_robot_snapshot() -> dict:
    with clients_lock:
        snapshot = {}
        for robot_id, client_id in robots_by_id.items():
            session = client_sessions.get(client_id)
            if session is None:
                continue

            snapshot[robot_id] = {
                "client_id": session.client_id,
                "name": session.name,
                "state": session.state,
                "path_id": session.current_path_id,
                "waypoint_index": session.current_waypoint_index,
                "last_heartbeat": session.last_heartbeat,
                "last_telemetry": session.last_telemetry,
                "last_status": session.last_status,
            }
        return snapshot


def print_robot_table() -> None:
    with clients_lock:
        print("\n=== Robot Table ===")
        if not client_sessions:
            print("(no clients connected)")
        for client_id, session in client_sessions.items():
            print(
                f"client_id={client_id} "
                f"robot_id={session.robot_id} "
                f"name={session.name!r} "
                f"state={session.state!r} "
                f"path_id={session.current_path_id!r} "
                f"waypoint_index={session.current_waypoint_index!r} "
                f"last_heartbeat={session.last_heartbeat:.1f}"
            )
        print("===================\n")


def send_to_robot(robot_id: str, message: dict) -> bool:
    with clients_lock:
        client_id = robots_by_id.get(robot_id)
        if client_id is None:
            print(f"[SEND] No connected session for robot_id={robot_id}")
            return False

        session = client_sessions.get(client_id)
        if session is None:
            print(f"[SEND] Session disappeared for robot_id={robot_id}")
            return False

    try:
        with session.send_lock:
            send_json(session.conn, message)

        print(f"[SEND] -> {robot_id}: {message}")
        return True

    except Exception as exc:
        print(f"[!] Failed to send to robot {robot_id}: {exc}")
        return False


def next_subpath_id() -> int:
    global next_robot_path_id
    next_robot_path_id += 1
    if next_robot_path_id > 30000:
        next_robot_path_id = 1000
    return next_robot_path_id


def clear_robot_sequence(session: ClientSession) -> None:
    session.pending_waypoints.clear()
    session.pending_motion = None
    session.sequence_path_id = None
    session.active_subpath_id = None
    session.awaiting_path_ack = False
    session.awaiting_path_complete = False


def any_other_robot_busy_unlocked(robot_id: str) -> bool:
    for session in client_sessions.values():
        if session.robot_id and session.robot_id != robot_id and session.awaiting_path_complete:
            return True
    return False


def maybe_dispatch_waiting_sequences() -> bool:
    with clients_lock:
        robot_ids = [
            session.robot_id
            for session in client_sessions.values()
            if session.robot_id and session.pending_waypoints and not session.awaiting_path_complete
        ]

    dispatched = False
    for robot_id in robot_ids:
        if dispatch_next_waypoint(robot_id):
            dispatched = True

    return dispatched


def dispatch_next_waypoint(robot_id: str) -> bool:
    with clients_lock:
        client_id = robots_by_id.get(robot_id)
        if client_id is None:
            print(f"[SEQUENCE] No connected session for robot_id={robot_id}")
            return False

        session = client_sessions.get(client_id)
        if session is None:
            print(f"[SEQUENCE] Session disappeared for robot_id={robot_id}")
            return False

        if session.awaiting_path_ack or session.awaiting_path_complete:
            return False

        if not session.pending_waypoints:
            session.pending_motion = None
            session.sequence_path_id = None
            session.active_subpath_id = None
            return False

        waypoint = session.pending_waypoints.pop(0)
        subpath_id = next_subpath_id()
        message = {
            "type": "path_assignment",
            "robot_id": robot_id,
            "path_id": subpath_id,
            "replace_existing": True,
            "waypoints": [waypoint],
        }
        if session.pending_motion is not None:
            message["motion"] = dict(session.pending_motion)

        session.active_subpath_id = subpath_id
        session.current_path_id = str(subpath_id)
        session.current_waypoint_index = 0
        session.awaiting_path_ack = True
        session.awaiting_path_complete = True

    ok = send_to_robot(robot_id, message)
    if not ok:
        with clients_lock:
            client_id = robots_by_id.get(robot_id)
            session = client_sessions.get(client_id) if client_id is not None else None
            if session is not None:
                session.pending_waypoints.insert(0, waypoint)
                session.active_subpath_id = None
                session.awaiting_path_ack = False
                session.awaiting_path_complete = False
        return False

    print(f"[SEQUENCE] dispatched subpath {subpath_id} to {robot_id} -> {waypoint}")
    return True


# ============================================================
# Grid / path-planning helpers  (identical to central-arbiter.py)
# ============================================================
def clamp_cell(value: int) -> int:
    return max(0, min(GRID_DIM_CELLS - 1, value))


def pose_to_cell(telemetry: dict) -> tuple[int, int] | None:
    try:
        x_cm = float(telemetry["x_cm"])
        y_cm = float(telemetry["y_cm"])
    except (KeyError, TypeError, ValueError):
        return None

    col = clamp_cell(int(x_cm // GRID_CELL_CM))
    row = clamp_cell(int(y_cm // GRID_CELL_CM))
    return row, col


def cell_center_waypoint(cell: tuple[int, int]) -> dict:
    row, col = cell
    return {
        "x_cm": col * GRID_CELL_CM + GRID_CELL_CM / 2.0,
        "y_cm": row * GRID_CELL_CM + GRID_CELL_CM / 2.0,
    }


def rasterize_line_to_cells(p1: dict, p2: dict) -> set[tuple[int, int]]:
    cells = set()
    x1, y1 = float(p1["x_cm"]), float(p1["y_cm"])
    x2, y2 = float(p2["x_cm"]), float(p2["y_cm"])
    dist = math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)
    steps = max(1, int(dist / 2))
    for i in range(steps + 1):
        t = i / steps
        x = x1 + t * (x2 - x1)
        y = y1 + t * (y2 - y1)
        col = clamp_cell(int(x // GRID_CELL_CM))
        row = clamp_cell(int(y // GRID_CELL_CM))
        cells.add((row, col))
    return cells


def point_in_polygon(px: float, py: float, polygon: list[dict]) -> bool:
    n = len(polygon)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = float(polygon[i]["x_cm"]), float(polygon[i]["y_cm"])
        xj, yj = float(polygon[j]["x_cm"]), float(polygon[j]["y_cm"])
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def rasterize_polygon_to_cells(points: list[dict]) -> set[tuple[int, int]]:
    cells = set()
    n = len(points)
    for i in range(n):
        cells |= rasterize_line_to_cells(points[i], points[(i + 1) % n])
    xs = [float(p["x_cm"]) for p in points]
    ys = [float(p["y_cm"]) for p in points]
    min_col = clamp_cell(int(min(xs) // GRID_CELL_CM))
    max_col = clamp_cell(int(max(xs) // GRID_CELL_CM))
    min_row = clamp_cell(int(min(ys) // GRID_CELL_CM))
    max_row = clamp_cell(int(max(ys) // GRID_CELL_CM))
    for row in range(min_row, max_row + 1):
        for col in range(min_col, max_col + 1):
            cx = col * GRID_CELL_CM + GRID_CELL_CM / 2.0
            cy = row * GRID_CELL_CM + GRID_CELL_CM / 2.0
            if point_in_polygon(cx, cy, points):
                cells.add((row, col))
    return cells


def obstacles_to_blocked_cells() -> set[tuple[int, int]]:
    blocked = set()
    for obs in obstacles:
        points = obs.get("points", [])
        if obs.get("type") == "line" and len(points) >= 2:
            blocked |= rasterize_line_to_cells(points[0], points[1])
        elif obs.get("type") == "polygon" and len(points) >= 3:
            blocked |= rasterize_polygon_to_cells(points)
    return blocked


def inflate_blocked(blocked: set[tuple[int, int]], radius: int = ROBOT_RADIUS_CELLS) -> set[tuple[int, int]]:
    inflated = set()
    for (r, c) in blocked:
        for dr in range(-radius, radius + 1):
            for dc in range(-radius, radius + 1):
                nr, nc = r + dr, c + dc
                if 0 <= nr < GRID_DIM_CELLS and 0 <= nc < GRID_DIM_CELLS:
                    inflated.add((nr, nc))
    return inflated


def robot_footprint_cells(center_row: int, center_col: int) -> set[tuple[int, int]]:
    cells = set()
    for dr in range(-ROBOT_FOOTPRINT_HALF, ROBOT_FOOTPRINT_HALF + 1):
        for dc in range(-ROBOT_FOOTPRINT_HALF, ROBOT_FOOTPRINT_HALF + 1):
            nr, nc = center_row + dr, center_col + dc
            if 0 <= nr < GRID_DIM_CELLS and 0 <= nc < GRID_DIM_CELLS:
                cells.add((nr, nc))
    return cells


def cleanup_stale_reservations(current_time: int) -> None:
    cutoff = current_time - GRID_DIM_CELLS * 2
    to_remove = [k for k in reservation_table if k[0] < cutoff]
    for k in to_remove:
        del reservation_table[k]


def plan_grid_path(
    start: tuple[int, int],
    goal: tuple[int, int],
    blocked: set[tuple[int, int]],
) -> list[tuple[int, int]] | None:
    if start == goal:
        return [start]

    def heuristic(cell):
        return abs(cell[0] - goal[0]) + abs(cell[1] - goal[1])

    counter = 0
    open_set = [(heuristic(start), 0, counter, start)]
    came_from = {start: None}
    g_score = {start: 0}

    while open_set:
        f, g, _, current = heapq.heappop(open_set)

        if current == goal:
            path = []
            node = current
            while node is not None:
                path.append(node)
                node = came_from[node]
            path.reverse()
            return path

        if g > g_score.get(current, float('inf')):
            continue

        for d_row, d_col in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            neighbor = (current[0] + d_row, current[1] + d_col)
            if not (0 <= neighbor[0] < GRID_DIM_CELLS and 0 <= neighbor[1] < GRID_DIM_CELLS):
                continue
            if neighbor in blocked and neighbor != goal:
                continue

            tentative_g = g + 1
            if tentative_g < g_score.get(neighbor, float('inf')):
                g_score[neighbor] = tentative_g
                came_from[neighbor] = current
                counter += 1
                heapq.heappush(open_set, (tentative_g + heuristic(neighbor), tentative_g, counter, neighbor))

    return None


def plan_path_with_reservations(
    robot_id: str,
    start: tuple[int, int],
    goal: tuple[int, int],
    static_blocked: set[tuple[int, int]],
    start_time: int,
) -> list[tuple[int, int]] | None:
    MAX_TIME = start_time + GRID_DIM_CELLS * 10

    def heuristic(row, col):
        return abs(row - goal[0]) + abs(col - goal[1])

    counter = 0
    start_node = (start[0], start[1], start_time)
    open_set = [(heuristic(start[0], start[1]), 0, counter, start_node)]
    came_from = {start_node: None}
    g_score = {start_node: 0}

    while open_set:
        f, g, _, node = heapq.heappop(open_set)
        r, c, t = node

        if (r, c) == goal:
            path = []
            n = node
            while n is not None:
                path.append((n[0], n[1]))
                n = came_from[n]
            path.reverse()
            return path

        if g > g_score.get(node, float('inf')):
            continue

        if t >= MAX_TIME:
            continue

        next_t = t + 1
        for dr, dc in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            nr, nc = r + dr, c + dc
            if not (0 <= nr < GRID_DIM_CELLS and 0 <= nc < GRID_DIM_CELLS):
                continue
            if (nr, nc) in static_blocked and (nr, nc) != goal:
                continue
            footprint = robot_footprint_cells(nr, nc)
            conflict = False
            for (fr, fc) in footprint:
                occupant = reservation_table.get((next_t, fr, fc))
                if occupant is not None and occupant != robot_id:
                    conflict = True
                    break
            if conflict:
                continue

            next_node = (nr, nc, next_t)
            tentative_g = g + (1 if (dr != 0 or dc != 0) else 1)
            if tentative_g < g_score.get(next_node, float('inf')):
                g_score[next_node] = tentative_g
                came_from[next_node] = node
                counter += 1
                heapq.heappush(open_set, (tentative_g + heuristic(nr, nc), tentative_g, counter, next_node))

    return None


def reserve_path(robot_id: str, path: list[tuple[int, int]], start_time: int) -> None:
    for i, (row, col) in enumerate(path):
        for (fr, fc) in robot_footprint_cells(row, col):
            for dt in range(5):
                reservation_table[(start_time + i + dt, fr, fc)] = robot_id


def clear_reservations(robot_id: str) -> None:
    to_remove = [k for k, v in reservation_table.items() if v == robot_id]
    for k in to_remove:
        del reservation_table[k]


# ============================================================
# Coordinated traverse  (identical to central-arbiter.py)
# ============================================================
def start_coordinated_traverse(message: dict) -> bool:
    robots = message.get("robots", [])
    if len(robots) != 2:
        print("[COORD] Expected exactly two robots in coordinated_traverse request")
        return False

    robot_one = robots[0]
    robot_two = robots[1]

    robot_one_id = str(robot_one.get("robot_id", "")).strip()
    robot_two_id = str(robot_two.get("robot_id", "")).strip()
    if not robot_one_id or not robot_two_id or robot_one_id == robot_two_id:
        print("[COORD] Need two distinct robot ids for coordinated traverse")
        return False

    with clients_lock:
        client_one_id = robots_by_id.get(robot_one_id)
        client_two_id = robots_by_id.get(robot_two_id)
        session_one = client_sessions.get(client_one_id) if client_one_id is not None else None
        session_two = client_sessions.get(client_two_id) if client_two_id is not None else None

        if session_one is None or session_two is None:
            print("[COORD] One or both robots are not connected")
            return False

        start_one = pose_to_cell(session_one.last_telemetry or {})
        start_two = pose_to_cell(session_two.last_telemetry or {})
        if start_one is None or start_two is None:
            print("[COORD] Need telemetry from both robots before planning a coordinated traverse")
            return False

        goal_one = (clamp_cell(int(robot_one["goal_row"])), clamp_cell(int(robot_one["goal_col"])))
        goal_two = (clamp_cell(int(robot_two["goal_row"])), clamp_cell(int(robot_two["goal_col"])))

        clear_robot_sequence(session_one)
        clear_robot_sequence(session_two)

    if start_one == start_two:
        print("[COORD] Robots are in the same grid cell; refusing to plan until they are separated")
        return False

    if goal_one == goal_two:
        print("[COORD] Robots cannot share the same goal cell")
        return False

    path_one = plan_grid_path(start_one, goal_one, {start_two})
    if path_one is None:
        print(f"[COORD] No path found for {robot_one_id} from {start_one} to {goal_one}")
        return False

    path_two = plan_grid_path(start_two, goal_two, {goal_one})
    if path_two is None:
        print(f"[COORD] No path found for {robot_two_id} from {start_two} to {goal_two}")
        return False

    with clients_lock:
        session_one = client_sessions[robots_by_id[robot_one_id]]
        session_two = client_sessions[robots_by_id[robot_two_id]]

        session_one.pending_waypoints = [cell_center_waypoint(cell) for cell in path_one[1:]]
        session_one.pending_motion = None
        session_one.sequence_path_id = next_subpath_id()
        session_one.active_subpath_id = None
        session_one.awaiting_path_ack = False
        session_one.awaiting_path_complete = False

        session_two.pending_waypoints = [cell_center_waypoint(cell) for cell in path_two[1:]]
        session_two.pending_motion = None
        session_two.sequence_path_id = next_subpath_id()
        session_two.active_subpath_id = None
        session_two.awaiting_path_ack = False
        session_two.awaiting_path_complete = False

    print(f"[COORD] {robot_one_id}: {start_one} -> {goal_one} using {len(path_one) - 1} steps")
    print(f"[COORD] {robot_two_id}: {start_two} -> {goal_two} using {len(path_two) - 1} steps")
    maybe_dispatch_waiting_sequences()
    return True


def queue_robot_path(message: dict) -> bool:
    robot_id = message.get("robot_id")
    if not robot_id:
        return False

    waypoints = []
    for waypoint in message.get("waypoints", []):
        x_cm = waypoint.get("x_cm")
        y_cm = waypoint.get("y_cm")
        if x_cm is None or y_cm is None:
            continue
        waypoints.append({
            "x_cm": float(x_cm),
            "y_cm": float(y_cm),
        })

    if not waypoints:
        print(f"[SEQUENCE] Refusing to queue empty path for {robot_id}")
        return False

    with clients_lock:
        client_id = robots_by_id.get(robot_id)
        if client_id is None:
            print(f"[SEQUENCE] No connected session for robot_id={robot_id}")
            return False

        session = client_sessions.get(client_id)
        if session is None:
            print(f"[SEQUENCE] Session disappeared for robot_id={robot_id}")
            return False

        session.pending_waypoints = waypoints
        session.pending_motion = dict(message["motion"]) if isinstance(message.get("motion"), dict) else None
        session.sequence_path_id = int(message.get("path_id", next_subpath_id()))
        session.active_subpath_id = None
        session.awaiting_path_ack = False
        session.awaiting_path_complete = False

    clear_reservations(robot_id)
    path_cells = []
    for wp in waypoints:
        col = clamp_cell(int(float(wp["x_cm"]) // GRID_CELL_CM))
        row = clamp_cell(int(float(wp["y_cm"]) // GRID_CELL_CM))
        path_cells.append((row, col))
    if path_cells:
        reserve_path(robot_id, path_cells, current_time_step)

    maybe_dispatch_waiting_sequences()
    return True


# ============================================================
# Command callback  (replaces gui_command_sender)
# ============================================================
def plan_fleet_path(robot_id: str, goal: tuple[int, int]) -> list[tuple[int, int]] | None:
    with clients_lock:
        client_id = robots_by_id.get(robot_id)
        session = client_sessions.get(client_id) if client_id is not None else None
        if session is None or not session.last_telemetry:
            return None
        start = pose_to_cell(session.last_telemetry)

    if start is None:
        return None

    static_blocked = inflate_blocked(obstacles_to_blocked_cells())
    static_blocked |= exclusion_zone_cells(exclude_goal=goal)

    clear_reservations(robot_id)
    path = plan_path_with_reservations(robot_id, start, goal, static_blocked, current_time_step)
    if path is not None:
        reserve_path(robot_id, path, current_time_step)
    return path


def _get_robot_goal(robot_id: str) -> tuple[int, int] | None:
    with tasks_lock:
        for t in tasks.values():
            if t.robot_id == robot_id and t.status == "active":
                if t.current_step < len(t.steps):
                    step = t.steps[t.current_step]
                    if step.get("type") == "navigate":
                        gx = step.get("goal_x_cm")
                        gy = step.get("goal_y_cm")
                        if gx is None or gy is None:
                            sid = step.get("stop_id", "")
                            sn = step.get("stop_name", "")
                            for s in action_stops:
                                if s.get("id") == sid or s.get("name") == sn:
                                    gx, gy = s["x_cm"], s["y_cm"]
                                    break
                        if gx is not None and gy is not None:
                            return (clamp_cell(int(float(gy) // GRID_CELL_CM)),
                                    clamp_cell(int(float(gx) // GRID_CELL_CM)))
    with clients_lock:
        cid = robots_by_id.get(robot_id)
        sess = client_sessions.get(cid) if cid is not None else None
        if sess and sess.pending_waypoints:
            last = sess.pending_waypoints[-1]
            return (clamp_cell(int(float(last["y_cm"]) // GRID_CELL_CM)),
                    clamp_cell(int(float(last["x_cm"]) // GRID_CELL_CM)))
    return None


replan_lock = threading.Lock()


def replan_all_fleet(trigger_robot_id: str = "") -> None:
    if not replan_lock.acquire(blocking=False):
        return
    try:
        _do_replan(trigger_robot_id)
    finally:
        replan_lock.release()


def _do_replan(trigger_robot_id: str) -> None:
    global current_time_step

    static_blocked = inflate_blocked(obstacles_to_blocked_cells())

    robot_goals = {}
    manual_robots = set()

    with clients_lock:
        all_rids = list(robots_by_id.keys())

    for rid in all_rids:
        with clients_lock:
            cid = robots_by_id.get(rid)
            sess = client_sessions.get(cid) if cid is not None else None
            has_pending = sess and len(sess.pending_waypoints) > 0
            is_executing = sess and sess.awaiting_path_complete

        if has_pending or is_executing:
            goal = _get_robot_goal(rid)
            if goal is not None:
                robot_goals[rid] = goal

    with clients_lock:
        for rid in all_rids:
            cid = robots_by_id.get(rid)
            sess = client_sessions.get(cid) if cid is not None else None
            if sess and sess.active_task_id is None and sess.pending_waypoints:
                manual_robots.add(rid)

    if not robot_goals:
        return

    ordered = []
    if trigger_robot_id in robot_goals:
        ordered.append(trigger_robot_id)
    for rid in sorted(manual_robots):
        if rid not in ordered and rid in robot_goals:
            ordered.append(rid)
    for rid in robot_goals:
        if rid not in ordered:
            ordered.append(rid)

    reservation_table.clear()
    current_time_step = max(current_time_step, 0)

    planned_paths = {}
    for rid in ordered:
        goal = robot_goals[rid]
        with clients_lock:
            cid = robots_by_id.get(rid)
            sess = client_sessions.get(cid) if cid is not None else None
            start = pose_to_cell(sess.last_telemetry) if sess and sess.last_telemetry else None

        if start is None:
            continue

        rid_blocked = static_blocked | exclusion_zone_cells(exclude_goal=goal)
        path = plan_path_with_reservations(rid, start, goal, rid_blocked, current_time_step)
        if path is not None:
            reserve_path(rid, path, current_time_step)
            planned_paths[rid] = path

    for rid, path in planned_paths.items():
        waypoints = [cell_center_waypoint(cell) for cell in path[1:]]
        if not waypoints:
            continue

        with clients_lock:
            cid = robots_by_id.get(rid)
            sess = client_sessions.get(cid) if cid is not None else None
            if sess:
                sess.pending_waypoints = waypoints
                sess.pending_motion = None
                sess.sequence_path_id = next_subpath_id()
                if not sess.awaiting_path_complete:
                    sess.active_subpath_id = None
                    sess.awaiting_path_ack = False

        bridge._broadcast(json.dumps({
            "type": "plan_result", "robot_id": rid, "success": True,
            "planned_waypoints": waypoints,
        }))

    maybe_dispatch_waiting_sequences()
    print(f"[REPLAN] Replanned {len(planned_paths)} robot(s), trigger={trigger_robot_id}")


def broadcast_stop_queues() -> None:
    queues_data = {}
    with stop_queues_lock:
        for stop_id, q in stop_queues.items():
            entries = []
            for i, tid in enumerate(q):
                with tasks_lock:
                    t = tasks.get(tid)
                    robot_id = t.robot_id if t else "?"
                    task_name = t.name if t else "?"
                    total_steps = len(t.steps) if t else 0
                    current = t.current_step if t else 0
                    remaining_steps = total_steps - current - 1
                est_seconds = remaining_steps * 8 + i * 15
                entries.append({
                    "task_id": tid,
                    "robot_id": robot_id,
                    "task_name": task_name,
                    "queue_position": i + 1,
                    "est_wait_s": est_seconds,
                })
            if entries:
                queues_data[stop_id] = entries
    bridge._broadcast(json.dumps({"type": "stop_queues", "queues": queues_data}))


def broadcast_task_update(task_id: str) -> None:
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None:
            return
        payload = {
            "type": "task_update",
            "task": {
                "id": task.id, "name": task.name, "robot_id": task.robot_id,
                "steps": task.steps, "recurring": task.recurring,
                "status": task.status, "current_step": task.current_step,
                "iterations_done": task.iterations_done,
                "error_message": task.error_message,
            }
        }
    bridge._broadcast(json.dumps(payload))
    _save_tasks()


def remove_task_from_all_queues(task_id: str) -> None:
    with stop_queues_lock:
        for stop_id in list(stop_queues.keys()):
            q = stop_queues[stop_id]
            was_first = q and q[0] == task_id
            if task_id in q:
                q.remove(task_id)
            if not q:
                del stop_queues[stop_id]
            elif was_first and q:
                threading.Timer(0.1, execute_task_step, args=[q[0]]).start()
    broadcast_stop_queues()


def mark_task_error(task_id: str, message_text: str) -> None:
    with tasks_lock:
        task = tasks.get(task_id)
        if task:
            task.status = "error"
            task.error_message = message_text
    remove_task_from_all_queues(task_id)
    print(f"[TASK ERROR] {task_id}: {message_text}")
    broadcast_task_update(task_id)


def release_stop_queue(task_id: str, step: dict) -> None:
    stop_id = step.get("stop_id", "")
    if not stop_id:
        stop_name = step.get("stop_name", "")
        for s in action_stops:
            if s.get("name") == stop_name:
                stop_id = s.get("id", "")
                break
    if not stop_id:
        return

    next_task_id = None
    with stop_queues_lock:
        q = stop_queues.get(stop_id, [])
        if task_id in q:
            q.remove(task_id)
        if q:
            next_task_id = q[0]
        elif stop_id in stop_queues:
            del stop_queues[stop_id]

    broadcast_stop_queues()
    if next_task_id:
        print(f"[STOP QUEUE] {stop_id}: notifying next task {next_task_id}")
        execute_task_step(next_task_id)


def advance_task_step(task_id: str) -> None:
    prev_step = None
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None or task.status != "active":
            return
        if task.current_step < len(task.steps):
            prev_step = dict(task.steps[task.current_step])
        task.current_step += 1

    if prev_step and prev_step.get("type") == "navigate":
        release_stop_queue(task_id, prev_step)

    broadcast_task_update(task_id)
    execute_task_step(task_id)


def handle_task_iteration_complete(task_id: str) -> None:
    should_continue = False
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None or task.status != "active":
            return
        task.iterations_done += 1
        if task.recurring == "once":
            task.status = "completed"
        elif task.recurring == "loop":
            task.current_step = 0
            should_continue = True
        else:
            try:
                max_iter = int(task.recurring)
            except ValueError:
                task.status = "completed"
                broadcast_task_update(task_id)
                return
            if task.iterations_done >= max_iter:
                task.status = "completed"
            else:
                task.current_step = 0
                should_continue = True
    broadcast_task_update(task_id)
    if should_continue:
        execute_task_step(task_id)


def execute_task_step(task_id: str) -> None:
    with tasks_lock:
        task = tasks.get(task_id)
        if task is None or task.status != "active":
            return
        if task.current_step >= len(task.steps):
            iteration_needed = True
        else:
            iteration_needed = False
            step = dict(task.steps[task.current_step])
            robot_id = task.robot_id

    if iteration_needed:
        handle_task_iteration_complete(task_id)
        return

    step_type = step.get("type", "")

    if step_type == "navigate":
        goal_x = step.get("goal_x_cm")
        goal_y = step.get("goal_y_cm")
        stop_id = step.get("stop_id", "")
        if goal_x is None or goal_y is None:
            stop_name = step.get("stop_name", "")
            for s in action_stops:
                if s.get("id") == stop_id or s.get("name") == stop_name:
                    goal_x = s["x_cm"]
                    goal_y = s["y_cm"]
                    if not stop_id:
                        stop_id = s.get("id", "")
                    break
        if goal_x is None or goal_y is None:
            mark_task_error(task_id, f"Cannot resolve stop for step {task.current_step}")
            return

        if stop_id:
            with stop_queues_lock:
                q = stop_queues.setdefault(stop_id, [])
                if task_id not in q:
                    q.append(task_id)
                if q[0] != task_id:
                    pos = q.index(task_id) + 1
                    print(f"[TASK] {task_id}: waiting in queue for stop {stop_id} (position {pos}/{len(q)})")
                    broadcast_stop_queues()
                    return
            broadcast_stop_queues()

        goal_col = clamp_cell(int(float(goal_x) // GRID_CELL_CM))
        goal_row = clamp_cell(int(float(goal_y) // GRID_CELL_CM))
        path = plan_fleet_path(robot_id, (goal_row, goal_col))
        if path is None:
            mark_task_error(task_id, f"No path found for step {task.current_step}")
            return
        waypoints = [cell_center_waypoint(cell) for cell in path[1:]]
        if not waypoints:
            advance_task_step(task_id)
            return
        queue_robot_path({
            "robot_id": robot_id,
            "waypoints": waypoints,
            "motion": None,
            "path_id": next_subpath_id(),
        })
        bridge._broadcast(json.dumps({
            "type": "plan_result", "robot_id": robot_id, "success": True,
            "planned_waypoints": waypoints, "task_id": task_id,
        }))
        print(f"[TASK] {task_id} step {task.current_step}: navigate {len(waypoints)} waypoints")

    elif step_type in ("gripper_close", "gripper_open"):
        send_to_robot(robot_id, {"type": "toggle_gripper", "robot_id": robot_id})
        print(f"[TASK] {task_id} step {task.current_step}: {step_type}")
        threading.Timer(0.5, advance_task_step, args=[task_id]).start()

    elif step_type == "wait":
        duration = float(step.get("duration_s", 3))
        print(f"[TASK] {task_id} step {task.current_step}: wait {duration}s")
        threading.Timer(duration, advance_task_step, args=[task_id]).start()

    else:
        mark_task_error(task_id, f"Unknown step type: {step_type}")


def handle_plan_path(robot_id: str, message: dict) -> None:
    goal_x = float(message.get("goal_x_cm", 0))
    goal_y = float(message.get("goal_y_cm", 0))

    with clients_lock:
        client_id = robots_by_id.get(robot_id)
        session = client_sessions.get(client_id) if client_id is not None else None
        if session is None or not session.last_telemetry:
            bridge._broadcast(json.dumps({"type": "plan_result", "robot_id": robot_id, "success": False}))
            return

    goal_col = clamp_cell(int(goal_x // GRID_CELL_CM))
    goal_row = clamp_cell(int(goal_y // GRID_CELL_CM))

    path = plan_fleet_path(robot_id, (goal_row, goal_col))
    if path is None:
        bridge._broadcast(json.dumps({"type": "plan_result", "robot_id": robot_id, "success": False}))
        return

    waypoints = [cell_center_waypoint(cell) for cell in path[1:]]
    queue_robot_path({
        "robot_id": robot_id,
        "waypoints": waypoints,
        "motion": message.get("motion"),
        "path_id": message.get("path_id", next_subpath_id()),
    })

    replan_all_fleet(trigger_robot_id=robot_id)
    print(f"[PLAN] {robot_id} planned + fleet replanned")


def gui_command_sender(message_obj):
    """
    Called by WebSocket bridge when a browser sends a command.
    message_obj is a dict (from the browser JSON envelope).
    """
    try:
        message = message_obj if isinstance(message_obj, dict) else message_obj.to_dict()
        robot_id = message.get("robot_id")

        if message.get("type") == "set_obstacles":
            global obstacles
            obstacles = message.get("obstacles", [])
            _save_json(OBSTACLES_FILE, obstacles)
            print(f"[OBSTACLES] Updated and saved: {len(obstacles)} obstacles")
            return

        if message.get("type") == "set_action_stops":
            global action_stops
            action_stops = message.get("stops", [])
            _save_json(ACTION_STOPS_FILE, action_stops)
            print(f"[ACTION STOPS] Updated and saved: {len(action_stops)} stops")
            return

        if message.get("type") == "create_task":
            td = message.get("task", {})
            task_id = td.get("id", f"task_{int(time.time() * 1000)}")
            task = Task(
                id=task_id, name=td.get("name", "Unnamed"),
                robot_id=td.get("robot_id", ""),
                steps=td.get("steps", []),
                recurring=str(td.get("recurring", "once")),
            )
            with tasks_lock:
                tasks[task_id] = task
            with clients_lock:
                cid = robots_by_id.get(task.robot_id)
                if cid:
                    sess = client_sessions.get(cid)
                    if sess:
                        sess.active_task_id = task_id
            task.status = "active"
            broadcast_task_update(task_id)
            execute_task_step(task_id)
            print(f"[TASK] Created {task_id}: {task.name}")
            return

        if message.get("type") == "pause_task":
            tid = message.get("task_id")
            with tasks_lock:
                t = tasks.get(tid)
                if t and t.status == "active":
                    t.status = "paused"
                    send_to_robot(t.robot_id, {"type": "pause", "robot_id": t.robot_id, "reason": "task_paused"})
            broadcast_task_update(tid)
            return

        if message.get("type") == "resume_task":
            tid = message.get("task_id")
            with tasks_lock:
                t = tasks.get(tid)
                if t and t.status == "paused":
                    t.status = "active"
                    send_to_robot(t.robot_id, {"type": "resume", "robot_id": t.robot_id})
            broadcast_task_update(tid)
            execute_task_step(tid)
            return

        if message.get("type") == "cancel_task":
            tid = message.get("task_id")
            with tasks_lock:
                t = tasks.get(tid)
                if t:
                    t.status = "completed"
                    send_to_robot(t.robot_id, {"type": "stop", "robot_id": t.robot_id, "reason": "task_cancelled"})
                    with clients_lock:
                        cid = robots_by_id.get(t.robot_id)
                        if cid:
                            sess = client_sessions.get(cid)
                            if sess:
                                clear_robot_sequence(sess)
                                sess.active_task_id = None
                    clear_reservations(t.robot_id)
            remove_task_from_all_queues(tid)
            broadcast_task_update(tid)
            return

        if message.get("type") == "get_tasks":
            with tasks_lock:
                tl = [{"id": t.id, "name": t.name, "robot_id": t.robot_id,
                       "steps": t.steps, "recurring": t.recurring,
                       "status": t.status, "current_step": t.current_step,
                       "iterations_done": t.iterations_done,
                       "error_message": t.error_message} for t in tasks.values()]
            bridge._broadcast(json.dumps({"type": "tasks_list", "tasks": tl}))
            return

        if message.get("type") == "coordinated_traverse":
            ok = start_coordinated_traverse(message)
            if ok:
                print("[GUI SEND] Started coordinated two-robot traverse")
            else:
                print("[GUI SEND] Failed to start coordinated two-robot traverse")
            return

        if not robot_id:
            print("[GUI SEND] Refusing to send message with no robot_id")
            return

        if message.get("type") == "plan_path":
            handle_plan_path(robot_id, message)
            return

        if message.get("type") == "calibrate":
            target_x = float(message.get("x_cm", 0))
            target_y = float(message.get("y_cm", 0))
            target_theta = float(message.get("theta_deg", 0))

            with clients_lock:
                client_id = robots_by_id.get(robot_id)
                session = client_sessions.get(client_id) if client_id is not None else None
                if session is not None:
                    raw_x = float((session.last_telemetry or {}).get("x_cm", 0))
                    raw_y = float((session.last_telemetry or {}).get("y_cm", 0))
                    raw_theta = float((session.last_telemetry or {}).get("theta_deg", 0))
                    if session.pose_offset:
                        raw_x -= session.pose_offset.get("dx", 0)
                        raw_y -= session.pose_offset.get("dy", 0)
                        raw_theta -= session.pose_offset.get("dtheta", 0)
                    session.pose_offset = {
                        "dx": target_x - raw_x,
                        "dy": target_y - raw_y,
                        "dtheta": target_theta - raw_theta,
                    }
                    if session.last_telemetry is None:
                        session.last_telemetry = {}
                    session.last_telemetry["x_cm"] = target_x
                    session.last_telemetry["y_cm"] = target_y
                    session.last_telemetry["theta_deg"] = target_theta
                    print(f"[CALIBRATE] {robot_id} offset set: {session.pose_offset}")

            ok = send_to_robot(robot_id, message)
            if robot_id:
                bridge.update_robot(robot_id, {
                    "x_cm": target_x,
                    "y_cm": target_y,
                    "theta_deg": target_theta,
                })
        elif message.get("type") == "path_assignment":
            ok = queue_robot_path(message)
        else:
            if message.get("type") == "stop":
                with clients_lock:
                    client_id = robots_by_id.get(robot_id)
                    session = client_sessions.get(client_id) if client_id is not None else None
                    if session is not None:
                        clear_robot_sequence(session)
                clear_reservations(robot_id)

            ok = send_to_robot(robot_id, message)

        if ok:
            print(f"[GUI SEND] Sent {message.get('type')} to {robot_id}")
        else:
            print(f"[GUI SEND] Failed to send {message.get('type')} to {robot_id}")

    except Exception as exc:
        print(f"[GUI SEND] Error building/sending message: {exc}")


# Module-level bridge instance (replaces the old `gui` global)
bridge = WebSocketBridge(command_sender=gui_command_sender)


# ============================================================
# Session / identity helpers  (identical to central-arbiter.py)
# ============================================================
def touch_session(client_id: int) -> None:
    with clients_lock:
        session = client_sessions.get(client_id)
        if session:
            session.last_heartbeat = time.time()


def bind_identity_from_message(client_id: int, msg: dict) -> None:
    with clients_lock:
        session = client_sessions[client_id]

        if "name" in msg:
            session.name = str(msg["name"])
        elif "client_name" in msg:
            session.name = str(msg["client_name"])

        if "robot_id" in msg and msg["robot_id"] is not None:
            robot_id = str(msg["robot_id"])
            session.robot_id = robot_id
            robots_by_id[robot_id] = client_id

        if "state" in msg and msg["state"] is not None:
            session.state = str(msg["state"])

        if "path_id" in msg and msg["path_id"] is not None:
            session.current_path_id = str(msg["path_id"])

        if "waypoint_index" in msg and msg["waypoint_index"] is not None:
            try:
                session.current_waypoint_index = int(msg["waypoint_index"])
            except (TypeError, ValueError):
                pass


# ============================================================
# Message handlers  (gui.update_robot -> bridge.update_robot)
# ============================================================
def handle_hello(client_id: int, msg: dict, conn: socket.socket) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    session = get_session(client_id)
    print(
        f"[Client {client_id}] registered "
        f"name={session.name!r}, robot_id={session.robot_id!r}, state={session.state!r}"
    )

    send_json(conn, {
        "type": "ack",
        "for": "hello",
        "client_id": client_id,
        "robot_id": session.robot_id,
    })

    print_robot_table()


def apply_pose_offset(msg: dict, offset: dict) -> dict:
    patched = dict(msg)
    if "x_cm" in patched and offset.get("dx") is not None:
        patched["x_cm"] = float(patched["x_cm"]) + offset["dx"]
    if "y_cm" in patched and offset.get("dy") is not None:
        patched["y_cm"] = float(patched["y_cm"]) + offset["dy"]
    if "theta_deg" in patched and offset.get("dtheta") is not None:
        patched["theta_deg"] = float(patched["theta_deg"]) + offset["dtheta"]
    return patched


def handle_telemetry(client_id: int, msg: dict) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    with clients_lock:
        session = client_sessions[client_id]
        if session.pose_offset is not None:
            msg = apply_pose_offset(msg, session.pose_offset)
        session.last_telemetry = msg

    if session.robot_id:
        bridge.update_robot(session.robot_id, msg)

    robot_label = session.robot_id if session.robot_id else f"client_{client_id}"
    print(f"[{robot_label}] telemetry: {msg}")


def handle_status(client_id: int, msg: dict) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    with clients_lock:
        session = client_sessions[client_id]
        if session.pose_offset is not None:
            msg = apply_pose_offset(msg, session.pose_offset)
        session.last_status = msg

        # Merge status into GUI-visible state if we have prior telemetry
        merged = dict(session.last_telemetry or {})
        merged.update(msg)

    if session.robot_id:
        bridge.update_robot(session.robot_id, merged)

    robot_label = session.robot_id if session.robot_id else f"client_{client_id}"
    print(f"[{robot_label}] status: {msg}")


def handle_path_event(client_id: int, msg: dict) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    with clients_lock:
        session = client_sessions[client_id]
        if session.pose_offset is not None:
            msg = apply_pose_offset(msg, session.pose_offset)

        # Path lifecycle messages should be visible in the GUI the same way
        # status updates are, while preserving the most recent telemetry pose.
        merged = dict(session.last_telemetry or {})
        merged.update(msg)

        event_type = str(msg.get("type", ""))
        if event_type == "path_started":
            merged["state"] = "executing_path"
            session.state = "executing_path"
        elif event_type == "waypoint_reached":
            merged["state"] = "waypoint_reached"
            session.state = "waypoint_reached"
        elif event_type == "path_complete":
            merged["state"] = "idle"
            session.state = "idle"
            session.current_waypoint_index = None
            session.current_path_id = None
            session.awaiting_path_complete = False
            session.active_subpath_id = None

        session.last_status = merged

    if session.robot_id:
        bridge.update_robot(session.robot_id, merged)

    robot_label = session.robot_id if session.robot_id else f"client_{client_id}"
    print(f"[{robot_label}] {msg.get('type')}: {msg}")

    if msg.get("type") == "path_complete":
        global current_time_step
        current_time_step += 1
        cleanup_stale_reservations(current_time_step)

        active_task_id = None
        if session.robot_id:
            with tasks_lock:
                for tid, t in tasks.items():
                    if t.robot_id == session.robot_id and t.status == 'active':
                        if t.current_step < len(t.steps) and t.steps[t.current_step].get('type') == 'navigate':
                            active_task_id = tid
                            break

            if active_task_id:
                with clients_lock:
                    cid = robots_by_id.get(session.robot_id)
                    sess = client_sessions.get(cid) if cid is not None else None
                    has_pending = sess and len(sess.pending_waypoints) > 0
                if has_pending:
                    dispatch_next_waypoint(session.robot_id)
                else:
                    advance_task_step(active_task_id)
            else:
                dispatch_next_waypoint(session.robot_id)

        maybe_dispatch_waiting_sequences()


def handle_ack(client_id: int, msg: dict) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    with clients_lock:
        session = client_sessions.get(client_id)
        if session is not None and msg.get("for") == "path_assignment":
            ack_path_id = msg.get("path_id")
            if ack_path_id is None or session.active_subpath_id is None:
                session.awaiting_path_ack = False
            else:
                try:
                    if int(ack_path_id) == session.active_subpath_id:
                        session.awaiting_path_ack = False
                except (TypeError, ValueError):
                    session.awaiting_path_ack = False

    robot_label = session.robot_id if session and session.robot_id else f"client_{client_id}"
    print(f"[{robot_label}] ack: {msg}")


def handle_heartbeat(client_id: int, conn: socket.socket, msg: dict) -> None:
    touch_session(client_id)
    bind_identity_from_message(client_id, msg)

    session = get_session(client_id)
    send_json(conn, {
        "type": "heartbeat_ack",
        "robot_id": session.robot_id if session else None,
        "server_t": time.time(),
    })


# ============================================================
# Client thread  (+ bridge.remove_robot on disconnect)
# ============================================================
def handle_client(client_id: int, conn: socket.socket, addr) -> None:
    print(f"[+] Client {client_id} connected from {addr}")

    try:
        send_json(conn, {
            "type": "hello_ack",
            "client_id": client_id,
            "message": "connected",
        })

        for line in recv_lines(conn):
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                print(f"[Client {client_id}] Bad JSON: {line}")
                continue

            msg_type = msg.get("type", "")

            if msg_type == "hello":
                handle_hello(client_id, msg, conn)

            elif msg_type == "telemetry":
                handle_telemetry(client_id, msg)

            elif msg_type == "heartbeat":
                handle_heartbeat(client_id, conn, msg)

            elif msg_type == "status":
                handle_status(client_id, msg)

            elif msg_type in {"path_started", "waypoint_reached", "path_complete"}:
                handle_path_event(client_id, msg)

            elif msg_type == "ack":
                handle_ack(client_id, msg)

            else:
                print(f"[Client {client_id}] unknown message type: {msg_type}")
                send_json(conn, {
                    "type": "error",
                    "message": f"unknown message type: {msg_type}",
                })

    except ConnectionResetError:
        print(f"[!] Client {client_id} connection reset")
    except Exception as exc:
        print(f"[!] Client {client_id} error: {exc}")
    finally:
        disconnected_robot_id = None
        with clients_lock:
            session = client_sessions.pop(client_id, None)
            if session and session.robot_id:
                disconnected_robot_id = session.robot_id
                mapped_client_id = robots_by_id.get(session.robot_id)
                if mapped_client_id == client_id:
                    robots_by_id.pop(session.robot_id, None)

        conn.close()

        if disconnected_robot_id:
            bridge.remove_robot(disconnected_robot_id)
            clear_reservations(disconnected_robot_id)
            with tasks_lock:
                for t in tasks.values():
                    if t.robot_id == disconnected_robot_id and t.status == "active":
                        t.status = "error"
                        t.error_message = "Robot disconnected"
                        broadcast_task_update(t.id)

        print(f"[-] Client {client_id} disconnected")
        print_robot_table()


# ============================================================
# Accept loop  (identical to central-arbiter.py)
# ============================================================
def accept_loop(server_sock: socket.socket) -> None:
    global next_client_id

    while True:
        conn, addr = server_sock.accept()

        with clients_lock:
            if len(client_sessions) >= MAX_CLIENTS:
                send_json(conn, {
                    "type": "error",
                    "message": "server full",
                })
                conn.close()
                continue

            client_id = next_client_id
            next_client_id += 1

            client_sessions[client_id] = ClientSession(
                client_id=client_id,
                conn=conn,
                addr=addr,
            )

        thread = threading.Thread(
            target=handle_client,
            args=(client_id, conn, addr),
            daemon=True,
        )
        thread.start()
        print_robot_table()


# ============================================================
# Server main  (identical to central-arbiter.py)
# ============================================================
def server_main() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server_sock:
        server_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        server_sock.bind((HOST, PORT))
        server_sock.listen()
        print(f"Server listening on {HOST}:{PORT}")

        accept_loop(server_sock)


def main() -> None:
    print("TCP server for robots on port 9000")
    print("WebSocket server on ws://localhost:8765")

    server_thread = threading.Thread(target=server_main, daemon=True)
    server_thread.start()

    bridge.run()


if __name__ == "__main__":
    main()
