#include <PRIZM.h>
#include <Wire.h>
#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

PRIZM prizm;

// ==============================
// Robot identity / status
// ==============================
const char *ROBOT_ID = "robot_A";
const char *robot_state = "idle";
int current_path_id = -1;
int current_waypoint_index = -1;

// ==============================
// Robot geometry
// ==============================
const float WHEEL_DIAMETER_CM = 10.16; // 4 inches
const float WHEEL_BASE_CM = 26.035;    // 10.25 inches
const float WHEEL_CIRCUMFERENCE_CM = PI * WHEEL_DIAMETER_CM;
const int GRIPPER_SERVO_ID = 1;
const int GRIPPER_OPEN_DEG = 100;
const int GRIPPER_CLOSED_DEG = 35;
const int GRIPPER_SERVO_SPEED_PERCENT = 75;

// ==============================
// Pose state
// ==============================
float x_cm = 200.0;
float y_cm = 100.0;
float theta_rad = PI / 2.0;

long prevLeftDeg = 0;
long prevRightDeg = 0;

// ==============================
// Path storage
// ==============================
const int MAX_WAYPOINTS = 12;
int16_t waypoint_xs[MAX_WAYPOINTS];
int16_t waypoint_ys[MAX_WAYPOINTS];
int waypoint_count = 0;

// ==============================
// Motion / execution state
// ==============================
bool path_running = false;
bool path_loaded = false;
bool path_paused = false;
bool path_started_sent = false;
bool gripper_closed = false;
bool prizm_ready = false;

const float POSITION_TOLERANCE_CM = 3.0;
int motor_speed = 180;

// ==============================
// Serial receive buffer
// ==============================
const int SERIAL_LINE_BUFFER_SIZE = 256;
char serialLineBuffer[SERIAL_LINE_BUFFER_SIZE];
uint8_t serialLineLength = 0;

// ==============================
// Timing
// ==============================
unsigned long lastTelemetrySendMs = 0;
const unsigned long TELEMETRY_PERIOD_MS = 250;
unsigned long lastSensorReadMs = 0;

// Speed tracking
unsigned long lastSpeedCalcMs = 0;
long lastSpeedLeftDeg = 0;
long lastSpeedRightDeg = 0;
float speed_cm_s = 0.0;
bool motor1_busy = false;
bool motor2_busy = false;
bool stall_detected = false;
unsigned long stallCheckStartMs = 0;
const unsigned long STALL_THRESHOLD_MS = 500;

// Telemetry suppression after S opcode (to let path JSON through)
unsigned long telemetrySuppressUntilMs = 0;
const unsigned long SENSOR_READ_PERIOD_MS = 500;
int cached_left_ultrasonic_cm = -1;
int cached_front_ultrasonic_cm = -1;
float cached_battery_voltage = 0.0;
int cached_motor1_current_ma = 0;
int cached_motor2_current_ma = 0;
int cached_servo1_position = 0;
int cached_servo2_position = 0;

// ==============================
// Helpers
// ==============================
float normalizeAngle(float angle)
{
  while (angle > PI)
    angle -= 2.0 * PI;
  while (angle < -PI)
    angle += 2.0 * PI;
  return angle;
}

float radToDeg(float angle_rad)
{
  return angle_rad * 180.0 / PI;
}

float degToRad(float angle_deg)
{
  return angle_deg * PI / 180.0;
}

int cmToMotorDegrees(float distance_cm)
{
  return (int)round((distance_cm / WHEEL_CIRCUMFERENCE_CM) * 360.0);
}

int robotTurnDegToMotorDegrees(float robot_turn_deg)
{
  float robot_turn_rad = robot_turn_deg * PI / 180.0;
  float wheel_travel_cm = (robot_turn_rad * WHEEL_BASE_CM) / 2.0;
  return cmToMotorDegrees(wheel_travel_cm);
}

void setRobotState(const char *new_state)
{
  robot_state = new_state;
}

