"""
Mock robot simulator for testing the fleet stack without hardware.

Usage:
    python mock_robot.py                          # one robot, robot_A at (200, 100)
    python mock_robot.py --robot-id robot_B --x 300 --y 100 --theta 90
    python mock_robot.py --multi 4                # four robots in a grid
"""

import argparse
import json
import math
import random
import socket
import threading
import time
import sys


class MockRobot:
    TELEMETRY_PERIOD_S = 0.25
    HEARTBEAT_PERIOD_S = 2.0

    DRIVE_SPEED_CM_S = 15.0
    TURN_SPEED_DEG_S = 90.0
    POSITION_TOLERANCE_CM = 2.0
    HEADING_TOLERANCE_DEG = 4.0

    GRIPPER_OPEN_DEG = 100
    GRIPPER_CLOSED_DEG = 35
    GRIPPER_SPEED_DEG_S = 120.0

    BATTERY_FULL_V = 14.0
    BATTERY_EMPTY_V = 10.0
    ARENA_CM = 400

    def __init__(self, robot_id: str, server_host: str, server_port: int,
                 start_x: float, start_y: float, start_theta: float,
                 peer_robots: list = None):
        self.robot_id = robot_id
        self.server_host = server_host
        self.server_port = server_port
        self.peer_robots = peer_robots or []

        self.x = start_x
        self.y = start_y
        self.theta = start_theta

        self.state = "ready"
        self.path_id = -1
        self.waypoint_index = -1
        self.waypoints: list[dict] = []
        self.path_loaded = False
        self.path_paused = False
        self.gripper_closed = False
        self.gripper_pos = float(self.GRIPPER_OPEN_DEG)
        self.gripper_target = float(self.GRIPPER_OPEN_DEG)

        self.front_ultrasonic = 200
        self.left_ultrasonic = 200
        self.battery_v = self.BATTERY_FULL_V - random.uniform(0, 0.5)
        self.speed_cm_s = 0.0

        self.sock: socket.socket | None = None
        self.running = True
        self.boot_ms = int(time.time() * 1000)
        self._lock = threading.Lock()

    def t_ms(self) -> int:
        return int(time.time() * 1000) - self.boot_ms

    @staticmethod
    def normalize_angle(a: float) -> float:
        return (a + 180) % 360 - 180

    def send(self, msg: dict):
        if self.sock:
            line = json.dumps(msg, separators=(",", ":")) + "\n"
            try:
                self.sock.sendall(line.encode())
            except Exception as e:
                print(f"[{self.robot_id}] send error: {e}")

    def send_telemetry(self):
        self.send({
            "type": "telemetry",
            "robot_id": self.robot_id,
            "state": self.state,
            "path_id": self.path_id,
            "waypoint_index": self.waypoint_index,
            "t_ms": self.t_ms(),
            "x_cm": round(self.x, 3),
            "y_cm": round(self.y, 3),
            "theta_deg": round(self.normalize_angle(self.theta), 3),
            "front_ultrasonic_cm": self.front_ultrasonic,
            "left_ultrasonic_cm": self.left_ultrasonic,
            "gripper_closed": self.gripper_closed,
            "speed_cm_s": round(self.speed_cm_s, 1),
            "motor1_busy": self.state == "executing_path",
            "motor2_busy": self.state == "executing_path",
            "stall": False,
            "battery_v": round(self.battery_v * 100) / 100,
            "motor1_current_ma": 150 if self.state == "executing_path" else 0,
            "motor2_current_ma": 150 if self.state == "executing_path" else 0,
            "servo1_pos": int(self.gripper_pos),
            "servo2_pos": 0,
        })

    def send_status(self, state: str, reason: str):
        self.send({
            "type": "status",
            "robot_id": self.robot_id,
            "state": state,
            "path_id": self.path_id,
            "waypoint_index": self.waypoint_index,
            "reason": reason,
            "t_ms": self.t_ms(),
        })

    def send_ack(self, for_type: str):
        self.send({
            "type": "ack",
            "robot_id": self.robot_id,
            "for": for_type,
            "path_id": self.path_id,
            "t_ms": self.t_ms(),
        })

    def send_path_started(self):
        self.send({
            "type": "path_started",
            "robot_id": self.robot_id,
            "path_id": self.path_id,
            "t_ms": self.t_ms(),
        })

    def send_waypoint_reached(self):
        self.send({
            "type": "waypoint_reached",
            "robot_id": self.robot_id,
            "path_id": self.path_id,
            "waypoint_index": self.waypoint_index,
            "t_ms": self.t_ms(),
            "x_cm": round(self.x, 3),
            "y_cm": round(self.y, 3),
            "theta_deg": round(self.normalize_angle(self.theta), 3),
        })

    def send_path_complete(self):
        self.send({
            "type": "path_complete",
            "robot_id": self.robot_id,
            "path_id": self.path_id,
            "t_ms": self.t_ms(),
            "x_cm": round(self.x, 3),
            "y_cm": round(self.y, 3),
            "theta_deg": round(self.normalize_angle(self.theta), 3),
        })

    # ================================================================
    #  Simple turn-then-drive simulation
    # ================================================================
    def simulate_step(self, dt: float):
        if not self.path_loaded or self.path_paused:
            self.speed_cm_s = 0.0
            return
        if self.waypoint_index < 0 or self.waypoint_index >= len(self.waypoints):
            self.speed_cm_s = 0.0
            return

        if self.state != "executing_path":
            self.send_path_started()
            self.state = "executing_path"

        wp = self.waypoints[self.waypoint_index]
        tx = float(wp.get("x_cm", 0))
        ty = float(wp.get("y_cm", 0))

        dx = tx - self.x
        dy = ty - self.y
        dist = math.sqrt(dx * dx + dy * dy)

        if dist <= self.POSITION_TOLERANCE_CM:
            self.send_waypoint_reached()
            self.waypoint_index += 1
            print(f"[{self.robot_id}] waypoint {self.waypoint_index - 1} reached at ({self.x:.1f}, {self.y:.1f})")

            if self.waypoint_index >= len(self.waypoints):
                self.send_path_complete()
                self.path_loaded = False
                self.waypoints.clear()
                self.waypoint_index = -1
                self.path_id = -1
                self.state = "idle"
                self.speed_cm_s = 0.0
                print(f"[{self.robot_id}] path complete")
            return

        target_heading = math.degrees(math.atan2(dy, dx))
        heading_err = self.normalize_angle(target_heading - self.theta)

        if abs(heading_err) > self.HEADING_TOLERANCE_DEG:
            max_turn = self.TURN_SPEED_DEG_S * dt
            if abs(heading_err) <= max_turn:
                self.theta = target_heading
            else:
                self.theta += max_turn if heading_err > 0 else -max_turn
            self.theta = self.normalize_angle(self.theta)
            self.speed_cm_s = 0.0
        else:
            move = min(self.DRIVE_SPEED_CM_S * dt, dist)
            theta_rad = math.radians(self.theta)
            self.x += move * math.cos(theta_rad)
            self.y += move * math.sin(theta_rad)
            self.x = max(0, min(self.ARENA_CM, self.x))
            self.y = max(0, min(self.ARENA_CM, self.y))
            self.speed_cm_s = move / dt if dt > 0 else 0

    # ================================================================
    #  Sensors / peripherals
    # ================================================================
    def update_sensors(self):
        theta_rad = math.radians(self.theta)
        cos_t = math.cos(theta_rad)
        sin_t = math.sin(theta_rad)

        front_wall = 200.0
        if abs(cos_t) > 0.01:
            front_wall = min(front_wall, ((self.ARENA_CM - self.x) / cos_t) if cos_t > 0 else (-self.x / cos_t))
        if abs(sin_t) > 0.01:
            front_wall = min(front_wall, ((self.ARENA_CM - self.y) / sin_t) if sin_t > 0 else (-self.y / sin_t))
        front_wall = max(0, min(200, front_wall))

        front_robot = 200.0
        for peer in self.peer_robots:
            if peer.robot_id == self.robot_id:
                continue
            pdx = peer.x - self.x
            pdy = peer.y - self.y
            pdist = math.sqrt(pdx * pdx + pdy * pdy)
            if pdist < 2 or pdist > 200:
                continue
            angle_to = math.atan2(pdy, pdx)
            angle_diff = abs(((math.degrees(angle_to) - self.theta) + 180) % 360 - 180)
            if angle_diff < 30:
                front_robot = min(front_robot, pdist - 15)

        self.front_ultrasonic = max(2, int(min(front_wall, front_robot)) + random.randint(-1, 1))

        left_rad = theta_rad + math.pi / 2
        cos_l = math.cos(left_rad)
        sin_l = math.sin(left_rad)
        left_wall = 200.0
        if abs(cos_l) > 0.01:
            left_wall = min(left_wall, ((self.ARENA_CM - self.x) / cos_l) if cos_l > 0 else (-self.x / cos_l))
        if abs(sin_l) > 0.01:
            left_wall = min(left_wall, ((self.ARENA_CM - self.y) / sin_l) if sin_l > 0 else (-self.y / sin_l))
        self.left_ultrasonic = max(2, int(min(200, left_wall)) + random.randint(-1, 1))

    def update_gripper(self, dt: float):
        if abs(self.gripper_pos - self.gripper_target) < 0.5:
            self.gripper_pos = self.gripper_target
            return
        direction = 1 if self.gripper_target > self.gripper_pos else -1
        self.gripper_pos += direction * self.GRIPPER_SPEED_DEG_S * dt
        self.gripper_pos = max(self.GRIPPER_CLOSED_DEG, min(self.GRIPPER_OPEN_DEG, self.gripper_pos))

    def update_battery(self, dt: float):
        drain = 0.00015 if self.state == "executing_path" else 0.00002
        self.battery_v = max(self.BATTERY_EMPTY_V, self.battery_v - drain * dt)

    # ================================================================
    #  Command handlers
    # ================================================================
    def handle_path_assignment(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return

        self.path_id = msg.get("path_id", -1)
        self.waypoints = msg.get("waypoints", [])
        self.waypoint_index = 0
        self.path_loaded = True
        self.path_paused = False
        self.state = "idle"

        self.send_ack("path_assignment")
        self.send_status("idle", "path_loaded")
        self.send_telemetry()
        print(f"[{self.robot_id}] path loaded: {len(self.waypoints)} waypoints")

    def handle_pause(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return
        self.path_paused = True
        self.state = "paused"
        self.send_ack("pause")
        self.send_status("paused", "pause_requested")
        print(f"[{self.robot_id}] paused")

    def handle_resume(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return
        self.path_paused = False
        self.state = "idle" if self.path_loaded else "ready"
        self.send_ack("resume")
        self.send_status(self.state, "resume_requested")
        print(f"[{self.robot_id}] resumed")

    def handle_stop(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return
        self.path_loaded = False
        self.waypoints.clear()
        self.waypoint_index = -1
        self.path_id = -1
        self.path_paused = False
        self.state = "idle"
        self.send_ack("stop")
        self.send_status("idle", "stop_requested")
        print(f"[{self.robot_id}] stopped")

    def handle_toggle_gripper(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return
        self.gripper_closed = not self.gripper_closed
        self.gripper_target = float(self.GRIPPER_CLOSED_DEG if self.gripper_closed else self.GRIPPER_OPEN_DEG)
        status = "gripper_closed" if self.gripper_closed else "gripper_opened"
        self.send_ack("toggle_gripper")
        self.send_status(self.state, status)
        print(f"[{self.robot_id}] {status}")

    def handle_calibrate(self, msg: dict):
        if msg.get("robot_id") != self.robot_id:
            return
        if "x_cm" in msg:
            self.x = float(msg["x_cm"])
        if "y_cm" in msg:
            self.y = float(msg["y_cm"])
        if "theta_deg" in msg:
            self.theta = float(msg["theta_deg"])
        self.send_ack("calibrate")
        self.send_telemetry()
        print(f"[{self.robot_id}] calibrated to ({self.x:.1f}, {self.y:.1f}, {self.theta:.1f}deg)")

    def handle_message(self, msg: dict):
        msg_type = msg.get("type", "")
        handler = {
            "path_assignment": self.handle_path_assignment,
            "pause": self.handle_pause,
            "resume": self.handle_resume,
            "stop": self.handle_stop,
            "toggle_gripper": self.handle_toggle_gripper,
            "calibrate": self.handle_calibrate,
        }.get(msg_type)
        if handler:
            handler(msg)

    # ================================================================
    #  Thread loops
    # ================================================================
    def receiver_loop(self):
        buffer = ""
        while self.running:
            try:
                data = self.sock.recv(4096)
                if not data:
                    print(f"[{self.robot_id}] server disconnected")
                    self.running = False
                    break

                buffer += data.decode("utf-8", errors="replace")
                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        msg = json.loads(line)
                        with self._lock:
                            self.handle_message(msg)
                    except json.JSONDecodeError:
                        pass

            except Exception as e:
                print(f"[{self.robot_id}] receiver error: {e}")
                self.running = False
                break

    def heartbeat_loop(self):
        while self.running:
            self.send({
                "type": "heartbeat",
                "robot_id": self.robot_id,
                "state": "connected",
                "t_ms": self.t_ms(),
            })
            time.sleep(self.HEARTBEAT_PERIOD_S)

    def telemetry_loop(self):
        while self.running:
            with self._lock:
                self.send_telemetry()
            time.sleep(self.TELEMETRY_PERIOD_S)

    def simulation_loop(self):
        dt = 0.05
        sensor_timer = 0.0
        while self.running:
            with self._lock:
                self.simulate_step(dt)
                self.update_gripper(dt)
                self.update_battery(dt)
                sensor_timer += dt
                if sensor_timer >= 0.5:
                    self.update_sensors()
                    sensor_timer = 0.0
            time.sleep(dt)

    def connect_and_run(self):
        try:
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock.connect((self.server_host, self.server_port))
            print(f"[{self.robot_id}] connected to {self.server_host}:{self.server_port}")
        except Exception as e:
            print(f"[{self.robot_id}] connection failed: {e}")
            return

        self.send({
            "type": "hello",
            "robot_id": self.robot_id,
            "client_name": f"{self.robot_id}_mock",
            "state": "ready",
        })

        threads = [
            threading.Thread(target=self.receiver_loop, daemon=True),
            threading.Thread(target=self.heartbeat_loop, daemon=True),
            threading.Thread(target=self.telemetry_loop, daemon=True),
            threading.Thread(target=self.simulation_loop, daemon=True),
        ]
        for t in threads:
            t.start()

        print(f"[{self.robot_id}] running at ({self.x}, {self.y}, {self.theta:.0f}deg)")

        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"\n[{self.robot_id}] shutting down")
            self.running = False

        if self.sock:
            self.sock.close()


def main():
    parser = argparse.ArgumentParser(description="Mock robot simulator")
    parser.add_argument("--host", default="127.0.0.1", help="Arbiter host")
    parser.add_argument("--port", type=int, default=9000, help="Arbiter port")
    parser.add_argument("--robot-id", default="robot_A", help="Robot ID")
    parser.add_argument("--x", type=float, default=200.0, help="Start x (cm)")
    parser.add_argument("--y", type=float, default=100.0, help="Start y (cm)")
    parser.add_argument("--theta", type=float, default=90.0, help="Start heading (deg)")
    parser.add_argument("--multi", type=int, nargs="?", const=2, default=0, metavar="N",
                        help="Run N robots (default 2) in a grid layout")
    args = parser.parse_args()

    if args.multi:
        n = args.multi
        cols = math.ceil(math.sqrt(n))
        spacing = 80
        robots = []
        for i in range(n):
            r = i // cols
            c = i % cols
            rid = f"robot_{chr(65 + i)}"
            px = 100 + c * spacing
            py = 80 + r * spacing
            robots.append(MockRobot(rid, args.host, args.port, px, py, 90.0))

        for rob in robots:
            rob.peer_robots = robots

        for robot in robots:
            threading.Thread(target=robot.connect_and_run, daemon=True).start()
            time.sleep(0.3)

        print(f"\n[MULTI] {n} robots running. Press Ctrl+C to stop.\n")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            print(f"\n[MULTI] Shutting down all robots")
            for robot in robots:
                robot.running = False
    else:
        robot = MockRobot(args.robot_id, args.host, args.port, args.x, args.y, args.theta)
        robot.connect_and_run()


if __name__ == "__main__":
    main()
