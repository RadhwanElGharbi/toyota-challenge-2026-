// ESP32-C6 BLE UART bridge for TETRIX PRIZM + WiFi TCP bridge for RPLiDAR
// Based on the upstream WiFi bridge (main.cpp) from:
//   IdeasClinicUWaterloo/S26-Toyota-Innovation-Challenge/Autonomous_Fleets/esp32_firmware
// This version replaces the WiFi/TCP layer with BLE (Nordic UART Service)
// so no WiFi credentials are needed for PRIZM control.
// WiFi is used separately to stream RPLiDAR data to the PC over TCP.
//
// Wiring (ESP32-C6 DevKitM-1):
//   GPIO 5 (TX)  ->  PRIZM D2 (RX)   direct wire
//   GPIO 4 (RX)  <-  PRIZM D9 (TX)   2kΩ/3.9kΩ voltage divider (5V -> 3.3V)
//   GND          --  PRIZM GND
//
//   GPIO 11 (TX) ->  RPLiDAR RX
//   GPIO 10 (RX) <-  RPLiDAR TX
//   GPIO 2       ->  RPLiDAR MOTOCTL
//   5V           ->  RPLiDAR VMOTO
//   3.3V         ->  RPLiDAR VCC
//   GND          --  RPLiDAR GND
//
// Arduino IDE:
//   Board   : ESP32C6 Dev Module
//   Library : NimBLE-Arduino (v2.x)

#include <NimBLEDevice.h>
#include <WiFi.h>

// ===== WiFi credentials — fill in before flashing =====
const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASSWORD";

// ===== LiDAR WiFi TCP server =====
#define LIDAR_TCP_PORT 8888
WiFiServer lidarServer(LIDAR_TCP_PORT);
WiFiClient lidarClient;

// ===== LiDAR UART (UART2, GPIO10/11) =====
HardwareSerial LIDAR(2);
#define LIDAR_RXD   10
#define LIDAR_TXD   11
#define LIDAR_BAUD  115200
#define MOTOCTL_PIN 2

// ===== Nordic UART Service (NUS) UUIDs =====
#define SERVICE_UUID  "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_CHAR_UUID  "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"  // PC writes here
#define TX_CHAR_UUID  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"  // ESP32 notifies here

// ===== UART to PRIZM (C6 pinout, same as upstream main.cpp) =====
HardwareSerial PRIZM(1);
#define RXD1 4
#define TXD1 5
#define PRIZM_BAUD 9600  // M1 sketch (testing-bot-controls.ino)
                          // Change to 38400 for M2 (telemetry_and_communicate_to_arbiter.ino)

// ===== BLE globals =====
NimBLECharacteristic* pTxChar = nullptr;
bool clientConnected = false;

// ===== Server callbacks (NimBLE v2.x signatures) =====
class ServerCallbacks : public NimBLEServerCallbacks {
    void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) {
        clientConnected = true;
        Serial.println("[BLE] Client connected");
    }

    void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) {
        clientConnected = false;
        Serial.println("[BLE] Client disconnected — restarting advertising");
        NimBLEDevice::startAdvertising();
    }
};

// ===== Characteristic RX callback (NimBLE v2.x signature) =====
class RxCallbacks : public NimBLECharacteristicCallbacks {
    void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) {
        std::string val = pChar->getValue();

        // Forward every byte to PRIZM — same pattern as upstream TCP->PRIZM loop
        for (char c : val) {
            PRIZM.write(c);
        }

        Serial.print("[BLE->PRIZM] ");
        Serial.println(val.c_str());
    }
};

// ===== Setup =====
void setup() {
    // Debug serial (same as upstream)
    Serial.begin(115200);
    delay(500);

    // PRIZM serial — same config as upstream, baud matches PRIZM firmware
    PRIZM.begin(PRIZM_BAUD, SERIAL_8N1, RXD1, TXD1);

    // LiDAR motor on immediately so it's already spinning when the PC connects
    pinMode(MOTOCTL_PIN, OUTPUT);
    digitalWrite(MOTOCTL_PIN, HIGH);

    // LiDAR UART
    LIDAR.begin(LIDAR_BAUD, SERIAL_8N1, LIDAR_RXD, LIDAR_TXD);

    // BLE init — always runs first so robot control works even without WiFi
    NimBLEDevice::init("PRIZM_Bridge");

    NimBLEServer* pServer = NimBLEDevice::createServer();
    pServer->setCallbacks(new ServerCallbacks());

    NimBLEService* pService = pServer->createService(SERVICE_UUID);

    // TX characteristic — ESP32 notifies laptop with PRIZM responses
    pTxChar = pService->createCharacteristic(TX_CHAR_UUID, NIMBLE_PROPERTY::NOTIFY);

    // RX characteristic — laptop writes commands here
    NimBLECharacteristic* pRxChar = pService->createCharacteristic(
        RX_CHAR_UUID,
        NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR
    );
    pRxChar->setCallbacks(new RxCallbacks());

    pService->start();

    // Put name + service UUID in the advertisement packet (not scan response)
    // so Windows passive scanning can see it without requesting a scan response.
    NimBLEAdvertisementData advData;
    advData.setName("PRIZM_Bridge");
    advData.addServiceUUID(SERVICE_UUID);

    NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
    pAdv->setAdvertisementData(advData);
    pAdv->start();

    Serial.println("[BLE] PRIZM Bridge ready");
    Serial.println("[BLE] Advertising as 'PRIZM_Bridge'");
    Serial.println("[BLE] Waiting for connection...");

    // WiFi — best-effort, 10 s timeout. BLE works regardless of outcome.
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    Serial.print("[WiFi] Connecting to ");
    Serial.print(WIFI_SSID);
    unsigned long wifiStart = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 10000) {
        delay(500);
        Serial.print(".");
    }
    Serial.println();
    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("[WiFi] IP: ");
        Serial.println(WiFi.localIP());
        lidarServer.begin();
        Serial.print("[LiDAR] TCP server on port ");
        Serial.println(LIDAR_TCP_PORT);
    } else {
        Serial.println("[WiFi] Not connected — LiDAR TCP unavailable. Fill in WIFI_SSID/WIFI_PASS to enable.");
    }
}

// ===== Main loop =====
void loop() {
    // Accept a new LiDAR TCP client if none is connected
    if (!lidarClient || !lidarClient.connected()) {
        WiFiClient newClient = lidarServer.available();
        if (newClient) {
            lidarClient = newClient;
            Serial.println("[LiDAR] PC connected");
        }
    }

    // Bidirectional LiDAR bridge: UART2 <-> TCP
    // The rplidar Python library sends commands (start scan, stop, reset, get_info)
    // via TCP -> LIDAR TX, and receives scan packets via LIDAR RX -> TCP.
    if (lidarClient && lidarClient.connected()) {
        while (LIDAR.available()) {
            lidarClient.write(LIDAR.read());
        }
        while (lidarClient.available()) {
            LIDAR.write(lidarClient.read());
        }
    }

    // PRIZM -> BLE: buffer lines and notify client
    // Same pattern as upstream PRIZM->TCP section
    static String prizmBuffer = "";

    while (PRIZM.available()) {
        char c = PRIZM.read();
        prizmBuffer += c;

        if (c == '\n') {
            prizmBuffer.trim();

            if (prizmBuffer.length() > 0) {
                Serial.print("[PRIZM->BLE] ");
                Serial.println(prizmBuffer);

                if (clientConnected) {
                    pTxChar->setValue(prizmBuffer.c_str());
                    pTxChar->notify();
                }
            }

            prizmBuffer = "";
        }
    }

    // Small delay for stability (same as upstream)
    delay(2);
}