void resetEncoderTracking()
{
  if (prizm_ready) prizm.resetEncoders();
  prevLeftDeg = 0;
  prevRightDeg = 0;
}

float distanceToWaypoint(float target_x, float target_y)
{
  float dx = target_x - x_cm;
  float dy = target_y - y_cm;
  return sqrt(dx * dx + dy * dy);
}

float headingToWaypointRad(float target_x, float target_y)
{
  float dx = target_x - x_cm;
  float dy = target_y - y_cm;
  return atan2(dy, dx);
}

float headingErrorDeg(float target_heading_rad)
{
  float err = normalizeAngle(target_heading_rad - theta_rad);
  return radToDeg(err);
}

// ==============================
// Odometry
// ==============================
void updatePoseFromEncoders(long leftDeg, long rightDeg)
{
  long deltaLeftDeg = leftDeg - prevLeftDeg;
  long deltaRightDeg = rightDeg - prevRightDeg;

  prevLeftDeg = leftDeg;
  prevRightDeg = rightDeg;

  // Convert motor degrees to wheel travel in cm
  float dL = ((float)deltaLeftDeg / 360.0) * WHEEL_CIRCUMFERENCE_CM;
  float dR = ((float)deltaRightDeg / 360.0) * WHEEL_CIRCUMFERENCE_CM;

  // Motor 2 positive means left wheel backward, so flip left side
  dL = -dL;

  float dCenter = (dL + dR) / 2.0;
  float dTheta = (dR - dL) / WHEEL_BASE_CM;

  float thetaMid = theta_rad + dTheta / 2.0;

  x_cm += dCenter * cos(thetaMid);
  y_cm += dCenter * sin(thetaMid);
  theta_rad = normalizeAngle(theta_rad + dTheta);
}

void updateOdometry()
{
  if (!prizm_ready) return;
  long leftDeg = prizm.readEncoderDegrees(2);  // motor 2 = left wheel
  long rightDeg = prizm.readEncoderDegrees(1); // motor 1 = right wheel
  updatePoseFromEncoders(leftDeg, rightDeg);
}

// ==============================
// Telemetry
// ==============================
void maybeUpdateSensors()
{
  unsigned long now = millis();

  if (now - lastSensorReadMs < SENSOR_READ_PERIOD_MS)
    return;
  if (Serial.available() > 0)
    return;

  if (!prizm_ready) return;
  cached_left_ultrasonic_cm = prizm.readSonicSensorCM(2);
  cached_front_ultrasonic_cm = prizm.readSonicSensorCM(4);
  cached_battery_voltage = prizm.readBatteryVoltage();
  cached_motor1_current_ma = prizm.readMotorCurrent(1);
  cached_motor2_current_ma = prizm.readMotorCurrent(2);
  cached_servo1_position = prizm.readServoPosition(1);
  cached_servo2_position = prizm.readServoPosition(2);
  lastSensorReadMs = now;
}

void updateSpeedAndStall()
{
  if (!prizm_ready) return;
  unsigned long now = millis();
  unsigned long dt = now - lastSpeedCalcMs;
  if (dt < 200) return;

  long leftDeg = prizm.readEncoderDegrees(2);
  long rightDeg = prizm.readEncoderDegrees(1);

  float dLeft = (float)(leftDeg - lastSpeedLeftDeg) / 360.0 * WHEEL_CIRCUMFERENCE_CM;
  float dRight = (float)(rightDeg - lastSpeedRightDeg) / 360.0 * WHEEL_CIRCUMFERENCE_CM;
  float dCenter = (dLeft + dRight) / 2.0;
  speed_cm_s = fabs(dCenter) / ((float)dt / 1000.0);

  motor1_busy = (prizm.readMotorBusy(1) == 1);
  motor2_busy = (prizm.readMotorBusy(2) == 1);

  bool motors_commanded = path_running;
  bool encoders_frozen = (leftDeg == lastSpeedLeftDeg && rightDeg == lastSpeedRightDeg);

  if (motors_commanded && encoders_frozen && (motor1_busy || motor2_busy)) {
    if (stallCheckStartMs == 0) stallCheckStartMs = now;
    stall_detected = (now - stallCheckStartMs > STALL_THRESHOLD_MS);
  } else {
    stallCheckStartMs = 0;
    stall_detected = false;
  }

  lastSpeedLeftDeg = leftDeg;
  lastSpeedRightDeg = rightDeg;
  lastSpeedCalcMs = now;
}

void printPoseJSON()
{
  unsigned long t_ms = millis();
  float theta_deg = radToDeg(theta_rad);

  Serial.print(F("{\"type\":\"telemetry\""));

  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));

  Serial.print(F(",\"state\":\""));
  Serial.print(robot_state);
  Serial.print(F("\""));

  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);

  Serial.print(F(",\"waypoint_index\":"));
  Serial.print(current_waypoint_index);

  Serial.print(F(",\"t_ms\":"));
  Serial.print(t_ms);

  Serial.print(F(",\"x_cm\":"));
  Serial.print(x_cm, 3);

  Serial.print(F(",\"y_cm\":"));
  Serial.print(y_cm, 3);

  Serial.print(F(",\"theta_deg\":"));
  Serial.print(theta_deg, 3);

  Serial.print(F(",\"front_ultrasonic_cm\":"));
  Serial.print(cached_front_ultrasonic_cm);

  Serial.print(F(",\"left_ultrasonic_cm\":"));
  Serial.print(cached_left_ultrasonic_cm);

  Serial.print(F(",\"gripper_closed\":"));
  Serial.print(gripper_closed ? F("true") : F("false"));

  Serial.print(F(",\"speed_cm_s\":"));
  Serial.print(speed_cm_s, 1);

  Serial.print(F(",\"motor1_busy\":"));
  Serial.print(motor1_busy ? F("true") : F("false"));

  Serial.print(F(",\"motor2_busy\":"));
  Serial.print(motor2_busy ? F("true") : F("false"));

  Serial.print(F(",\"stall\":"));
  Serial.print(stall_detected ? F("true") : F("false"));

  Serial.print(F(",\"battery_v\":"));
  Serial.print(cached_battery_voltage / 100.0, 2);

  Serial.print(F(",\"motor1_current_ma\":"));
  Serial.print(cached_motor1_current_ma);

  Serial.print(F(",\"motor2_current_ma\":"));
  Serial.print(cached_motor2_current_ma);

  Serial.print(F(",\"servo1_pos\":"));
  Serial.print(cached_servo1_position);

  Serial.print(F(",\"servo2_pos\":"));
  Serial.print(cached_servo2_position);

  Serial.println(F("}"));
}

void maybeSendTelemetry()
{
  unsigned long now = millis();
  if (now < telemetrySuppressUntilMs) return;
  if (now - lastTelemetrySendMs >= TELEMETRY_PERIOD_MS)
  {
    printPoseJSON();
    lastTelemetrySendMs = now;
  }
}

// ==============================
// Low-level motion primitives
// ==============================
void stopMotorsNow()
{
  if (prizm_ready) {
    prizm.setMotorDegrees(0, 0, 0, 0);
    prizm.setMotorPower(1, 0);
    prizm.setMotorPower(2, 0);
  }
  path_running = false;
}

void interruptActivePrimitive()
{
  updateOdometry();
  stopMotorsNow();
  resetEncoderTracking();
}

bool motorsBusy()
{
  if (!prizm_ready) return false;
  return (prizm.readMotorBusy(1) == 1 || prizm.readMotorBusy(2) == 1);
}

void startArcToward(float target_x, float target_y, float max_dist)
{
  float dx = target_x - x_cm;
  float dy = target_y - y_cm;
  float dist = sqrt(dx * dx + dy * dy);
  float target_heading = atan2(dy, dx);
  float heading_err = normalizeAngle(target_heading - theta_rad);

  // Limit segment length
  float seg_dist = min(dist, max_dist);

  float left_cm, right_cm;

  if (fabs(heading_err) < 0.02) {
    // Nearly straight — equal wheels
    left_cm = seg_dist;
    right_cm = seg_dist;
  } else {
    // Arc geometry: R = dist / (2 * sin(heading_err / 2))
    float R = seg_dist / (2.0 * sin(fabs(heading_err) / 2.0));
    float arc_angle = seg_dist / R;

    float inner = arc_angle * (R - WHEEL_BASE_CM / 2.0);
    float outer = arc_angle * (R + WHEEL_BASE_CM / 2.0);

    if (heading_err > 0) {
      // Turn left: left wheel inner (shorter), right wheel outer
      left_cm = inner;
      right_cm = outer;
    } else {
      // Turn right: right wheel inner (shorter), left wheel outer
      left_cm = outer;
      right_cm = inner;
    }
  }

  int left_deg = cmToMotorDegrees(left_cm);
  int right_deg = cmToMotorDegrees(right_cm);

  // Scale speeds so both motors finish at the same time
  int left_speed = motor_speed;
  int right_speed = motor_speed;
  int abs_left = abs(left_deg);
  int abs_right = abs(right_deg);
  if (abs_left > abs_right && abs_left > 0)
    right_speed = (int)((long)motor_speed * abs_right / abs_left);
  else if (abs_right > abs_left && abs_right > 0)
    left_speed = (int)((long)motor_speed * abs_left / abs_right);

  // Minimum speed so wheels don't stall
  if (left_speed < 20) left_speed = 20;
  if (right_speed < 20) right_speed = 20;

  resetEncoderTracking();
  if (prizm_ready) {
    // Motor 1 = right (positive = forward), Motor 2 = left (negative = forward)
    prizm.setMotorDegrees(right_speed, right_deg,
                          left_speed, -left_deg);
  }
  path_running = true;
  setRobotState("executing_path");
}

// ==============================
// Simple JSON field parsing
// ==============================
const char *findFieldValueStart(const char *json, const char *key)
{
  static char pattern[32];
  snprintf(pattern, sizeof(pattern), "\"%s\":", key);

  const char *start = strstr(json, pattern);
  if (start == NULL)
    return NULL;

  return start + strlen(pattern);
}

bool extractStringField(const char *json, const char *key, char *outVal, size_t outSize)
{
  const char *valueStart = findFieldValueStart(json, key);
  if (valueStart == NULL || *valueStart != '"' || outSize == 0)
    return false;

  valueStart++;
  const char *valueEnd = strchr(valueStart, '"');
  if (valueEnd == NULL)
    return false;

  size_t copyLen = valueEnd - valueStart;
  if (copyLen >= outSize)
  {
    copyLen = outSize - 1;
  }

  memcpy(outVal, valueStart, copyLen);
  outVal[copyLen] = '\0';
  return true;
}

bool jsonHasType(const char *json, const char *typeValue)
{
  char actualType[20];
  return extractStringField(json, "type", actualType, sizeof(actualType)) && strcmp(actualType, typeValue) == 0;
}

bool jsonTargetsThisRobot(const char *json)
{
  char targetRobot[20];
  return extractStringField(json, "robot_id", targetRobot, sizeof(targetRobot)) && strcmp(targetRobot, ROBOT_ID) == 0;
}

bool extractIntField(const char *json, const char *key, int &outVal)
{
  const char *valueStart = findFieldValueStart(json, key);
  if (valueStart == NULL)
    return false;

  char *valueEnd = NULL;
  long parsed = strtol(valueStart, &valueEnd, 10);
  if (valueEnd == valueStart)
    return false;

  outVal = (int)parsed;
  return true;
}

bool extractFloatField(const char *json, const char *key, float &outVal)
{
  const char *valueStart = findFieldValueStart(json, key);
  if (valueStart == NULL)
    return false;

  char *valueEnd = NULL;
  float parsed = (float)strtod(valueStart, &valueEnd);
  if (valueEnd == valueStart)
    return false;

  outVal = parsed;
  return true;
}

bool extractBoolField(const char *json, const char *key, bool &outVal)
{
  const char *valueStart = findFieldValueStart(json, key);
  if (valueStart == NULL)
    return false;

  if (strncmp(valueStart, "true", 4) == 0)
  {
    outVal = true;
    return true;
  }

  if (strncmp(valueStart, "false", 5) == 0)
  {
    outVal = false;
    return true;
  }

  return false;
}

int extractWaypoints(const char *json)
{
  int count = 0;
  const char *searchPos = json;

  while (count < MAX_WAYPOINTS)
  {
    const char *xKey = strstr(searchPos, "\"x_cm\":");
    if (xKey == NULL)
      break;
    xKey += 7;

    char *xEnd = NULL;
    waypoint_xs[count] = (int16_t)lround(strtod(xKey, &xEnd));
    if (xEnd == xKey)
      break;

    const char *yKey = strstr(xEnd, "\"y_cm\":");
    if (yKey == NULL)
      break;
    yKey += 7;

    char *yEnd = NULL;
    waypoint_ys[count] = (int16_t)lround(strtod(yKey, &yEnd));
    if (yEnd == yKey)
      break;

    count++;
    searchPos = yEnd;
  }

  return count;
}

// ==============================
// Command handling
// ==============================
void clearCurrentPath()
{
  waypoint_count = 0;
  current_waypoint_index = -1;
  current_path_id = -1;
  path_loaded = false;
  path_started_sent = false;
  path_running = false;
}

void sendAck(const char *forType)
{
  Serial.print(F("{\"type\":\"ack\""));
  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));
  Serial.print(F(",\"for\":\""));
  Serial.print(forType);
  Serial.print(F("\""));
  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);
  Serial.print(F(",\"t_ms\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void sendStatus(const char *state, const char *reason)
{
  Serial.print(F("{\"type\":\"status\""));
  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));
  Serial.print(F(",\"state\":\""));
  Serial.print(state);
  Serial.print(F("\""));
  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);
  Serial.print(F(",\"waypoint_index\":"));
  Serial.print(current_waypoint_index);
  Serial.print(F(",\"reason\":\""));
  Serial.print(reason);
  Serial.print(F("\""));
  Serial.print(F(",\"t_ms\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void sendPathStarted()
{
  Serial.print(F("{\"type\":\"path_started\""));
  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));
  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);
  Serial.print(F(",\"t_ms\":"));
  Serial.print(millis());
  Serial.println(F("}"));
}

void sendWaypointReached()
{
  Serial.print(F("{\"type\":\"waypoint_reached\""));
  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));
  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);
  Serial.print(F(",\"waypoint_index\":"));
  Serial.print(current_waypoint_index);
  Serial.print(F(",\"t_ms\":"));
  Serial.print(millis());
  Serial.print(F(",\"x_cm\":"));
  Serial.print(x_cm, 3);
  Serial.print(F(",\"y_cm\":"));
  Serial.print(y_cm, 3);
  Serial.print(F(",\"theta_deg\":"));
  Serial.print(radToDeg(theta_rad), 3);
  Serial.println(F("}"));
}

void sendPathComplete()
{
  Serial.print(F("{\"type\":\"path_complete\""));
  Serial.print(F(",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\""));
  Serial.print(F(",\"path_id\":"));
  Serial.print(current_path_id);
  Serial.print(F(",\"t_ms\":"));
  Serial.print(millis());
  Serial.print(F(",\"x_cm\":"));
  Serial.print(x_cm, 3);
  Serial.print(F(",\"y_cm\":"));
  Serial.print(y_cm, 3);
  Serial.print(F(",\"theta_deg\":"));
  Serial.print(radToDeg(theta_rad), 3);
  Serial.println(F("}"));
}

void handlePathAssignment(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;

  int newPathId = -1;
  extractIntField(json, "path_id", newPathId);

  int newSpeed = motor_speed;
  extractIntField(json, "drive_speed_deg_per_sec", newSpeed);

  bool replaceExisting = true;
  extractBoolField(json, "replace_existing", replaceExisting);

  if (!replaceExisting && (path_loaded || path_running))
  {
    sendStatus("blocked", "path_rejected_busy");
    return;
  }

  int newWaypointCount = extractWaypoints(json);
  if (newWaypointCount <= 0)
  {
    sendStatus("error", "bad_path_assignment");
    return;
  }

  if (replaceExisting && (path_loaded || path_running))
  {
    interruptActivePrimitive();
  }

  waypoint_count = newWaypointCount;
  current_path_id = newPathId;
  current_waypoint_index = 0;
  motor_speed = newSpeed;

  path_loaded = true;
  path_paused = false;
  path_started_sent = false;
  path_running = false;
  setRobotState("idle");

  sendAck("path_assignment");
  sendStatus("idle", "path_loaded");
  printPoseJSON();
}

void performPause()
{
  if (path_loaded || path_running)
  {
    interruptActivePrimitive();
  }

  path_paused = true;
  setRobotState("paused");
  sendAck("pause");
  sendStatus("paused", "pause_requested");
  printPoseJSON();
}

void handlePause(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;
  performPause();
}

void performResume()
{
  path_paused = false;
  if (path_loaded)
  {
    setRobotState("idle");
  }
  sendAck("resume");
  sendStatus(robot_state, "resume_requested");
}

void handleResume(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;
  performResume();
}

void performStop()
{
  interruptActivePrimitive();
  clearCurrentPath();
  path_paused = false;
  setRobotState("idle");

  sendAck("stop");
  sendStatus("idle", "stop_requested");
  printPoseJSON();
}

void performToggleGripper()
{
  gripper_closed = !gripper_closed;
  if (prizm_ready) {
    if (gripper_closed)
    {
      prizm.setServoPosition(GRIPPER_SERVO_ID, GRIPPER_CLOSED_DEG);
    }
    else
    {
      prizm.setServoPosition(GRIPPER_SERVO_ID, GRIPPER_OPEN_DEG);
    }
  }

  sendAck("toggle_gripper");
  sendStatus(robot_state, gripper_closed ? "gripper_closed" : "gripper_opened");
}

void handleStop(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;
  performStop();
}

void handleToggleGripper(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;
  performToggleGripper();
}

void handleCalibrate(const char *json)
{
  if (!jsonTargetsThisRobot(json))
    return;

  float newX = x_cm;
  float newY = y_cm;
  float newTheta = theta_rad;

  const char *px = strstr(json, "\"x_cm\":");
  if (px) newX = atof(px + 7);

  const char *py = strstr(json, "\"y_cm\":");
  if (py) newY = atof(py + 7);

  const char *pt = strstr(json, "\"theta_deg\":");
  if (pt) newTheta = atof(pt + 12) * PI / 180.0;

  x_cm = newX;
  y_cm = newY;
  theta_rad = newTheta;

  prevLeftDeg = prizm.readEncoderDegrees(1);
  prevRightDeg = prizm.readEncoderDegrees(2);

  Serial.print(F("{\"type\":\"ack\",\"for\":\"calibrate\",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\",\"x_cm\":"));
  Serial.print(x_cm, 1);
  Serial.print(F(",\"y_cm\":"));
  Serial.print(y_cm, 1);
  Serial.print(F(",\"theta_deg\":"));
  Serial.print(theta_rad * 180.0 / PI, 1);
  Serial.println(F("}"));
}

void handleCompactCalibrate(const char *line)
{
  // Format: C<x>,<y>,<theta_deg>
  const char *p = line + 1;
  char *end;
  float newX = strtod(p, &end);
  if (end == p || *end != ',') return;
  p = end + 1;
  float newY = strtod(p, &end);
  if (end == p || *end != ',') return;
  p = end + 1;
  float newTheta = strtod(p, &end);
  if (end == p) return;

  x_cm = newX;
  y_cm = newY;
  theta_rad = newTheta * PI / 180.0;
  resetEncoderTracking();

  Serial.print(F("{\"type\":\"ack\",\"for\":\"calibrate\",\"robot_id\":\""));
  Serial.print(ROBOT_ID);
  Serial.print(F("\",\"x_cm\":"));
  Serial.print(x_cm, 1);
  Serial.print(F(",\"y_cm\":"));
  Serial.print(y_cm, 1);
  Serial.print(F(",\"theta_deg\":"));
  Serial.print(radToDeg(theta_rad), 1);
  Serial.println(F("}"));
  printPoseJSON();
}

void handleCompactPath(const char *line)
{
  // Format: W<pathId>,<x1>,<y1>[,<x2>,<y2>,...]\n
  const char *p = line + 1; // skip 'W'
  char *end;
  int pathId = (int)strtol(p, &end, 10);
  if (end == p || *end != ',') {
    sendStatus("error", "bad_compact_path");
    return;
  }
  p = end + 1;

  int count = 0;
  while (count < MAX_WAYPOINTS) {
    int16_t wx = (int16_t)strtol(p, &end, 10);
    if (end == p) break;
    p = end;
    if (*p == ',') p++;
    int16_t wy = (int16_t)strtol(p, &end, 10);
    if (end == p) break;
    waypoint_xs[count] = wx;
    waypoint_ys[count] = wy;
    count++;
    p = end;
    if (*p == ',') p++;
    else break;
  }

  if (count <= 0) {
    sendStatus("error", "bad_compact_path");
    return;
  }

  if (path_loaded || path_running) {
    interruptActivePrimitive();
  }

  waypoint_count = count;
  current_path_id = pathId;
  current_waypoint_index = 0;
  path_loaded = true;
  path_paused = false;
  path_started_sent = false;
  path_running = false;
  setRobotState("idle");

  sendAck("path_assignment");
  sendStatus("idle", "path_loaded");
  printPoseJSON();
}

void handleControlOpcode(char opcode)
{
  if (opcode == 'P')
  {
    performPause();
  }
  else if (opcode == 'R')
  {
    performResume();
  }
  else if (opcode == 'S')
  {
    performStop();
    telemetrySuppressUntilMs = millis() + 2000;
    Serial.flush();
  }
  else if (opcode == 'G')
  {
    performToggleGripper();
  }
}

void handleIncomingJson(const char *json)
{
  if (jsonHasType(json, "path_assignment"))
  {
    handlePathAssignment(json);
  }
  else if (jsonHasType(json, "pause"))
  {
    handlePause(json);
  }
  else if (jsonHasType(json, "resume"))
  {
    handleResume(json);
  }
  else if (jsonHasType(json, "stop"))
  {
    handleStop(json);
  }
  else if (jsonHasType(json, "toggle_gripper"))
  {
    handleToggleGripper(json);
  }
  else if (jsonHasType(json, "calibrate"))
  {
    handleCalibrate(json);
  }
}

void readSerialCommands()
{
  while (Serial.available() > 0)
  {
    char c = (char)Serial.read();

    if (c == '\r')
    {
      continue;
    }

    if (c == '\n')
    {
      if (serialLineLength > 0)
      {
        serialLineBuffer[serialLineLength] = '\0';
        if (serialLineLength == 1 &&
            (serialLineBuffer[0] == 'P' ||
             serialLineBuffer[0] == 'R' ||
             serialLineBuffer[0] == 'S' ||
             serialLineBuffer[0] == 'G'))
        {
          handleControlOpcode(serialLineBuffer[0]);
        }
        else if (serialLineBuffer[0] == 'W')
        {
          handleCompactPath(serialLineBuffer);
        }
        else if (serialLineBuffer[0] == 'C')
        {
          handleCompactCalibrate(serialLineBuffer);
        }
        else
        {
          Serial.print(F("{\"type\":\"debug\",\"rx_len\":"));
          Serial.print(serialLineLength);
          Serial.print(F(",\"rx\":\""));
          // print first 60 chars to avoid flooding
          for (uint8_t i = 0; i < serialLineLength && i < 60; i++) {
            char ch = serialLineBuffer[i];
            if (ch == '"') Serial.print('\\');
            Serial.print(ch);
          }
          Serial.println(F("\"}"));
          handleIncomingJson(serialLineBuffer);
        }
        serialLineLength = 0;
      }
    }
    else
    {
      if (serialLineLength < SERIAL_LINE_BUFFER_SIZE - 1)
      {
        serialLineBuffer[serialLineLength++] = c;
      }
      else
      {
        Serial.println(F("{\"type\":\"debug\",\"msg\":\"line_overflow_dropped\"}"));
        serialLineLength = 0;
      }
    }
  }
}

// ==============================
// Arc-segment path controller
// ==============================
void updatePathController()
{
  if (!path_loaded || path_paused)
    return;

  // While motors are still executing an arc, just update odometry
  if (path_running && motorsBusy())
  {
    updateOdometry();
    return;
  }

  // Arc segment finished — update odometry and plan next segment
  if (path_running)
    updateOdometry();

  if (!path_started_sent)
  {
    sendPathStarted();
    path_started_sent = true;
  }

  // Advance past reached waypoints
  while (current_waypoint_index >= 0 && current_waypoint_index < waypoint_count)
  {
    float dist = distanceToWaypoint((float)waypoint_xs[current_waypoint_index],
                                    (float)waypoint_ys[current_waypoint_index]);
    if (dist > POSITION_TOLERANCE_CM)
      break;
    sendWaypointReached();
    current_waypoint_index++;
  }

  // Path complete?
  if (current_waypoint_index < 0 || current_waypoint_index >= waypoint_count)
  {
    stopMotorsNow();
    sendPathComplete();
    clearCurrentPath();
    setRobotState("idle");
    printPoseJSON();
    return;
  }

  // Start next arc segment toward current waypoint
  float target_x = (float)waypoint_xs[current_waypoint_index];
  float target_y = (float)waypoint_ys[current_waypoint_index];
  float dist = distanceToWaypoint(target_x, target_y);

  // Use shorter arc segments for course correction (max 15cm per segment)
  startArcToward(target_x, target_y, 15.0);
}

// ==============================
// Setup / loop
// ==============================
void setup()
{
  Wire.begin();
  delay(500);
  // Reset all I2C motor/servo controllers (addresses 1-6)
  for (int addr = 1; addr <= 6; addr++) {
    Wire.beginTransmission(addr);
    Wire.write(0x27);
    Wire.endTransmission();
    delay(10);
  }
  delay(1000);
  // Enable all controllers (skip button wait from PrizmBegin)
  for (int addr = 1; addr <= 6; addr++) {
    Wire.beginTransmission(addr);
    Wire.write(0x25);
    Wire.endTransmission();
    delay(10);
  }
  prizm_ready = true;
  Serial.begin(115200);
  prizm.setServoSpeed(GRIPPER_SERVO_ID, GRIPPER_SERVO_SPEED_PERCENT);
  prizm.setServoPosition(GRIPPER_SERVO_ID, GRIPPER_OPEN_DEG);

  setRobotState("ready");
  maybeUpdateSensors();
  printPoseJSON();
}

void loop()
{
  readSerialCommands();

  updatePathController();

  readSerialCommands();

  maybeUpdateSensors();
  updateSpeedAndStall();
  maybeSendTelemetry();
}
