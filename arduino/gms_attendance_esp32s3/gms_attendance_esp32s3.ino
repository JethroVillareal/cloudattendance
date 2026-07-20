#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <FS.h>
#include <LittleFS.h>
#include <SPI.h>
#include <SD.h>
#include <Adafruit_Fingerprint.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SH110X.h>
#include <RTClib.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_idf_version.h>
#include <Preferences.h>

// =====================================================
// ESP32-S3 R503 ATTENDANCE FIRMWARE - PROFESSIONAL OLED + OFFLINE SYNC
//
// NFC tag/card scanning is intentionally removed.
// Attendance is triggered only by an R503 fingerprint
// template match. The server maps fingerprintId to the
// employee profile and applies the Time In/Time Out rules.
// =====================================================

// =====================================================
// CONFIGURATION - change before uploading if needed
// =====================================================

#include "secrets.h"


const char* FIRMWARE_VERSION =
    "5.1.0-local-cloud-failover";

// =====================================================
// GPIO CONFIGURATION
// =====================================================

// DS3231 RTC and SH1106 OLED share the same I2C bus.
constexpr uint8_t I2C_SDA_PIN = 8;
constexpr uint8_t I2C_SCL_PIN = 9;

// SH1106 OLED 128x64 I2C.
// Most modules use 0x3C. Some use 0x3D, so setup tries both.
constexpr bool ENABLE_OLED = true;
constexpr uint8_t OLED_WIDTH = 128;
constexpr uint8_t OLED_HEIGHT = 64;
constexpr uint8_t OLED_ADDRESS_PRIMARY = 0x3C;
constexpr uint8_t OLED_ADDRESS_SECONDARY = 0x3D;
constexpr int8_t OLED_RESET_PIN = -1;

// R503 UART wiring:
// R503 TX -> ESP32-S3 GPIO16 (RX)
// R503 RX -> ESP32-S3 GPIO17 (TX)
constexpr uint8_t FINGERPRINT_RX_PIN = 16;
constexpr uint8_t FINGERPRINT_TX_PIN = 17;
constexpr uint32_t FINGERPRINT_BAUD = 57600;

// External RGB LED is optional. R503 has its own Aura LED.
constexpr bool ENABLE_RGB_LED = true;

// Buzzer enabled. For 2-pin buzzer: + to BUZZER_PIN, - to GND.
constexpr bool ENABLE_BUZZER = true;

// External RGB LED pins. Change these if your RGB LED uses other GPIOs.
constexpr uint8_t RGB_RED_PIN = 38;
constexpr uint8_t RGB_GREEN_PIN = 39;
constexpr uint8_t RGB_BLUE_PIN = 40;

// true = common cathode / HIGH turns channel on.
// false = common anode / LOW turns channel on.
constexpr bool RGB_ACTIVE_HIGH = true;

// Change this if your buzzer is on another GPIO.
constexpr uint8_t BUZZER_PIN = 10;

// MicroSD Module (SPI) wiring. Change these if your module uses other GPIOs.
// SD VCC -> 3.3V, GND -> GND, SCK -> GPIO12, MISO -> GPIO13,
// MOSI -> GPIO11, CS -> GPIO14. GPIO10 is already used by the buzzer.
constexpr bool ENABLE_MICROSD = true;
constexpr uint8_t SD_SCK_PIN = 12;
constexpr uint8_t SD_MISO_PIN = 13;
constexpr uint8_t SD_MOSI_PIN = 11;
constexpr uint8_t SD_CS_PIN = 14;
constexpr uint32_t SD_SPI_FREQUENCY = 4000000;

// =====================================================
// DEVICE SETTINGS
// =====================================================

// ===== 24/7 RELIABILITY SETTINGS - edit here when needed =====
constexpr unsigned long WIFI_RETRY_INTERVAL_MS = 5000;
constexpr unsigned long WIFI_RETRY_MAX_INTERVAL_MS = 120000;
constexpr unsigned long SYNC_INTERVAL_MS = 15000;
constexpr unsigned long HEARTBEAT_INTERVAL_MS = 10000;
constexpr unsigned long DISPLAY_COMMAND_INTERVAL_MS = 2500;
constexpr unsigned long DUPLICATE_FINGER_DELAY_MS = 3000;
constexpr unsigned long READY_RESTORE_DELAY_MS = 2500;
constexpr unsigned long FINGER_REMOVE_TIMEOUT_MS = 5000;
constexpr uint16_t HEARTBEAT_HTTP_TIMEOUT_MS = 8000;
constexpr uint16_t API_HTTP_TIMEOUT_MS = 8000;
constexpr unsigned long OLED_SLEEP_TIMEOUT_MS = 60000;
constexpr unsigned long FINGERPRINT_POLL_INTERVAL_MS = 55;
constexpr unsigned long FINGERPRINT_RECOVERY_INTERVAL_MS = 30000;
constexpr unsigned long LOCAL_SERVER_PROBE_INTERVAL_MS = 30000;
constexpr unsigned long FINGERPRINT_OPERATION_TIMEOUT_MS = 30000;
constexpr unsigned long HEAP_LOG_INTERVAL_MS = 60000;
constexpr uint8_t FINGERPRINT_RECOVERY_LIMIT = 3;
constexpr uint32_t TASK_WATCHDOG_TIMEOUT_MS = 45000;

constexpr uint8_t MAX_SYNC_PER_PASS = 10;

const char* PENDING_FILE = "/pending.ndjson";
const char* TEMP_FILE = "/pending.tmp";
const char* BACKUP_FILE = "/pending.bak";

// Enrollment notification queue.
// Used when the fingerprint template is saved in R503 but the server is unavailable.
const char* ENROLL_PENDING_FILE = "/enroll_pending.ndjson";
const char* ENROLL_TEMP_FILE = "/enroll_pending.tmp";
const char* ENROLL_BACKUP_FILE = "/enroll_pending.bak";

// =====================================================
// HARDWARE OBJECTS
// =====================================================

HardwareSerial fingerprintSerial(1);
Adafruit_Fingerprint finger =
    Adafruit_Fingerprint(&fingerprintSerial);

RTC_DS3231 rtc;

Adafruit_SH1106G display = Adafruit_SH1106G(
  OLED_WIDTH,
  OLED_HEIGHT,
  &Wire,
  OLED_RESET_PIN
);

String formatDisplayTime(const DateTime& dateTime);
int firstAvailableFingerprintId();
uint8_t enrollFingerprint(uint16_t id);
bool deleteFingerprint(uint16_t id);
size_t countPendingRecords();
size_t countPendingEnrollmentRequests();
void wakeOled(bool restartIdleTimer = true);
void maintainOledProtection();
void maintainFingerprintRecovery();
void showSystemError(const char* component, const char* detail, const char* code);

// =====================================================
// RESPONSE MODEL
// =====================================================

struct DeviceDisplay {
  bool hasDisplay = false;
  String topStatus = "";
  String title = "";
  String line1 = "";
  String line2 = "";
  String line3 = "";
  String color = "BLUE";
  String beep = "NONE";
  unsigned long durationMs = READY_RESTORE_DELAY_MS;
};

struct ApiResponse {
  bool parsed = false;
  bool accepted = false;
  bool duplicateTap = false;

  String code = "";
  String message = "";
  String fullName = "";
  String attendanceType = "";
  String displayTime = "";
  String punctuality = "";       // Expected: ON_TIME or LATE from server
  int lateMinutes = 0;            // Expected from server when late
  bool hasLateMinutes = false;
  int remainingMinutes = 0;
  float paidHours = 0.0;
  DeviceDisplay deviceDisplay;
};

// =====================================================
// DEVICE STATE
// =====================================================

enum class DeviceState : uint8_t {
  IDLE,
  SCANNING,
  PROCESSING,
  SUCCESS,
  ERROR,
  OFFLINE,
  SYNCING
};

DeviceState deviceState = DeviceState::IDLE;

unsigned long lastWiFiAttempt = 0;
unsigned long lastSyncAttempt = 0;
unsigned long lastHeartbeatAttempt = 0;
unsigned long lastDisplayCommandPoll = 0;
unsigned long feedbackStartedAt = 0;
unsigned long activeFeedbackDurationMs = READY_RESTORE_DELAY_MS;

uint16_t lastFingerprintId = 0;
unsigned long lastFingerprintReadTime = 0;

bool feedbackActive = false;
bool syncInProgress = false;
bool fingerprintReady = false;
bool oledReady = false;
bool rtcReady = false;
bool wasWiFiConnected = false;
bool serverReachable = false;
String activeApiUrl = String(SERVER_URL) + "/api/attendance/scan";
bool activeServerIsLocal = true;
unsigned long lastLocalServerProbeAt = 0;
int lastServerStatusCode = 0;
String lastConnectionTitle = "";
unsigned long lastIdleOledRefresh = 0;
unsigned long lastDeviceActivityAt = 0;
unsigned long lastFingerprintPollAt = 0;
unsigned long lastFingerprintRecoveryAt = 0;
unsigned long lastHeapLogAt = 0;
unsigned long currentWiFiRetryIntervalMs = WIFI_RETRY_INTERVAL_MS;
bool oledSleeping = false;
String lastOledFrameKey = "";
uint8_t fingerprintCommunicationErrors = 0;
uint8_t fingerprintRecoveryAttempts = 0;
Preferences recoveryPreferences;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

bool idleCloseStatusActive = false;
String idleCloseStatusColor = "BLUE";
String idleCloseStatusCode = "WORK_HOURS";
uint16_t idleOpenTimeOutCount = 0;

// =====================================================
// OLED DISPLAY
// =====================================================

String fitOledLine(const String& text) {
  if (text.length() <= 21) {
    return text;
  }

  return text.substring(0, 21);
}

void drawOledLine(uint8_t y, const String& text) {
  display.setCursor(0, y);
  display.print(fitOledLine(text));
}

void wakeOled(bool restartIdleTimer) {
  if (!ENABLE_OLED || !oledReady) return;
  if (oledSleeping) {
    display.oled_command(SH110X_DISPLAYON);
    oledSleeping = false;
    lastOledFrameKey = "";
    Serial.println("[OLED] Display awake.");
  }
  if (restartIdleTimer) lastDeviceActivityAt = millis();
}

void maintainOledProtection() {
  if (!ENABLE_OLED || !oledReady || oledSleeping || feedbackActive) return;
  if (millis() - lastDeviceActivityAt < OLED_SLEEP_TIMEOUT_MS) return;
  display.oled_command(SH110X_DISPLAYOFF);
  oledSleeping = true;
  Serial.println("[OLED] Idle timeout; display sleeping.");
}

String connectionStatusTitle() {
  if (WiFi.status() != WL_CONNECTED) {
    return "OFFLINE";
  }

  if (serverReachable) {
    return activeServerIsLocal ? "LOCAL CONNECTED" : "CLOUD CONNECTED";
  }

  return "ONLINE DISCONNECTED";
}

String connectionDetailLine() {
  if (WiFi.status() != WL_CONNECTED) {
    return "WiFi not connected";
  }

  if (serverReachable) {
    return activeServerIsLocal ? "Local server connected" : "Render cloud connected";
  }

  if (lastServerStatusCode > 0) {
    return String("API HTTP ") + String(lastServerStatusCode);
  }

  return "Server offline";
}

void showOledScreen(
    const String& title,
    const String& line1 = "",
    const String& line2 = "",
    const String& line3 = "",
    const String& line4 = ""
) {
  if (!ENABLE_OLED || !oledReady) {
    return;
  }

  wakeOled(true);
  const String frameKey = title + '|' + line1 + '|' + line2 + '|' + line3 + '|' + line4;
  if (frameKey == lastOledFrameKey) return;
  lastOledFrameKey = frameKey;

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);

  drawOledLine(0, title);
  display.drawLine(0, 10, 127, 10, SH110X_WHITE);

  drawOledLine(16, line1);
  drawOledLine(28, line2);
  drawOledLine(40, line3);
  drawOledLine(52, line4);

  display.display();
}

void showIdleOled() {
  if (!ENABLE_OLED || !oledReady || oledSleeping) {
    return;
  }

  const DateTime now = rtc.now();
  const String timeText = formatDisplayTime(now);
  const String frameKey = connectionStatusTitle() + '|' + timeText + "|SCAN FINGERPRINT";
  if (frameKey == lastOledFrameKey) return;
  lastOledFrameKey = frameKey;

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);

  // Top: connection/server status only.
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.print(fitOledLine(connectionStatusTitle()));
  display.drawLine(0, 10, 127, 10, SH110X_WHITE);

  // Middle: big clock. This is the normal idle screen.
  display.setTextSize(2);
  display.setCursor(12, 22);
  display.print(timeText);

  // Bottom: simple instruction only.
  display.setTextSize(1);
  display.setCursor(0, 54);
  display.print("SCAN FINGERPRINT");

  display.display();
}

void showOledStatus(
    const String& line1,
    const String& line2 = "",
    const String& line3 = "",
    const String& line4 = ""
) {
  showOledScreen(
    connectionStatusTitle(),
    line1,
    line2,
    line3,
    line4
  );
}

void showLiveScanStage(
    const String& stage,
    const String& detail1 = "",
    const String& detail2 = "",
    const String& detail3 = ""
) {
  // During scan only: show progress/result. Idle stays clean.
  showOledScreen(
    connectionStatusTitle(),
    stage,
    detail1,
    detail2,
    detail3
  );
}

bool initializeOled() {
  if (!ENABLE_OLED) {
    return false;
  }

  Serial.println("[OLED] Initializing SH1106 OLED...");

  oledReady = display.begin(OLED_ADDRESS_PRIMARY, true);

  if (!oledReady) {
    oledReady = display.begin(OLED_ADDRESS_SECONDARY, true);
  }

  if (!oledReady) {
    Serial.println("[OLED] SH1106 not detected. Continuing without display.");
    return false;
  }

  display.clearDisplay();
  display.setTextColor(SH110X_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("GMS ATTENDANCE");
  display.println("OLED OK");
  display.println("Clean idle mode");
  display.display();

  Serial.println("[OLED] SH1106 display ready.");
  delay(800);
  return true;
}

String wifiStatusLine() {
  return connectionStatusTitle();
}

// =====================================================
// RGB LED AND BUZZER
// =====================================================

void writeRgbChannel(uint8_t pin, bool enabled) {
  if (!ENABLE_RGB_LED) {
    return;
  }

  const uint8_t activeLevel =
      RGB_ACTIVE_HIGH ? HIGH : LOW;
  const uint8_t inactiveLevel =
      RGB_ACTIVE_HIGH ? LOW : HIGH;

  digitalWrite(
    pin,
    enabled ? activeLevel : inactiveLevel
  );
}

void setRgb(bool red, bool green, bool blue) {
  if (!ENABLE_RGB_LED) {
    return;
  }

  writeRgbChannel(RGB_RED_PIN, red);
  writeRgbChannel(RGB_GREEN_PIN, green);
  writeRgbChannel(RGB_BLUE_PIN, blue);
}

void buzzerTone(
    unsigned int frequency,
    unsigned long durationMs
) {
  if (!ENABLE_BUZZER) {
    return;
  }

  tone(BUZZER_PIN, frequency, durationMs);
  delay(durationMs + 25);
  noTone(BUZZER_PIN);
}

void beepTimeIn() {
  buzzerTone(1800, 120);
}

void beepTimeOut() {
  buzzerTone(1400, 100);
  buzzerTone(1800, 130);
}

void beepOffline() {
  buzzerTone(1100, 100);
  buzzerTone(1100, 100);
}

void beepError() {
  buzzerTone(650, 140);
  buzzerTone(500, 180);
}

void beepFingerprintAccepted() {
  buzzerTone(1800, 80);
  buzzerTone(2200, 100);
}

void beginFeedback(unsigned long durationMs = READY_RESTORE_DELAY_MS) {
  feedbackActive = true;
  feedbackStartedAt = millis();
  activeFeedbackDurationMs =
      durationMs < 1000 ? READY_RESTORE_DELAY_MS : durationMs;
}

void setFingerprintLed(
    uint8_t control,
    uint8_t speed,
    uint8_t color
) {
  if (!fingerprintReady) {
    return;
  }

  finger.LEDcontrol(control, speed, color);
}

// Adafruit_Fingerprint only names indexes 1-3. Some R503 variants
// support more Aura LED color indexes, so COLOR/COLORS tests 1-8.
constexpr uint8_t R503_COLOR_INDEX_MIN = 1;
constexpr uint8_t R503_COLOR_INDEX_MAX = 8;

// Common 8-color R503 mapping. If your module shows a different color
// for an index, only change these constants.
constexpr uint8_t R503_AURA_RED = 1;
constexpr uint8_t R503_AURA_BLUE = 2;
constexpr uint8_t R503_AURA_PURPLE = 3;
constexpr uint8_t R503_AURA_GREEN = 4;
constexpr uint8_t R503_AURA_YELLOW = 5;
constexpr uint8_t R503_AURA_CYAN = 6;
constexpr uint8_t R503_AURA_WHITE = 7;
constexpr uint8_t R503_AURA_BLACK = 8;

String r503AuraColorName(uint8_t colorIndex) {
  switch (colorIndex) {
    case R503_AURA_RED:
      return "RED";
    case R503_AURA_BLUE:
      return "BLUE";
    case R503_AURA_PURPLE:
      return "PURPLE";
    case R503_AURA_GREEN:
      return "GREEN";
    case R503_AURA_YELLOW:
      return "YELLOW";
    case R503_AURA_CYAN:
      return "CYAN";
    case R503_AURA_WHITE:
      return "WHITE";
    case R503_AURA_BLACK:
      return "BLACK";
    default:
      return String("INDEX ") + String(colorIndex);
  }
}

void r503AuraOn(uint8_t colorIndex) {
  setFingerprintLed(
    FINGERPRINT_LED_ON,
    0,
    colorIndex
  );
}

void r503AuraFlash(uint8_t colorIndex) {
  setFingerprintLed(
    FINGERPRINT_LED_FLASHING,
    25,
    colorIndex
  );
}

void r503AuraBreathing(uint8_t colorIndex) {
  setFingerprintLed(
    FINGERPRINT_LED_BREATHING,
    60,
    colorIndex
  );
}

void r503LedOff() {
  setFingerprintLed(
    FINGERPRINT_LED_OFF,
    0,
    R503_AURA_BLUE
  );
}

void r503BlueBreathing() {
  r503AuraBreathing(R503_AURA_BLUE);
}

void r503PurpleBreathing() {
  r503AuraBreathing(R503_AURA_PURPLE);
}

void r503RedBreathing() {
  r503AuraBreathing(R503_AURA_RED);
}

void r503GreenBreathing() {
  r503AuraBreathing(R503_AURA_GREEN);
}

void r503YellowBreathing() {
  r503AuraBreathing(R503_AURA_YELLOW);
}

void r503CyanBreathing() {
  r503AuraBreathing(R503_AURA_CYAN);
}

void r503WhiteBreathing() {
  r503AuraBreathing(R503_AURA_WHITE);
}

void r503BlackBreathing() {
  r503LedOff();
}

void r503BlueOn() {
  r503AuraOn(R503_AURA_BLUE);
}

void r503PurpleOn() {
  r503AuraOn(R503_AURA_PURPLE);
}

void r503RedOn() {
  r503AuraOn(R503_AURA_RED);
}

void r503GreenOn() {
  r503AuraOn(R503_AURA_GREEN);
}

void r503YellowOn() {
  r503AuraOn(R503_AURA_YELLOW);
}

void r503CyanOn() {
  r503AuraOn(R503_AURA_CYAN);
}

void r503WhiteOn() {
  r503AuraOn(R503_AURA_WHITE);
}

void r503BlackOn() {
  r503LedOff();
}

void r503BlueFlash() {
  r503AuraFlash(R503_AURA_BLUE);
}

void r503PurpleFlash() {
  r503AuraFlash(R503_AURA_PURPLE);
}

void r503RedFlash() {
  r503AuraFlash(R503_AURA_RED);
}

void r503GreenFlash() {
  r503AuraFlash(R503_AURA_GREEN);
}

void r503YellowFlash() {
  r503AuraFlash(R503_AURA_YELLOW);
}

void r503CyanFlash() {
  r503AuraFlash(R503_AURA_CYAN);
}

void r503WhiteFlash() {
  r503AuraFlash(R503_AURA_WHITE);
}

void r503BlackFlash() {
  r503LedOff();
}

String displayChoice(String value) {
  value.trim();
  value.toUpperCase();
  return value;
}

void applyDeviceColor(const String& colorText) {
  const String color = displayChoice(colorText);

  if (color == "GREEN") {
    setRgb(false, true, false);
    r503GreenFlash();
  } else if (color == "PURPLE") {
    setRgb(true, false, true);
    r503PurpleBreathing();
  } else if (color == "YELLOW") {
    setRgb(true, true, false);
    r503YellowFlash();
  } else if (color == "CYAN") {
    setRgb(false, true, true);
    r503CyanBreathing();
  } else if (color == "WHITE") {
    setRgb(true, true, true);
    r503WhiteBreathing();
  } else if (color == "BLACK") {
    setRgb(false, false, false);
    r503BlackOn();
  } else if (color == "RED") {
    setRgb(true, false, false);
    r503RedFlash();
  } else {
    setRgb(false, false, true);
    r503BlueBreathing();
  }
}

void resetIdleCloseStatus() {
  idleCloseStatusActive = false;
  idleCloseStatusColor = "BLUE";
  idleCloseStatusCode = "WORK_HOURS";
  idleOpenTimeOutCount = 0;
}

void applyIdleReadyColor() {
  if (idleCloseStatusActive) {
    applyDeviceColor(idleCloseStatusColor);
    // Keep the fingerprint reader recognizable as ready without holding
    // the Aura ring at steady full brightness.
    r503BlueBreathing();
    return;
  }

  setRgb(false, false, true);
  // R503 exposes animation speed, not a true brightness percentage.
  // Breathing blue lowers average output while preserving the ready cue.
  r503BlueBreathing();
}

void playDeviceBeep(const String& beepText) {
  const String beep = displayChoice(beepText);

  if (beep == "SUCCESS") {
    beepFingerprintAccepted();
  } else if (beep == "ERROR") {
    beepError();
  } else if (beep == "NOTICE") {
    buzzerTone(1400, 90);
  } else if (beep == "WARNING") {
    buzzerTone(950, 120);
    buzzerTone(950, 120);
  }
}

void showDeviceDisplay(const DeviceDisplay& displayData) {
  const String topStatus =
      displayData.topStatus.isEmpty()
        ? connectionStatusTitle()
        : displayData.topStatus;

  applyDeviceColor(displayData.color);
  playDeviceBeep(displayData.beep);

  showOledScreen(
    topStatus,
    displayData.title,
    displayData.line1,
    displayData.line2,
    displayData.line3
  );

  beginFeedback(displayData.durationMs);

  Serial.print("[DISPLAY COMMAND] ");
  Serial.println(displayData.title);
}

void r503ColorShowcase() {
  if (!fingerprintReady) {
    Serial.println("[R503] Fingerprint sensor is not ready.");
    return;
  }

  Serial.println("[R503] Testing Aura LED color indexes 1 to 8.");
  Serial.println("[R503] Watch the fingerprint sensor ring and note each color.");
  setRgb(false, false, false);

  for (
    uint8_t colorIndex = R503_COLOR_INDEX_MIN;
    colorIndex <= R503_COLOR_INDEX_MAX;
    colorIndex++
  ) {
    Serial.print("[R503] Aura LED color index ");
    Serial.println(colorIndex);

    showOledScreen(
      "R503 COLOR TEST",
      String(colorIndex) + " " + r503AuraColorName(colorIndex),
      "Watch sensor ring",
      "Mapping varies",
      ""
    );

    r503AuraOn(colorIndex);
    delay(900);
    r503AuraFlash(colorIndex);
    delay(700);
    r503AuraBreathing(colorIndex);
    delay(700);
  }

  setRgb(false, false, true);
  r503BlueBreathing();
}

void r503ShowSingleColorIndex(uint8_t colorIndex) {
  if (!fingerprintReady) {
    Serial.println("[R503] Fingerprint sensor is not ready.");
    return;
  }

  if (
    colorIndex < R503_COLOR_INDEX_MIN ||
    colorIndex > R503_COLOR_INDEX_MAX
  ) {
    Serial.println("[R503] Color index must be 1 to 8.");
    return;
  }

  Serial.print("[R503] Showing Aura LED color index ");
  Serial.println(colorIndex);

  showOledScreen(
    "R503 COLOR TEST",
    String(colorIndex) + " " + r503AuraColorName(colorIndex),
    "Use COLOR 1-8",
    "to compare",
    ""
  );

  setRgb(false, false, false);
  r503AuraOn(colorIndex);
  beginFeedback(5000);
}

void showReadyFeedback() {
  // Idle uses breathing blue instead of a steady full-brightness Aura ring.
  applyIdleReadyColor();

  feedbackActive = false;
  deviceState = WiFi.status() == WL_CONNECTED ? DeviceState::IDLE : DeviceState::OFFLINE;
  wakeOled(true);
  lastIdleOledRefresh = millis();
  showIdleOled();

  Serial.println();
  Serial.println("[DEVICE] Ready for fingerprint scan.");
}

void showProcessingFeedback() {
  deviceState = DeviceState::PROCESSING;
  setRgb(false, true, true);
  r503CyanBreathing();
  beepFingerprintAccepted();
  beginFeedback();

  showLiveScanStage(
    "RECORDING",
    "MATCH CONFIRMED",
    "PLEASE WAIT",
    ""
  );

  Serial.println("[DEVICE] Processing fingerprint...");
}

void showOfflineFeedback() {
  deviceState = DeviceState::OFFLINE;
  setRgb(true, true, false);
  r503YellowFlash();
  beepOffline();
  beginFeedback();

  showLiveScanStage(
    "OFFLINE MODE",
    "Attendance Saved",
    "Syncing Later",
    "CODE: API-01"
  );

  Serial.println(
    "[DISPLAY] SAVED OFFLINE - Will sync automatically"
  );
}

void showErrorFeedback(const String& message) {
  deviceState = DeviceState::ERROR;
  // Red = error or rejected scan.
  setRgb(true, false, false);
  r503RedFlash();
  beepError();
  beginFeedback();

  showLiveScanStage(
    "SCAN ERROR",
    message,
    "Try again",
    ""
  );

  Serial.print("[DISPLAY] ERROR: ");
  Serial.println(message);
}

void maintainFeedbackState() {
  if (!feedbackActive || syncInProgress) {
    return;
  }

  if (
    millis() - feedbackStartedAt >=
    activeFeedbackDurationMs
  ) {
    showReadyFeedback();
  }
}

void showSystemError(const char* component, const char* detail, const char* code) {
  deviceState = DeviceState::ERROR;
  setRgb(true, false, false);
  if (fingerprintReady) r503RedFlash();
  showOledScreen("! SYSTEM ERROR !", component, detail, String("CODE: ") + code, "CONTACT ADMIN");
  Serial.printf("[SELF-TEST] %s - %s (%s)\n", component, detail, code);
}

// =====================================================
// TIME AND JSON
// =====================================================

// DS3231 is treated as Philippine local time.
String formatTimestamp(const DateTime& dateTime) {
  char timestamp[32];

  snprintf(
    timestamp,
    sizeof(timestamp),
    "%04d-%02d-%02dT%02d:%02d:%02d+08:00",
    dateTime.year(),
    dateTime.month(),
    dateTime.day(),
    dateTime.hour(),
    dateTime.minute(),
    dateTime.second()
  );

  return String(timestamp);
}

String formatDisplayTime(const DateTime& dateTime) {
  int hour = dateTime.hour();
  const bool isPm = hour >= 12;
  int displayHour = hour % 12;

  if (displayHour == 0) {
    displayHour = 12;
  }

  char timeText[16];

  snprintf(
    timeText,
    sizeof(timeText),
    "%02d:%02d %s",
    displayHour,
    dateTime.minute(),
    isPm ? "PM" : "AM"
  );

  return String(timeText);
}

String createEventId(const DateTime& dateTime) {
  char randomText[9];

  snprintf(
    randomText,
    sizeof(randomText),
    "%08lX",
    static_cast<unsigned long>(esp_random())
  );

  return String(DEVICE_ID)
      + "-"
      + String(dateTime.unixtime())
      + "-"
      + String(randomText);
}

String createFingerprintJson(
    uint16_t fingerprintId,
    uint16_t confidence,
    const DateTime& dateTime
) {
  JsonDocument document;

  document["schemaVersion"] = 4;
  document["eventId"] =
      createEventId(dateTime);

  document["deviceId"] = DEVICE_ID;
  document["location"] = DEVICE_LOCATION;

  document["scannedAt"] =
      formatTimestamp(dateTime);

  document["source"] = "ESP32-S3";
  document["firmwareVersion"] =
      FIRMWARE_VERSION;

  document["identityMode"] =
      "FINGERPRINT_ONLY";
  document["verificationMethod"] =
      "R503_FINGERPRINT";
  document["fingerprintId"] =
      fingerprintId;
  document["fingerprintConfidence"] =
      confidence;

  // The ESP32 only knows the matched template ID. The server resolves the
  // employee and decides Time In/Time Out when the unique event is synced.
  document["employeeId"] = "";
  document["attendanceType"] = "SERVER_CONTROLLED";
  document["transactionId"] = document["eventId"];
  document["syncStatus"] = "PENDING";

  // The server decides Time In vs Time Out.
  document["requestedAction"] =
      "SERVER_CONTROLLED";

  if (WiFi.status() == WL_CONNECTED) {
    document["wifiRssi"] = WiFi.RSSI();
    document["deviceIp"] =
        WiFi.localIP().toString();
  }

  String json;
  serializeJson(document, json);

  return json;
}

String createEnrollmentRequestJson(
    uint16_t fingerprintId,
    const DateTime& dateTime
) {
  JsonDocument document;

  document["schemaVersion"] = 4;
  document["eventId"] = createEventId(dateTime);
  document["eventType"] = "FINGERPRINT_ENROLLMENT_REQUEST";

  document["deviceId"] = DEVICE_ID;
  document["location"] = DEVICE_LOCATION;
  document["source"] = "ESP32-S3";
  document["firmwareVersion"] = FIRMWARE_VERSION;

  document["enrolledAt"] = formatTimestamp(dateTime);
  document["fingerprintId"] = fingerprintId;
  document["templateStored"] = true;
  document["status"] = "PENDING_EMPLOYEE_DETAILS";
  document["requestedAction"] = "OPEN_ENROLLMENT_MODAL";
  document["message"] = "Fingerprint saved locally. Fill employee details on server.";

  if (WiFi.status() == WL_CONNECTED) {
    document["wifiRssi"] = WiFi.RSSI();
    document["deviceIp"] = WiFi.localIP().toString();
  }

  String json;
  serializeJson(document, json);

  return json;
}

// =====================================================
// MICROSD / LITTLEFS OFFLINE STORAGE
// =====================================================

bool useMicroSdStorage = false;
bool littleFsReady = false;
bool microSdReady = false;
String microSdStatus = "Not checked";

const char* offlineStorageName() {
  return useMicroSdStorage ? "MicroSD" : "LittleFS";
}

File storageOpen(
    const char* filePath,
    const char* mode
) {
  if (useMicroSdStorage) {
    return SD.open(filePath, mode);
  }

  return LittleFS.open(filePath, mode);
}

bool storageExists(const char* filePath) {
  return useMicroSdStorage
      ? SD.exists(filePath)
      : LittleFS.exists(filePath);
}

bool storageRemove(const char* filePath) {
  return useMicroSdStorage
      ? SD.remove(filePath)
      : LittleFS.remove(filePath);
}

bool storageRename(
    const char* fromPath,
    const char* toPath
) {
  return useMicroSdStorage
      ? SD.rename(fromPath, toPath)
      : LittleFS.rename(fromPath, toPath);
}

String microSdCardTypeName(uint8_t cardType) {
  if (cardType == CARD_MMC) {
    return "MMC";
  }

  if (cardType == CARD_SD) {
    return "SDSC";
  }

  if (cardType == CARD_SDHC) {
    return "SDHC";
  }

  return "UNKNOWN";
}

void showMicroSdFallbackNotice() {
  if (!ENABLE_OLED || !oledReady) {
    return;
  }

  showOledScreen(
    "SD CARD WARNING",
    "No card or mount fail",
    "Using LittleFS backup",
    "Insert SD then reboot",
    ""
  );

  delay(1200);
}

bool initializeLittleFsStorage() {
  if (LittleFS.begin(false)) {
    littleFsReady = true;
    Serial.println(
      "[STORAGE] LittleFS mounted."
    );

    return true;
  }

  Serial.println(
    "[STORAGE] LittleFS mount failed. Formatting..."
  );

  if (!LittleFS.begin(true)) {
    Serial.println(
      "[STORAGE] LittleFS format failed."
    );

    return false;
  }

  littleFsReady = true;
  Serial.println(
    "[STORAGE] LittleFS formatted."
  );

  return true;
}

bool initializeMicroSdStorage() {
  microSdReady = false;
  useMicroSdStorage = false;

  if (!ENABLE_MICROSD) {
    microSdStatus = "Disabled in firmware";
    Serial.println("[STORAGE] MicroSD disabled in firmware.");
    return false;
  }

  Serial.println("[STORAGE] Mounting MicroSD over SPI...");

  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  SPI.begin(
    SD_SCK_PIN,
    SD_MISO_PIN,
    SD_MOSI_PIN,
    SD_CS_PIN
  );

  if (!SD.begin(SD_CS_PIN, SPI, SD_SPI_FREQUENCY)) {
    microSdStatus = "No card or mount failed";
    Serial.println("[STORAGE] No MicroSD card detected or mount failed.");
    Serial.println("[STORAGE] Check SD insert, FAT32 format, SPI wiring, and 3.3V power.");
    return false;
  }

  const uint8_t cardType = SD.cardType();

  if (cardType == CARD_NONE) {
    microSdStatus = "No card detected";
    Serial.println("[STORAGE] No MicroSD card detected.");
    return false;
  }

  microSdReady = true;
  useMicroSdStorage = true;
  microSdStatus = String("Ready: ") + microSdCardTypeName(cardType);

  Serial.print("[STORAGE] MicroSD mounted. Type: ");
  Serial.println(microSdCardTypeName(cardType));

  Serial.print("[STORAGE] MicroSD size MB: ");
  Serial.println(
    static_cast<unsigned long>(
      SD.cardSize() / (1024ULL * 1024ULL)
    )
  );

  return true;
}

bool initializeStorage() {
  const bool flashReady =
      initializeLittleFsStorage();

  if (initializeMicroSdStorage()) {
    Serial.println("[STORAGE] Offline queue uses MicroSD.");
    return true;
  }

  if (flashReady) {
    useMicroSdStorage = false;
    Serial.println("[STORAGE] Offline queue uses LittleFS fallback.");

    if (ENABLE_MICROSD && !microSdReady) {
      showMicroSdFallbackNotice();
    }

    return true;
  }

  return false;
}

bool saveRecordOffline(const String& json) {
  File file = storageOpen(
    PENDING_FILE,
    FILE_APPEND
  );

  if (!file) {
    Serial.println(
      "[OFFLINE] Cannot open pending file."
    );

    return false;
  }

  const size_t written =
      file.println(json);

  file.close();

  if (written == 0) {
    Serial.println(
      "[OFFLINE] Failed to write record."
    );

    return false;
  }

  Serial.print("[OFFLINE] Record saved to ");
  Serial.println(offlineStorageName());

  return true;
}

size_t countPendingRecords() {
  if (!storageExists(PENDING_FILE)) {
    return 0;
  }

  File file = storageOpen(
    PENDING_FILE,
    FILE_READ
  );

  if (!file) {
    return 0;
  }

  size_t count = 0;

  while (file.available()) {
    String line =
        file.readStringUntil('\n');

    line.trim();

    if (!line.isEmpty()) {
      count++;
    }
  }

  file.close();

  return count;
}

bool commitTemporaryQueue(bool hasRemainingRecords) {
  storageRemove(BACKUP_FILE);

  if (storageExists(PENDING_FILE)) {
    if (
      !storageRename(
        PENDING_FILE,
        BACKUP_FILE
      )
    ) {
      Serial.println(
        "[SYNC] Cannot create queue backup."
      );

      storageRemove(TEMP_FILE);
      return false;
    }
  }

  if (hasRemainingRecords) {
    if (
      !storageRename(
        TEMP_FILE,
        PENDING_FILE
      )
    ) {
      Serial.println(
        "[SYNC] Cannot activate new queue."
      );

      if (storageExists(BACKUP_FILE)) {
        storageRename(
          BACKUP_FILE,
          PENDING_FILE
        );
      }

      return false;
    }
  } else {
    storageRemove(TEMP_FILE);
  }

  storageRemove(BACKUP_FILE);

  return true;
}

size_t countLinesInFile(const char* filePath) {
  if (!storageExists(filePath)) {
    return 0;
  }

  File file = storageOpen(filePath, FILE_READ);
  if (!file) {
    return 0;
  }

  size_t count = 0;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (!line.isEmpty()) {
      count++;
    }
  }
  file.close();
  return count;
}

size_t countPendingEnrollmentRequests() {
  return countLinesInFile(ENROLL_PENDING_FILE);
}

bool saveEnrollmentRequestOffline(const String& json) {
  File file = storageOpen(ENROLL_PENDING_FILE, FILE_APPEND);

  if (!file) {
    Serial.println("[ENROLL] Cannot open enroll pending file.");
    return false;
  }

  const size_t written = file.println(json);
  file.close();

  if (written == 0) {
    Serial.println("[ENROLL] Failed to save enrollment request.");
    return false;
  }

  Serial.print("[ENROLL] Enrollment request saved to ");
  Serial.println(offlineStorageName());
  return true;
}

bool commitEnrollmentQueue(bool hasRemainingRecords) {
  storageRemove(ENROLL_BACKUP_FILE);

  if (storageExists(ENROLL_PENDING_FILE)) {
    if (!storageRename(ENROLL_PENDING_FILE, ENROLL_BACKUP_FILE)) {
      Serial.println("[ENROLL SYNC] Cannot create enrollment backup.");
      storageRemove(ENROLL_TEMP_FILE);
      return false;
    }
  }

  if (hasRemainingRecords) {
    if (!storageRename(ENROLL_TEMP_FILE, ENROLL_PENDING_FILE)) {
      Serial.println("[ENROLL SYNC] Cannot activate enrollment queue.");

      if (storageExists(ENROLL_BACKUP_FILE)) {
        storageRename(ENROLL_BACKUP_FILE, ENROLL_PENDING_FILE);
      }

      return false;
    }
  } else {
    storageRemove(ENROLL_TEMP_FILE);
  }

  storageRemove(ENROLL_BACKUP_FILE);
  return true;
}

// =====================================================
// WI-FI
// =====================================================

void startWiFiConnection() {
  Serial.println();
  Serial.print("[WIFI] Connecting to 2.4 GHz SSID: ");
  Serial.println(WIFI_SSID);
  Serial.println("[WIFI] Ensure this is the 2.4 GHz network; ESP32-S3 cannot use 5 GHz.");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  lastWiFiAttempt = millis();
}

void waitForInitialWiFi() {
  startWiFiConnection();
  wasWiFiConnected = false;
  deviceState = DeviceState::OFFLINE;
  showOledScreen("OFFLINE MODE", "WiFi connecting", "Attendance Saved", "Syncing Later", "CODE: WIFI-01");
  Serial.println("[WIFI] Connection continues in background; local scanning is ready.");
  Serial.printf("[WIFI] Target server: %s\n", String(SERVER_URL).c_str());
}

void maintainWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasWiFiConnected) {
      wasWiFiConnected = true;
      currentWiFiRetryIntervalMs = WIFI_RETRY_INTERVAL_MS;
      Serial.println("[WIFI] Reconnected.");
      Serial.print("[WIFI] IP: ");
      Serial.println(WiFi.localIP());
      Serial.print("[WIFI] RSSI: ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
      showOledScreen(
        "WIFI RECONNECTED",
        "CHECKING SERVER",
        "",
        "",
        ""
      );
      showReadyFeedback();
    }
    return;
  }

  if (wasWiFiConnected) {
    wasWiFiConnected = false;
    showIdleOled();
  }

  if (
    millis() - lastWiFiAttempt <
    currentWiFiRetryIntervalMs
  ) {
    return;
  }

  Serial.println("[WIFI] Reconnecting...");

  WiFi.disconnect();

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );

  lastWiFiAttempt = millis();
  currentWiFiRetryIntervalMs = min(currentWiFiRetryIntervalMs * 2UL, WIFI_RETRY_MAX_INTERVAL_MS);
  Serial.printf("[WIFI] Next retry in %lu ms.\n", currentWiFiRetryIntervalMs);
}

// =====================================================
// API RESPONSE PARSING
// =====================================================

void parseDeviceDisplay(
    JsonVariantConst source,
    DeviceDisplay& displayData
) {
  if (source.isNull()) {
    return;
  }

  displayData.hasDisplay = true;
  displayData.topStatus =
      String(source["topStatus"] | "");
  displayData.title =
      String(source["title"] | "");
  displayData.line1 =
      String(source["line1"] | "");
  displayData.line2 =
      String(source["line2"] | "");
  displayData.line3 =
      String(source["line3"] | "");
  displayData.color =
      String(source["color"] | "BLUE");
  displayData.beep =
      String(source["beep"] | "NONE");
  displayData.durationMs =
      source["durationMs"] | READY_RESTORE_DELAY_MS;

  if (displayData.title.isEmpty()) {
    displayData.title = "MESSAGE";
  }
}

bool parseApiResponse(
    const String& body,
    ApiResponse& response
) {
  JsonDocument document;

  const DeserializationError error =
      deserializeJson(document, body);

  if (error) {
    Serial.print(
      "[API] JSON parse failed: "
    );

    Serial.println(error.c_str());

    return false;
  }

  response.parsed = true;
  response.code =
      String(document["code"] | "");

  response.message =
      String(document["message"] | "");

  response.duplicateTap =
      document["duplicateTap"] | false;

  JsonVariantConst record =
      document["record"];

  if (!record.isNull()) {
    response.accepted =
        record["accepted"] | false;

    response.fullName =
        String(record["fullName"] | "");

    response.attendanceType =
        String(record["attendanceType"] | "");

    response.displayTime =
        String(record["displayTime"] | "");

    response.punctuality = String(record["punctuality"] | "");
    if (response.punctuality.isEmpty()) {
      response.punctuality = String(record["attendanceStatus"] | "");
    }
    if (response.punctuality.isEmpty()) {
      response.punctuality = String(record["timeStatus"] | "");
    }

    if (!record["lateMinutes"].isNull()) {
      response.lateMinutes = record["lateMinutes"] | 0;
      response.hasLateMinutes = true;
    } else if (!record["minutesLate"].isNull()) {
      response.lateMinutes = record["minutesLate"] | 0;
      response.hasLateMinutes = true;
    }

    response.remainingMinutes =
        record["remainingMinutes"] | 0;
    response.paidHours =
        record["paidHours"] | 0.0;
  } else {
    response.accepted =
        document["accepted"] | false;

    response.fullName =
        String(document["fullName"] | "");

    response.attendanceType =
        String(document["attendanceType"] | "");

    response.displayTime =
        String(document["displayTime"] | "");

    response.punctuality = String(document["punctuality"] | "");
    if (response.punctuality.isEmpty()) {
      response.punctuality = String(document["attendanceStatus"] | "");
    }
    if (response.punctuality.isEmpty()) {
      response.punctuality = String(document["timeStatus"] | "");
    }

    if (!document["lateMinutes"].isNull()) {
      response.lateMinutes = document["lateMinutes"] | 0;
      response.hasLateMinutes = true;
    } else if (!document["minutesLate"].isNull()) {
      response.lateMinutes = document["minutesLate"] | 0;
      response.hasLateMinutes = true;
    }

    response.remainingMinutes =
        document["remainingMinutes"] | 0;
    response.paidHours =
        document["paidHours"] | 0.0;
  }

  JsonVariantConst displayNode =
      document["deviceDisplay"];

  if (displayNode.isNull() && !record.isNull()) {
    displayNode = record["deviceDisplay"];
  }

  parseDeviceDisplay(
    displayNode,
    response.deviceDisplay
  );

  if (response.duplicateTap) {
    response.code = "DUPLICATE_SCAN";
  } else if (response.code.isEmpty()) {
    if (response.attendanceType == "TIME_IN") {
      response.code =
          "TIME_IN_RECORDED";
    } else if (response.attendanceType == "TIME_OUT") {
      response.code =
          "TIME_OUT_RECORDED";
    } else if (response.accepted) {
      response.code =
          "SCAN_ACCEPTED";
    } else {
      response.code =
          "SCAN_REJECTED";
    }
  }

  return true;
}

bool beginDeviceHttp(
    HTTPClient& http,
    WiFiClient& plainClient,
    WiFiClientSecure& secureClient,
    const String& url
) {
  if (url.startsWith("https://")) {
    secureClient.setInsecure();
    return http.begin(secureClient, url);
  }
  return http.begin(plainClient, url);
}

void selectActiveServer(const String& scanApiUrl, bool localServer) {
  activeApiUrl = scanApiUrl;
  activeServerIsLocal = localServer;
  serverReachable = true;
  Serial.print("[SERVER] Active route: ");
  Serial.println(localServer ? "LOCAL LAN" : "RENDER CLOUD");
}

bool sendScanToEndpoint(
    const String& scanApiUrl,
    const String& json,
    ApiResponse& response
) {
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(API_HTTP_TIMEOUT_MS);
  if (!beginDeviceHttp(http, plainClient, secureClient, scanApiUrl)) return false;

  http.addHeader(
    "Content-Type",
    "application/json"
  );

  http.addHeader(
    "X-API-Key",
    API_KEY
  );
  http.addHeader("X-Device-ID", DEVICE_ID);

  showLiveScanStage(
    "RECORDING",
    "SENDING TO SERVER",
    "PLEASE WAIT",
    ""
  );
  setRgb(false, true, true);    // external RGB: cyan = sending/server work
  r503CyanBreathing();

  Serial.println("[API] Sending fingerprint scan...");
  Serial.println(json);

  const int statusCode =
      http.POST(json);

  String responseBody = "";

  if (statusCode > 0) {
    responseBody = http.getString();
  }

  http.end();

  Serial.print("[API] HTTP status: ");
  Serial.println(statusCode);

  lastServerStatusCode = statusCode;

  if (!responseBody.isEmpty()) {
    Serial.print("[API] Response: ");
    Serial.println(responseBody);
  }

  if (
    statusCode < 200 ||
    statusCode >= 300
  ) {
    return false;
  }

  if (!responseBody.isEmpty()) {
    parseApiResponse(
      responseBody,
      response
    );
  }

  return true;
}

bool checkServerHealth() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[HEALTH] WiFi not connected.");
    return false;
  }

  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(HEARTBEAT_HTTP_TIMEOUT_MS);

  String healthUrl = String(SERVER_URL) + "/api/health";
  if (!beginDeviceHttp(http, plainClient, secureClient, healthUrl)) {
    Serial.println("[HEALTH] HTTP init failed.");
    return false;
  }

  int statusCode = http.GET();
  String responseBody = "";
  if (statusCode > 0) {
    responseBody = http.getString();
  }
  http.end();

  Serial.print("[HEALTH] Status: ");
  Serial.println(statusCode);
  if (!responseBody.isEmpty()) {
    Serial.print("[HEALTH] Response: ");
    Serial.println(responseBody);
  }

  return statusCode == 200;
}

bool sendScanToServer(const String& json, ApiResponse& response) {
  if (WiFi.status() != WL_CONNECTED) {
    serverReachable = false;
    lastServerStatusCode = 0;
    return false;
  }

  Serial.println("[API] Trying local attendance server first...");
  for (int attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      Serial.printf("[API] Local retry %d/2...\n", attempt);
      delay(1000);
    }
    if (sendScanToEndpoint(String(SERVER_URL) + "/api/attendance/scan", json, response)) {
      if (millis() - lastLocalServerProbeAt >= LOCAL_SERVER_PROBE_INTERVAL_MS) {
        lastLocalServerProbeAt = millis();
      }
      selectActiveServer(String(SERVER_URL) + "/api/attendance/scan", true);
      return true;
    }
  }

  Serial.println("[API] Local unavailable; trying Render cloud...");
  for (int attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      Serial.printf("[API] Cloud retry %d/2...\n", attempt);
      delay(1000);
    }
    if (sendScanToEndpoint(String(CLOUD_API_URL), json, response)) {
      selectActiveServer(String(CLOUD_API_URL), false);
      return true;
    }
  }

  serverReachable = false;
  return false;
}

String apiBaseUrl() {
  String url = activeApiUrl;
  const int apiPathIndex =
      url.indexOf("/api/");

  if (apiPathIndex >= 0) {
    url.remove(apiPathIndex);
  }

  return url;
}

String heartbeatUrl() {
  return apiBaseUrl() + "/api/readers/heartbeat";
}

String displayCommandUrl() {
  return apiBaseUrl()
      + "/api/devices/display-command?deviceId="
      + String(DEVICE_ID);
}

String displayCommandAckUrl() {
  return apiBaseUrl() + "/api/devices/display-command/ack";
}

String enrollmentRequestUrl() {
  // Server/frontend should listen to this endpoint and show a registration modal.
  return apiBaseUrl() + "/api/fingerprints/enrollment-request";
}

String fingerprintScanStatusUrl() {
  return apiBaseUrl() + "/api/fingerprints/scan-status";
}

void sendFingerprintScanStatus(const String& status) {
  if (WiFi.status() != WL_CONNECTED || !serverReachable) return;
  JsonDocument document;
  document["deviceId"] = DEVICE_ID;
  document["status"] = status;
  String json;
  serializeJson(document, json);
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(API_HTTP_TIMEOUT_MS);
  if (!beginDeviceHttp(http, plainClient, secureClient, fingerprintScanStatusUrl())) return;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", DEVICE_ID);
  http.POST(json);
  http.end();
}

bool sendEnrollmentRequestToServer(
    const String& json,
    DeviceDisplay* responseDisplay = nullptr
) {
  if (WiFi.status() != WL_CONNECTED) {
    serverReachable = false;
    lastServerStatusCode = 0;
    return false;
  }

  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(API_HTTP_TIMEOUT_MS);

  if (!beginDeviceHttp(http, plainClient, secureClient, enrollmentRequestUrl())) {
    Serial.println("[ENROLL API] HTTP initialization failed.");
    serverReachable = false;
    lastServerStatusCode = 0;
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", DEVICE_ID);

  showOledStatus(
    "FINGERPRINT SAVED",
    "NOTIFYING SERVER",
    "OPEN SERVER",
    "PLEASE WAIT"
  );
  setRgb(false, true, true);
  r503CyanBreathing();

  Serial.println("[ENROLL API] Sending enrollment request...");
  Serial.println(json);

  const int statusCode = http.POST(json);
  String responseBody = "";

  if (statusCode > 0) {
    responseBody = http.getString();
  }

  http.end();

  lastServerStatusCode = statusCode;
  Serial.print("[ENROLL API] HTTP status: ");
  Serial.println(statusCode);

  if (!responseBody.isEmpty()) {
    Serial.print("[ENROLL API] Response: ");
    Serial.println(responseBody);
  }

  if (statusCode < 200 || statusCode >= 300) {
    serverReachable = false;
    return false;
  }

  serverReachable = true;

  if (responseDisplay != nullptr && !responseBody.isEmpty()) {
    JsonDocument document;
    const DeserializationError error =
        deserializeJson(document, responseBody);

    if (!error) {
      parseDeviceDisplay(
        document["deviceDisplay"],
        *responseDisplay
      );
    }
  }

  return true;
}

void applyAttendanceCloseStatusFromServer(JsonVariantConst source) {
  if (source.isNull()) {
    resetIdleCloseStatus();
    return;
  }

  const bool active =
      source["active"] | false;

  idleCloseStatusActive = active;
  if (active) {
    idleCloseStatusColor =
        displayChoice(String(source["color"] | "BLUE"));
  } else {
    idleCloseStatusColor = "BLUE";
  }

  idleCloseStatusCode =
      String(source["code"] | "WORK_HOURS");
  idleOpenTimeOutCount =
      source["openTimeOutCount"] | 0;

  Serial.print("[CLOSE STATUS] ");
  Serial.print(idleCloseStatusCode);
  Serial.print(" color=");
  Serial.print(idleCloseStatusColor);
  Serial.print(" pendingOut=");
  Serial.println(idleOpenTimeOutCount);
}

void parseHeartbeatResponse(const String& responseBody) {
  if (responseBody.isEmpty()) {
    resetIdleCloseStatus();
    return;
  }

  JsonDocument document;
  const DeserializationError error =
      deserializeJson(document, responseBody);

  if (error) {
    Serial.print("[API] Heartbeat JSON parse failed: ");
    Serial.println(error.c_str());
    resetIdleCloseStatus();
    return;
  }

  applyAttendanceCloseStatusFromServer(
    document["attendanceCloseStatus"]
  );
}

void sendReaderHeartbeat() {
  if (WiFi.status() != WL_CONNECTED) {
    serverReachable = false;
    lastServerStatusCode = 0;
    resetIdleCloseStatus();
    return;
  }

  JsonDocument document;
  document["deviceId"] = DEVICE_ID;
  document["source"] = "ESP32-S3";
  document["location"] = DEVICE_LOCATION;
  document["firmwareVersion"] = FIRMWARE_VERSION;
  document["identityMode"] = "FINGERPRINT_ONLY";
  document["deviceIp"] =
      WiFi.localIP().toString();
  document["wifiRssi"] = WiFi.RSSI();
  document["pendingOfflineLogs"] =
      countPendingRecords()
      + countPendingEnrollmentRequests();
  JsonObject capabilities =
      document["capabilities"].to<JsonObject>();
  capabilities["fingerprintR503"] = fingerprintReady;
  capabilities["oledSH1106"] = ENABLE_OLED && oledReady;
  capabilities["rtcDS3231"] = rtcReady;
  capabilities["microSd"] = ENABLE_MICROSD && microSdReady;
  capabilities["offlineStorage"] = true;
  capabilities["rgbLed"] = ENABLE_RGB_LED;
  capabilities["buzzer"] = ENABLE_BUZZER;

  String json;
  serializeJson(document, json);

  bool sent = false;
  int statusCode = 0;

  activeApiUrl = String(SERVER_URL) + "/api/attendance/scan";
  activeServerIsLocal = true;
  for (int attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) {
      Serial.printf("[HEARTBEAT] Local retry %d/2...\n", attempt);
      delay(1000);
    }
    WiFiClient plainClient;
    WiFiClientSecure secureClient;
    HTTPClient http;
    http.setTimeout(HEARTBEAT_HTTP_TIMEOUT_MS);
    if (!beginDeviceHttp(http, plainClient, secureClient, heartbeatUrl())) {
      Serial.println("[HEARTBEAT] Local HTTP init failed.");
      continue;
    }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-API-Key", API_KEY);
    http.addHeader("X-Device-ID", DEVICE_ID);
    statusCode = http.POST(json);
    String responseBody = statusCode > 0 ? http.getString() : "";
    http.end();
    lastServerStatusCode = statusCode;
    Serial.print("[HEARTBEAT] Local status: ");
    Serial.println(statusCode);
    if (statusCode >= 200 && statusCode < 300) {
      serverReachable = true;
      selectActiveServer(activeApiUrl, true);
      parseHeartbeatResponse(responseBody);
      sent = true;
      lastLocalServerProbeAt = millis();
      break;
    }
  }

  if (!sent) {
    for (int attempt = 1; attempt <= 2; attempt++) {
      if (attempt > 1) {
        Serial.printf("[HEARTBEAT] Cloud retry %d/2...\n", attempt);
        delay(1000);
      }
      activeApiUrl = String(CLOUD_API_URL);
      activeServerIsLocal = false;
      WiFiClient plainClient;
      WiFiClientSecure secureClient;
      HTTPClient http;
      http.setTimeout(HEARTBEAT_HTTP_TIMEOUT_MS);
      if (!beginDeviceHttp(http, plainClient, secureClient, heartbeatUrl())) {
        Serial.println("[HEARTBEAT] Cloud HTTP init failed.");
        continue;
      }
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-API-Key", API_KEY);
      http.addHeader("X-Device-ID", DEVICE_ID);
      statusCode = http.POST(json);
      String responseBody = statusCode > 0 ? http.getString() : "";
      http.end();
      lastServerStatusCode = statusCode;
      Serial.print("[HEARTBEAT] Cloud status: ");
      Serial.println(statusCode);
      if (statusCode >= 200 && statusCode < 300) {
        serverReachable = true;
        selectActiveServer(activeApiUrl, false);
        parseHeartbeatResponse(responseBody);
        sent = true;
        break;
      }
    }
  }

  if (!sent) {
    serverReachable = false;
    lastServerStatusCode = statusCode;
    resetIdleCloseStatus();
  }

  if (!feedbackActive) {
    applyIdleReadyColor();
    showIdleOled();
  }
}

void acknowledgeDisplayCommand(
    const String& commandId,
    const String& command,
    const String& status,
    const String& message,
    uint16_t fingerprintId = 0
) {
  if (
    commandId.isEmpty() ||
    WiFi.status() != WL_CONNECTED
  ) {
    return;
  }

  JsonDocument document;
  document["commandId"] = commandId;
  document["command"] = command;
  document["deviceId"] = DEVICE_ID;
  document["status"] = status;
  document["message"] = message;
  document["firmwareVersion"] = FIRMWARE_VERSION;

  if (fingerprintId > 0) {
    document["fingerprintId"] = fingerprintId;
  }

  String json;
  serializeJson(document, json);

  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(API_HTTP_TIMEOUT_MS);

  if (!beginDeviceHttp(http, plainClient, secureClient, displayCommandAckUrl())) {
    Serial.println("[COMMAND] ACK HTTP init failed.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", DEVICE_ID);

  const int statusCode = http.POST(json);
  http.end();

  Serial.print("[COMMAND] ACK status: ");
  Serial.println(statusCode);
}

void pollDisplayCommand() {
  if (
    WiFi.status() != WL_CONNECTED ||
    !serverReachable ||
    feedbackActive ||
    syncInProgress
  ) {
    return;
  }

  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(API_HTTP_TIMEOUT_MS);

  if (!beginDeviceHttp(http, plainClient, secureClient, displayCommandUrl())) {
    Serial.println("[COMMAND] Display command HTTP init failed.");
    return;
  }

  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", DEVICE_ID);

  const int statusCode = http.GET();
  String responseBody = "";

  if (statusCode > 0) {
    responseBody = http.getString();
  }

  http.end();

  if (statusCode < 200 || statusCode >= 300 || responseBody.isEmpty()) {
    return;
  }

  JsonDocument document;
  const DeserializationError error =
      deserializeJson(document, responseBody);

  if (error) {
    Serial.print("[COMMAND] JSON parse failed: ");
    Serial.println(error.c_str());
    return;
  }

  const bool hasCommand =
      document["hasCommand"] | false;

  if (!hasCommand) {
    return;
  }

  const String command =
      String(document["command"] | "SHOW_MESSAGE");

  const String commandId =
      String(document["commandId"] | "");

  DeviceDisplay displayData;
  parseDeviceDisplay(
    document["deviceDisplay"],
    displayData
  );

  if (displayData.hasDisplay) {
    showDeviceDisplay(displayData);
  }

  Serial.print("[COMMAND] Received: ");
  Serial.println(command);

  if (command == "START_ENROLLMENT") {
    delay(800);
    const int id = firstAvailableFingerprintId();

    if (id < 1) {
      showErrorFeedback("R503 memory is full.");
      acknowledgeDisplayCommand(
        commandId,
        command,
        "ERROR",
        "R503 memory is full"
      );
      return;
    }

    const uint8_t enrollStatus = enrollFingerprint(id);
    acknowledgeDisplayCommand(
      commandId,
      command,
      enrollStatus == FINGERPRINT_OK ? "OK" : "ERROR",
      enrollStatus == FINGERPRINT_OK ? "Enrollment completed" : "Enrollment failed",
      id
    );
    return;
  }

  if (command == "DELETE_FINGERPRINT") {
    uint16_t targetId =
        document["fingerprintId"] | 0;

    if (
      targetId == 0 &&
      !document["payload"].isNull()
    ) {
      targetId =
          document["payload"]["fingerprintId"] | 0;
    }

    if (targetId < 1 || targetId > 1000) {
      showErrorFeedback("Invalid delete ID.");
      acknowledgeDisplayCommand(
        commandId,
        command,
        "ERROR",
        "Invalid fingerprint ID"
      );
      return;
    }

    const bool deleted =
        deleteFingerprint(targetId);

    acknowledgeDisplayCommand(
      commandId,
      command,
      deleted ? "OK" : "ERROR",
      deleted ? "Fingerprint deleted" : "Delete failed",
      targetId
    );
    return;
  }

  acknowledgeDisplayCommand(
    commandId,
    command,
    "OK",
    "Command displayed"
  );
}

// =====================================================
// UI-ALIGNED FEEDBACK
// =====================================================

String displayNameOrNeedRegister(const ApiResponse& response) {
  String name = response.fullName;
  name.trim();

  if (name.isEmpty()) {
    return "NOT REGISTERED";
  }

  return name;
}

String uppercaseCopy(String value) {
  value.trim();
  value.toUpperCase();
  return value;
}

String attendanceRemarkLine(const ApiResponse& response) {
  String status = uppercaseCopy(response.punctuality);

  if (status == "ON_TIME" || status == "ON TIME" || status == "ONTIME") {
    return "ON TIME";
  }

  if (status == "LATE") {
    if (response.hasLateMinutes && response.lateMinutes > 0) {
      return String("LATE ") + String(response.lateMinutes) + " MIN";
    }
    return "LATE";
  }

  if (status == "EARLY") {
    return "EARLY";
  }

  if (!status.isEmpty()) {
    return status;
  }

  return "";
}

void showApiFeedback(
    const ApiResponse& response,
    const DateTime& scanTime
) {
  deviceState = response.accepted ? DeviceState::SUCCESS : DeviceState::ERROR;
  if (response.deviceDisplay.hasDisplay) {
    showDeviceDisplay(response.deviceDisplay);
    return;
  }

  String displayTime =
      response.displayTime;

  if (displayTime.isEmpty()) {
    displayTime =
        formatDisplayTime(scanTime);
  }

  const String code =
      response.code;

  const String employeeName =
      displayNameOrNeedRegister(response);

  const String remark =
      attendanceRemarkLine(response);

  if (
    code == "TIME_IN_RECORDED" ||
    code == "TIME_IN"
  ) {
    setRgb(false, true, false);
    r503GreenFlash();
    beepTimeIn();
    beginFeedback();

    showLiveScanStage(
      "TIME IN RECORDED",
      employeeName,
      displayTime,
      remark
    );

    Serial.println("[DISPLAY] TIME IN RECORDED!");
    Serial.print("[DISPLAY] Employee: ");
    Serial.println(employeeName);
    Serial.print("[DISPLAY] Time: ");
    Serial.println(displayTime);
    return;
  }

  if (
    code == "TIME_OUT_RECORDED" ||
    code == "TIME_OUT"
  ) {
    setRgb(false, false, true);
    r503BlueFlash();
    beepTimeOut();
    beginFeedback();

    showLiveScanStage(
      "TIME OUT RECORDED",
      employeeName,
      displayTime,
      remark
    );

    Serial.println("[DISPLAY] TIME OUT RECORDED!");
    Serial.print("[DISPLAY] Employee: ");
    Serial.println(employeeName);
    Serial.print("[DISPLAY] Time: ");
    Serial.println(displayTime);
    return;
  }

  if (
    code == "DUPLICATE_SCAN" ||
    code == "ALREADY_TIMED_IN"
  ) {
    setRgb(true, true, false);
    r503YellowFlash();
    buzzerTone(950, 100);
    beginFeedback();

    showLiveScanStage(
      "ALREADY RECORDED",
      employeeName,
      displayTime,
      remark
    );

    Serial.println("[DISPLAY] ALREADY RECORDED");
    if (!response.message.isEmpty()) {
      Serial.println(response.message);
    }
    return;
  }

  if (
    code == "FINGERPRINT_NOT_REGISTERED" ||
    code == "FINGERPRINT_NOT_LINKED"
  ) {
    setRgb(true, false, false);
    r503RedFlash();
    beepError();
    beginFeedback();

    showLiveScanStage(
      "NOT REGISTERED",
      "LINK FINGERPRINT",
      "ON SERVER",
      ""
    );

    Serial.println("[DISPLAY] NOT REGISTERED - fingerprint not linked to employee.");
    return;
  }

  if (code == "FINGERPRINT_MISMATCH") {
    showErrorFeedback(
      response.message.isEmpty()
        ? "Fingerprint mismatch."
        : response.message
    );
    return;
  }

  if (
    code == "TIME_OUT_NOT_ALLOWED" ||
    code == "TOO_EARLY_FOR_TIME_OUT"
  ) {
    setRgb(true, false, false);
    r503RedFlash();
    beepError();
    beginFeedback(5000);

    showLiveScanStage(
      "TIME OUT DENIED",
      "COMPLETE 8 HOURS",
      response.remainingMinutes > 0
        ? String("REMAINING: ") + String(response.remainingMinutes) + " MIN"
        : "Required hours",
      ""
    );
    return;
  }

  if (code == "INACTIVE_CARD") {
    showErrorFeedback(
      "Employee is inactive."
    );
    return;
  }

  if (response.accepted) {
    setRgb(false, true, false);
    r503GreenFlash();
    beepFingerprintAccepted();
    beginFeedback();

    showLiveScanStage(
      "RECORDED",
      employeeName,
      displayTime,
      remark
    );

    Serial.println("[DISPLAY] SCAN ACCEPTED");
  } else {
    showErrorFeedback(
      response.message.isEmpty()
        ? "Scan rejected by server."
        : response.message
    );
  }
}

// =====================================================
// OFFLINE AUTO-SYNC
// =====================================================

void synchronizePendingRecords() {
  if (
    WiFi.status() != WL_CONNECTED ||
    !serverReachable
  ) {
    return;
  }

  if (!storageExists(PENDING_FILE)) {
    return;
  }

  const size_t pendingBefore =
      countPendingRecords();

  if (pendingBefore == 0) {
    storageRemove(PENDING_FILE);
    return;
  }

  syncInProgress = true;
  deviceState = DeviceState::SYNCING;

  setRgb(false, true, true);
  r503CyanFlash();

  showOledScreen(
    "ONLINE CONNECTED",
    "SYNCING OFFLINE LOGS",
    String("Pending logs: ") + String(pendingBefore),
    "",
    ""
  );

  Serial.print("[SYNC] Pending records: ");
  Serial.println(pendingBefore);

  File input = storageOpen(
    PENDING_FILE,
    FILE_READ
  );

  File temporary = storageOpen(
    TEMP_FILE,
    FILE_WRITE
  );

  if (!input || !temporary) {
    Serial.println(
      "[SYNC] Cannot open queue files."
    );

    if (input) {
      input.close();
    }

    if (temporary) {
      temporary.close();
    }

    syncInProgress = false;
    showReadyFeedback();
    return;
  }

  uint8_t attempted = 0;
  size_t sent = 0;
  size_t remaining = 0;

  while (input.available()) {
    String line =
        input.readStringUntil('\n');

    line.trim();

    if (line.isEmpty()) {
      continue;
    }

    const bool shouldAttempt =
        attempted < MAX_SYNC_PER_PASS;

    if (shouldAttempt) {
      attempted++;

      ApiResponse ignoredResponse;

      if (
        sendScanToServer(
          line,
          ignoredResponse
        )
      ) {
        sent++;
        delay(100);
        continue;
      }
    }

    temporary.println(line);
    remaining++;
  }

  input.close();
  temporary.close();

  const bool committed =
      commitTemporaryQueue(
        remaining > 0
      );

  if (!committed) {
    Serial.println(
      "[SYNC] Queue update failed."
    );

    syncInProgress = false;
    showErrorFeedback(
      "Offline queue update failed."
    );

    return;
  }

  Serial.print("[SYNC] Uploaded: ");
  Serial.println(sent);

  Serial.print("[SYNC] Still pending: ");
  Serial.println(remaining);

  syncInProgress = false;
  lastConnectionTitle = connectionStatusTitle();

  if (sent > 0) {
    DeviceDisplay displayData;
    displayData.hasDisplay = true;
    displayData.topStatus = "ONLINE CONNECTED";
    displayData.title = "SYNC COMPLETE";
    displayData.line1 = String("Uploaded: ") + String(sent);
    displayData.line2 = String("Pending logs: ") + String(remaining);
    displayData.color = remaining > 0 ? "YELLOW" : "GREEN";
    displayData.beep = "NOTICE";
    displayData.durationMs = 3000;
    showDeviceDisplay(displayData);
  } else {
    showReadyFeedback();
  }
}


void synchronizePendingEnrollmentRequests() {
  if (
    WiFi.status() != WL_CONNECTED ||
    !serverReachable
  ) {
    return;
  }

  if (!storageExists(ENROLL_PENDING_FILE)) {
    return;
  }

  const size_t pendingBefore = countPendingEnrollmentRequests();

  if (pendingBefore == 0) {
    storageRemove(ENROLL_PENDING_FILE);
    return;
  }

  syncInProgress = true;
  deviceState = DeviceState::SYNCING;

  setRgb(false, true, true);
  r503CyanFlash();

  showOledScreen(
    "ONLINE CONNECTED",
    "SYNCING OFFLINE LOGS",
    String("Pending enroll: ") + String(pendingBefore),
    "Sending IDs",
    ""
  );

  Serial.print("[ENROLL SYNC] Pending requests: ");
  Serial.println(pendingBefore);

  File input = storageOpen(ENROLL_PENDING_FILE, FILE_READ);
  File temporary = storageOpen(ENROLL_TEMP_FILE, FILE_WRITE);

  if (!input || !temporary) {
    Serial.println("[ENROLL SYNC] Cannot open queue files.");

    if (input) {
      input.close();
    }

    if (temporary) {
      temporary.close();
    }

    syncInProgress = false;
    showReadyFeedback();
    return;
  }

  uint8_t attempted = 0;
  size_t sent = 0;
  size_t remaining = 0;

  while (input.available()) {
    String line = input.readStringUntil('\n');
    line.trim();

    if (line.isEmpty()) {
      continue;
    }

    const bool shouldAttempt = attempted < MAX_SYNC_PER_PASS;

    if (shouldAttempt) {
      attempted++;

      if (sendEnrollmentRequestToServer(line)) {
        sent++;
        delay(100);
        continue;
      }
    }

    temporary.println(line);
    remaining++;
  }

  input.close();
  temporary.close();

  const bool committed = commitEnrollmentQueue(remaining > 0);

  if (!committed) {
    Serial.println("[ENROLL SYNC] Queue update failed.");
    syncInProgress = false;
    showErrorFeedback("Enroll queue update failed.");
    return;
  }

  Serial.print("[ENROLL SYNC] Uploaded: ");
  Serial.println(sent);

  Serial.print("[ENROLL SYNC] Still pending: ");
  Serial.println(remaining);

  syncInProgress = false;
  lastConnectionTitle = connectionStatusTitle();

  if (sent > 0) {
    DeviceDisplay displayData;
    displayData.hasDisplay = true;
    displayData.topStatus = "ONLINE CONNECTED";
    displayData.title = "SYNC COMPLETE";
    displayData.line1 = String("Enroll IDs: ") + String(sent);
    displayData.line2 = String("Pending logs: ") + String(remaining);
    displayData.color = remaining > 0 ? "YELLOW" : "GREEN";
    displayData.beep = "NOTICE";
    displayData.durationMs = 3000;
    showDeviceDisplay(displayData);
  } else {
    showReadyFeedback();
  }
}

// =====================================================
// FINGERPRINT HANDLING
// =====================================================

bool isDuplicateFingerprint(uint16_t fingerprintId) {
  const unsigned long currentTime =
      millis();

  if (
    fingerprintId == lastFingerprintId &&
    currentTime - lastFingerprintReadTime <
      DUPLICATE_FINGER_DELAY_MS
  ) {
    return true;
  }

  lastFingerprintId = fingerprintId;
  lastFingerprintReadTime = currentTime;

  return false;
}

void waitForFingerRemove() {
  const unsigned long startedAt = millis();

  while (
    millis() - startedAt <
    FINGER_REMOVE_TIMEOUT_MS
  ) {
    const uint8_t status =
        finger.getImage();

    if (status == FINGERPRINT_NOFINGER) {
      return;
    }

    delay(100);
  }
}

bool readFingerprintMatch(
    uint16_t& fingerprintId,
    uint16_t& confidence
) {
  const uint8_t imageStatus =
      finger.getImage();

  if (imageStatus == FINGERPRINT_NOFINGER) {
    return false;
  }

  wakeOled(true);
  deviceState = DeviceState::SCANNING;
  if (imageStatus == FINGERPRINT_PACKETRECIEVEERR) {
    fingerprintCommunicationErrors++;
    Serial.println("[R503] UART communication timeout (FP-02).");
    if (fingerprintCommunicationErrors >= FINGERPRINT_RECOVERY_LIMIT) {
      fingerprintReady = false;
      fingerprintRecoveryAttempts = 0;
      showSystemError("Fingerprint Sensor", "Communication Timeout", "FP-02");
    }
    return false;
  }
  fingerprintCommunicationErrors = 0;

  sendFingerprintScanStatus("FINGER_DETECTED");

  showLiveScanStage(
    "FINGER DETECTED",
    "CAPTURING",
    "KEEP STEADY",
    ""
  );
  setRgb(true, false, true);    // external RGB: purple = finger detected
  r503PurpleOn();

  if (imageStatus != FINGERPRINT_OK) {
    sendFingerprintScanStatus("FAILED");
    showErrorFeedback(
      "Image capture failed."
    );
    waitForFingerRemove();
    return false;
  }

  showLiveScanStage(
    "IMAGE CAPTURED",
    "READING PRINT",
    "DO NOT REMOVE",
    ""
  );
  setRgb(false, false, true);   // external RGB: blue = captured OK
  sendFingerprintScanStatus("IMAGE_CAPTURED");
  r503BlueOn();
  delay(120);

  uint8_t status =
      finger.image2Tz();

  if (status != FINGERPRINT_OK) {
    sendFingerprintScanStatus("FAILED");
    showErrorFeedback(
      "Fingerprint image unclear."
    );
    waitForFingerRemove();
    return false;
  }

  showLiveScanStage(
    "MATCHING",
    "CHECKING R503",
    "PLEASE WAIT",
    ""
  );
  setRgb(true, false, true);    // external RGB: purple = matching
  sendFingerprintScanStatus("MATCHING");
  r503PurpleBreathing();
  delay(120);

  status =
      finger.fingerSearch();

  if (status != FINGERPRINT_OK) {
    sendFingerprintScanStatus("FAILED");
    showLiveScanStage(
      "NOT REGISTERED",
      "LINK FINGERPRINT",
      "ON SERVER",
      ""
    );
    setRgb(true, false, false);  // external RGB: red = not enrolled
    r503RedFlash();
    beepError();
    beginFeedback();
    waitForFingerRemove();
    return false;
  }

  fingerprintId =
      finger.fingerID;
  confidence =
      finger.confidence;

  showLiveScanStage(
    "MATCH CONFIRMED",
    "RECORDING",
    String("Conf: ") + String(confidence),
    ""
  );
  setRgb(false, true, false);   // external RGB: green = local match OK
  r503GreenFlash();
  beepFingerprintAccepted();
  sendFingerprintScanStatus("VERIFIED");

  Serial.print("[R503] Match ID: ");
  Serial.println(fingerprintId);

  Serial.print("[R503] Confidence: ");
  Serial.println(confidence);

  waitForFingerRemove();
  return true;
}

void processFingerprint(
    uint16_t fingerprintId,
    uint16_t confidence
) {
  if (isDuplicateFingerprint(fingerprintId)) {
    Serial.println(
      "[R503] Same finger repeated. Ignored."
    );

    return;
  }

  const DateTime currentTime =
      rtc.now();

  const String scanJson =
      createFingerprintJson(
        fingerprintId,
        confidence,
        currentTime
      );

  Serial.println();
  Serial.println(
    "================================"
  );

  Serial.print("[R503] Fingerprint ID: ");
  Serial.println(fingerprintId);

  Serial.print("[RTC] Scan time: ");
  Serial.println(
    formatTimestamp(currentTime)
  );

  if (WiFi.status() == WL_CONNECTED) {
    showLiveScanStage(
      "RECORDING",
      "MATCH CONFIRMED",
      "SENDING TO API",
      ""
    );
    setRgb(false, true, true);  // external RGB: cyan = API processing
    r503CyanBreathing();

    ApiResponse response;

    const bool delivered =
        sendScanToServer(
          scanJson,
          response
        );

    if (delivered) {
      if (response.parsed) {
        showApiFeedback(
          response,
          currentTime
        );
      } else {
        setRgb(false, true, false);
        r503GreenFlash();
        beepFingerprintAccepted();
        beginFeedback();

        showLiveScanStage(
          "RECORDED",
          "SERVER RECEIVED",
          "AWAITING DATA",
          formatDisplayTime(currentTime)
        );

        Serial.println(
          "[DISPLAY] SCAN SAVED ON SERVER"
        );
      }

      Serial.println(
        "================================"
      );

      return;
    }
  }

  showLiveScanStage(
    "SERVER OFFLINE",
    "SAVING LOG",
    "PENDING SYNC",
    ""
  );
  setRgb(true, true, false);    // external RGB: yellow = offline/pending
  r503YellowFlash();

  const bool offlineSaved =
      saveRecordOffline(scanJson);

  if (offlineSaved) {
    showOfflineFeedback();
  } else {
    showErrorFeedback(
      "Attendance was not saved."
    );
  }

  Serial.println(
    "================================"
  );
}


// =====================================================
// TESTING LOG TOOLS
// =====================================================

void printOfflineLogStatus() {
  const size_t attendancePending = countPendingRecords();
  const size_t enrollPending = countPendingEnrollmentRequests();

  Serial.print("[LOGS] Pending attendance records: ");
  Serial.println(attendancePending);
  Serial.print("[LOGS] Pending enrollment requests: ");
  Serial.println(enrollPending);
  Serial.print("[LOGS] Active offline storage: ");
  Serial.println(offlineStorageName());

  if (storageExists(PENDING_FILE)) {
    Serial.print("[LOGS] Attendance pending file size: ");
    File file = storageOpen(PENDING_FILE, FILE_READ);
    if (file) {
      Serial.println(file.size());
      file.close();
    } else {
      Serial.println("cannot open");
    }
  } else {
    Serial.println("[LOGS] No attendance pending file.");
  }

  if (storageExists(ENROLL_PENDING_FILE)) {
    Serial.print("[LOGS] Enrollment pending file size: ");
    File file = storageOpen(ENROLL_PENDING_FILE, FILE_READ);
    if (file) {
      Serial.println(file.size());
      file.close();
    } else {
      Serial.println("cannot open");
    }
  } else {
    Serial.println("[LOGS] No enrollment pending file.");
  }
}

void clearOfflineLogs() {
  const size_t attendanceBefore = countPendingRecords();
  const size_t enrollBefore = countPendingEnrollmentRequests();
  const size_t totalBefore = attendanceBefore + enrollBefore;

  bool removedSomething = false;

  const char* filesToRemove[] = {
    PENDING_FILE,
    TEMP_FILE,
    BACKUP_FILE,
    ENROLL_PENDING_FILE,
    ENROLL_TEMP_FILE,
    ENROLL_BACKUP_FILE
  };

  for (const char* filePath : filesToRemove) {
    if (storageExists(filePath)) {
      storageRemove(filePath);
      removedSomething = true;
    }
  }

  Serial.println();
  Serial.println("[LOGS] Offline logs cleared for testing.");
  Serial.print("[LOGS] Attendance records removed: ");
  Serial.println(attendanceBefore);
  Serial.print("[LOGS] Enrollment requests removed: ");
  Serial.println(enrollBefore);

  showOledStatus(
    "LOGS CLEARED",
    String("Removed: ") + String(totalBefore),
    removedSomething ? "All queues reset" : "No logs to delete",
    "Fingerprints not deleted"
  );

  setRgb(false, true, false);
  r503GreenFlash();
  beepFingerprintAccepted();
  beginFeedback();
}


void handleSuccessfulEnrollment(uint16_t id) {
  const DateTime enrolledAt = rtc.now();
  const String json = createEnrollmentRequestJson(id, enrolledAt);

  showOledStatus(
    "FINGERPRINT SAVED",
    String("ID: ") + String(id),
    "NOTIFYING SERVER",
    "PLEASE WAIT"
  );

  bool sentToServer = false;
  DeviceDisplay serverDisplay;

  if (WiFi.status() == WL_CONNECTED) {
    sentToServer =
        sendEnrollmentRequestToServer(
          json,
          &serverDisplay
        );
  }

  if (sentToServer) {
    if (serverDisplay.hasDisplay) {
      showDeviceDisplay(serverDisplay);
    } else {
      showOledStatus(
        "ENROLLMENT READY",
        String("ID: ") + String(id),
        "OPEN SERVER",
        "COMPLETE PROFILE"
      );
    }
    Serial.println("[ENROLL] Server notified. Web app should show registration modal.");
    setRgb(false, true, false);
    r503GreenFlash();
  } else {
    const bool queued = saveEnrollmentRequestOffline(json);

    if (queued) {
      showOledStatus(
        "SERVER OFFLINE",
        String("ID: ") + String(id),
        "RECORDED OFFLINE",
        "PENDING SYNC"
      );
      Serial.println("[ENROLL] Server not notified yet. Enrollment request queued.");
      setRgb(true, true, false);
      r503YellowFlash();
    } else {
      showOledStatus(
        "FINGERPRINT SAVED",
        String("ID: ") + String(id),
        "QUEUE ERROR",
        "LINK ON SERVER"
      );
      Serial.println("[ENROLL] Saved in R503, but server notification queue failed.");
      setRgb(true, false, false);
      r503RedFlash();
    }
  }

  beepFingerprintAccepted();
  delay(2500);
}

// =====================================================
// SERIAL ENROLLMENT COMMANDS
// =====================================================

int firstAvailableFingerprintId() {
  showOledStatus(
    "ENROLL MODE",
    "CHECKING FREE ID",
    "R503 MEMORY",
    "PLEASE WAIT"
  );

  for (int id = 1; id <= 1000; id++) {
    const uint8_t status = finger.loadModel(id);
    if (status != FINGERPRINT_OK) {
      return id;
    }
    delay(2);
  }

  return -1;
}

int commandNumberAfter(
    const String& command,
    const String& prefix
) {
  String value =
      command.substring(prefix.length());
  value.trim();
  return value.toInt();
}

void showHelp() {
  Serial.println();
  Serial.println("===== R503 COMMANDS =====");
  Serial.println("HELP or H       - show commands");
  Serial.println("ENROLL <id>     - enroll template + notify server");
  Serial.println("ENROLL AUTO     - first free ID + notify server");
  Serial.println("E               - same as ENROLL AUTO");
  Serial.println("DELETE <id>     - delete fingerprint template");
  Serial.println("COUNT           - show template count");
  Serial.println("LOGS or L       - show attendance/enroll pending logs");
  Serial.println("CLEAR LOG or C  - delete offline logs for testing");
  Serial.println("COLORS          - test R503 Aura LED indexes 1-8");
  Serial.println("COLOR <1-8>     - show one R503 Aura LED color");
  Serial.println("BUZZER          - test buzzer sound");
  Serial.println("STATUS          - show OLED/WiFi/API/storage status");
  Serial.println("TIME            - show RTC time");
  Serial.println("=========================");
  Serial.println();
}

uint8_t enrollFingerprint(uint16_t id) {
  if (id < 1 || id > 1000) {
    Serial.println("[R503] ID must be 1 to 1000.");
    return FINGERPRINT_PACKETRECIEVEERR;
  }

  int status = -1;

  Serial.print("[R503] Enrolling ID ");
  Serial.println(id);
  Serial.println("[R503] Place finger...");

  showOledStatus(
    "ENROLL MODE",
    String("ID: ") + String(id),
    "PLACE FINGER",
    "R503 READY"
  );

  setRgb(false, false, true);
  r503BlueBreathing();

  unsigned long captureStartedAt = millis();
  while (status != FINGERPRINT_OK) {
    if (millis() - captureStartedAt >= FINGERPRINT_OPERATION_TIMEOUT_MS) {
      showSystemError("Fingerprint Sensor", "Enrollment Timeout", "FP-02");
      return FINGERPRINT_PACKETRECIEVEERR;
    }
    status = finger.getImage();

    if (status == FINGERPRINT_NOFINGER) {
      delay(100);
    } else if (status == FINGERPRINT_OK) {
      Serial.println("[R503] First image captured.");
      sendFingerprintScanStatus("FINGER_DETECTED");
    } else {
      Serial.println("[R503] Image capture failed. Try again.");
      delay(500);
    }
  }

  status = finger.image2Tz(1);
  esp_task_wdt_reset();

  if (status != FINGERPRINT_OK) {
    Serial.println("[R503] First image conversion failed.");
    showErrorFeedback("First fingerprint image failed.");
    return status;
  }

  Serial.println("[R503] Remove finger.");
  showOledStatus(
    "REMOVE FINGER",
    String("ID: ") + String(id),
    "WAIT FOR PROMPT",
    ""
  );
  waitForFingerRemove();
  delay(1000);

  Serial.println("[R503] Place the same finger again...");
  setRgb(true, false, true);
  r503PurpleBreathing();
  showOledStatus(
    "PLACE SAME FINGER",
    String("ID: ") + String(id),
    "SECOND SCAN",
    "KEEP STEADY"
  );
  status = -1;
  captureStartedAt = millis();

  while (status != FINGERPRINT_OK) {
    if (millis() - captureStartedAt >= FINGERPRINT_OPERATION_TIMEOUT_MS) {
      showSystemError("Fingerprint Sensor", "Enrollment Timeout", "FP-02");
      return FINGERPRINT_PACKETRECIEVEERR;
    }
    status = finger.getImage();

    if (status == FINGERPRINT_NOFINGER) {
      delay(100);
    } else if (status == FINGERPRINT_OK) {
      Serial.println("[R503] Second image captured.");
    } else {
      Serial.println("[R503] Image capture failed. Try again.");
      delay(500);
    }
  }

  status = finger.image2Tz(2);

  if (status != FINGERPRINT_OK) {
    Serial.println("[R503] Second image conversion failed.");
    showErrorFeedback("Second fingerprint image failed.");
    return status;
  }

  status = finger.createModel();

  if (status != FINGERPRINT_OK) {
    Serial.println("[R503] Fingerprints did not match.");
    showErrorFeedback("Fingerprint enrollment did not match.");
    return status;
  }

  status = finger.storeModel(id);

  if (status == FINGERPRINT_OK) {
    Serial.println("[R503] Fingerprint saved.");
    handleSuccessfulEnrollment(id);
    showReadyFeedback();
  } else {
    Serial.println("[R503] Fingerprint save failed.");
    showErrorFeedback("Fingerprint save failed.");
  }

  return status;
}

bool deleteFingerprint(uint16_t id) {
  if (id < 1 || id > 1000) {
    Serial.println("[R503] ID must be 1 to 1000.");
    return false;
  }

  const uint8_t status =
      finger.deleteModel(id);

  if (status == FINGERPRINT_OK) {
    Serial.print("[R503] Deleted ID ");
    Serial.println(id);
    setRgb(true, false, false);
    r503RedFlash();
    beepFingerprintAccepted();
    showOledStatus(
      "FINGERPRINT DELETED",
      String("ID: ") + String(id),
      "SERVER UPDATED",
      ""
    );
    beginFeedback(3000);
    return true;
  } else {
    Serial.print("[R503] Delete failed for ID ");
    Serial.println(id);
    showErrorFeedback("Fingerprint delete failed.");
    return false;
  }
}

void printFingerprintCount() {
  const uint8_t status =
      finger.getTemplateCount();

  if (status == FINGERPRINT_OK) {
    Serial.print("[R503] Template count: ");
    Serial.println(finger.templateCount);
  } else {
    Serial.println("[R503] Cannot read template count.");
  }
}

void handleSerialCommands() {
  if (!Serial.available()) {
    return;
  }

  String command =
      Serial.readStringUntil('\n');
  command.trim();

  if (command.isEmpty()) {
    return;
  }

  String upperCommand = command;
  upperCommand.toUpperCase();

  if (
    upperCommand == "HELP" ||
    upperCommand == "H"
  ) {
    showHelp();
    return;
  }

  if (
    upperCommand == "E" ||
    upperCommand == "ENROLL" ||
    upperCommand == "ENROLL AUTO" ||
    upperCommand == "ENROLL NEXT"
  ) {
    const int id = firstAvailableFingerprintId();

    if (id < 1) {
      showErrorFeedback("R503 memory is full.");
      return;
    }

    enrollFingerprint(id);
    return;
  }

  if (upperCommand.startsWith("ENROLL")) {
    const int id =
        commandNumberAfter(command, "ENROLL");
    enrollFingerprint(id);
    return;
  }

  if (upperCommand.startsWith("DELETE")) {
    const int id =
        commandNumberAfter(command, "DELETE");
    deleteFingerprint(id);
    return;
  }

  if (upperCommand == "COUNT") {
    printFingerprintCount();
    return;
  }

  if (
    upperCommand == "LOGS" ||
    upperCommand == "LOG" ||
    upperCommand == "L"
  ) {
    printOfflineLogStatus();
    showOledStatus(
      "OFFLINE LOGS",
      String("Attend: ") + String(countPendingRecords()),
      String("Enroll: ") + String(countPendingEnrollmentRequests()),
      "Use CLEAR LOG"
    );
    return;
  }

  if (
    upperCommand == "CLEAR LOG" ||
    upperCommand == "CLEARLOG" ||
    upperCommand == "CLEAR LOGS" ||
    upperCommand == "CLEARLOGS" ||
    upperCommand == "C"
  ) {
    clearOfflineLogs();
    return;
  }

  if (upperCommand.startsWith("COLOR ")) {
    const int colorIndex =
        commandNumberAfter(command, "COLOR");

    r503ShowSingleColorIndex(colorIndex);
    return;
  }

  if (
    upperCommand == "COLORS" ||
    upperCommand == "COLOR"
  ) {
    Serial.println("[R503] Color demo: raw indexes 1 to 8");
    showOledScreen(
      "R503 COLOR DEMO",
      "Testing indexes 1-8",
      "Watch sensor ring",
      "Note each color",
      ""
    );
    r503ColorShowcase();
    return;
  }

  if (upperCommand == "BUZZER") {
    Serial.println("[BUZZER] Testing buzzer...");
    showOledStatus(
      "BUZZER TEST",
      "GPIO10",
      "If no sound, wiring",
      "or pin is wrong"
    );
    beepTimeIn();
    delay(100);
    beepTimeOut();
    return;
  }


  if (upperCommand == "STATUS") {
    Serial.print("[STATUS] ");
    Serial.println(connectionStatusTitle());
    Serial.println(connectionDetailLine());
    Serial.print("[STATUS] Offline storage: ");
    Serial.println(offlineStorageName());
    Serial.print("[STATUS] MicroSD: ");
    Serial.println(microSdStatus);
    Serial.print("[STATUS] LittleFS ready: ");
    Serial.println(littleFsReady ? "YES" : "NO");

    showOledStatus(
      String("Storage: ") + offlineStorageName(),
      String("SD: ") + microSdStatus,
      String("Flash: ") + (littleFsReady ? "OK" : "FAILED"),
      ""
    );

    return;
  }

  if (upperCommand == "TIME") {
    Serial.print("[RTC] Current time: ");
    Serial.println(formatTimestamp(rtc.now()));
    return;
  }

  Serial.println("[R503] Unknown command. Type HELP.");
}

// =====================================================
// HARDWARE INITIALIZATION
// =====================================================

bool initializeRtc() {
  if (!rtc.begin(&Wire)) {
    Serial.println(
      "[RTC] DS3231 not detected."
    );

    showOledScreen(
      "RTC NOT FOUND",
      "Check DS3231",
      "SDA GPIO8",
      "SCL GPIO9",
      ""
    );

    return false;
  }

  if (rtc.lostPower()) {
    Serial.println(
      "[RTC] Lost power. Setting compile time."
    );

    rtc.adjust(
      DateTime(
        F(__DATE__),
        F(__TIME__)
      )
    );
  }

  Serial.print("[RTC] Current time: ");
  Serial.println(
    formatTimestamp(rtc.now())
  );

  return true;
}

bool initializeFingerprint() {
  fingerprintSerial.begin(
    FINGERPRINT_BAUD,
    SERIAL_8N1,
    FINGERPRINT_RX_PIN,
    FINGERPRINT_TX_PIN
  );

  finger.begin(FINGERPRINT_BAUD);

  if (!finger.verifyPassword()) {
    Serial.println(
      "[R503] Fingerprint sensor not detected."
    );

    showOledScreen(
      "R503 NOT FOUND",
      "TX -> GPIO16 RX",
      "RX -> GPIO17 TX",
      "Check 3.3V/GND",
      ""
    );

    return false;
  }

  fingerprintReady = true;

  Serial.println(
    "[R503] Fingerprint sensor ready."
  );

  printFingerprintCount();
  // Do not run the blocking full-brightness color showcase during boot.
  // Keep the requested low-average breathing blue ready indication.
  r503BlueBreathing();
  return true;
}

bool recoverFingerprintSensorOnce() {
  finger.begin(FINGERPRINT_BAUD);
  if (!finger.verifyPassword()) return false;
  fingerprintReady = true;
  fingerprintCommunicationErrors = 0;
  fingerprintRecoveryAttempts = 0;
  printFingerprintCount();
  r503BlueBreathing();
  Serial.println("[R503] Sensor communication recovered.");
  showReadyFeedback();
  return true;
}

void maintainFingerprintRecovery() {
  if (fingerprintReady || millis() - lastFingerprintRecoveryAt < FINGERPRINT_RECOVERY_INTERVAL_MS) return;
  lastFingerprintRecoveryAt = millis();
  if (fingerprintRecoveryAttempts < FINGERPRINT_RECOVERY_LIMIT) fingerprintRecoveryAttempts++;
  Serial.print("[R503] Recovery attempt ");
  Serial.print(fingerprintRecoveryAttempts);
  Serial.print('/');
  Serial.println(FINGERPRINT_RECOVERY_LIMIT);
  if (recoverFingerprintSensorOnce()) return;
  showSystemError("Fingerprint Sensor", "Not Detected", "FP-01");
}

void initializeFeedbackHardware() {
  if (ENABLE_RGB_LED) {
    pinMode(RGB_RED_PIN, OUTPUT);
    pinMode(RGB_GREEN_PIN, OUTPUT);
    pinMode(RGB_BLUE_PIN, OUTPUT);

    setRgb(false, false, false);
  }

  if (ENABLE_BUZZER) {
    pinMode(BUZZER_PIN, OUTPUT);
    digitalWrite(BUZZER_PIN, LOW);
  }
}

// =====================================================
// ARDUINO SETUP AND LOOP
// =====================================================

void initializeTaskWatchdog() {
#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t watchdogConfig = {
    .timeout_ms = TASK_WATCHDOG_TIMEOUT_MS,
    .idle_core_mask = (1U << portNUM_PROCESSORS) - 1U,
    .trigger_panic = true
  };
  esp_err_t result = esp_task_wdt_init(&watchdogConfig);
  if (result == ESP_ERR_INVALID_STATE) result = esp_task_wdt_reconfigure(&watchdogConfig);
#else
  esp_err_t result = esp_task_wdt_init(TASK_WATCHDOG_TIMEOUT_MS / 1000U, true);
#endif
  if (result == ESP_OK || result == ESP_ERR_INVALID_STATE) esp_task_wdt_add(nullptr);
  Serial.printf("[WATCHDOG] Task watchdog: %s (%lu ms).\n", result == ESP_OK ? "enabled" : "already active", TASK_WATCHDOG_TIMEOUT_MS);
}

const char* resetReasonText(esp_reset_reason_t reason) {
  switch (reason) {
    case ESP_RST_POWERON: return "Power on";
    case ESP_RST_SW: return "Software restart";
    case ESP_RST_PANIC: return "Exception or watchdog panic";
    case ESP_RST_TASK_WDT: return "Task watchdog timeout";
    case ESP_RST_INT_WDT: return "Interrupt watchdog timeout";
    case ESP_RST_BROWNOUT: return "Brownout";
    default: return "Other reset source";
  }
}

void printBootRecoveryReason() {
  recoveryPreferences.begin("gms-recovery", false);
  const String requestedReason = recoveryPreferences.getString("reason", "");
  recoveryPreferences.remove("reason");
  bootResetReason = esp_reset_reason();
  Serial.print("[RECOVERY] ESP reset reason: ");
  Serial.println(resetReasonText(bootResetReason));
  if (!requestedReason.isEmpty()) {
    Serial.print("[RECOVERY] Stored restart reason: ");
    Serial.println(requestedReason);
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  printBootRecoveryReason();
  initializeTaskWatchdog();

  Serial.println();
  Serial.println(
    "ESP32-S3 R503 Attendance Device"
  );

  Serial.print("[SYSTEM] Firmware: ");
  Serial.println(FIRMWARE_VERSION);

  showHelp();
  initializeFeedbackHardware();

  const bool wireStarted =
      Wire.begin(
        I2C_SDA_PIN,
        I2C_SCL_PIN
      );

  if (!wireStarted) {
    Serial.println("[SELF-TEST] I2C bus failed; OLED and RTC unavailable (SYS-01).");
  }

  if (wireStarted) Wire.setClock(100000);

  if (wireStarted) initializeOled();

  showOledScreen(
    "BOOTING",
    "CHECKING STORAGE",
    "PLEASE WAIT",
    "",
    ""
  );

  if (!initializeStorage()) {
    showSystemError("Local Storage", "Mount Failed", "MEM-01");
  }

  showOledScreen(
    "BOOTING",
    "CHECKING DEVICE",
    "PLEASE WAIT",
    "",
    ""
  );

  rtcReady = wireStarted && initializeRtc();
  if (!rtcReady) {
    showSystemError("RTC Clock", "Invalid / Missing", "RTC-01");
  }

  for (uint8_t attempt = 0; attempt < FINGERPRINT_RECOVERY_LIMIT && !fingerprintReady; attempt++) {
    Serial.print("[R503] Startup attempt "); Serial.println(attempt + 1);
    if (initializeFingerprint()) break;
    delay(250);
  }
  if (!fingerprintReady) {
    fingerprintRecoveryAttempts = FINGERPRINT_RECOVERY_LIMIT;
    showSystemError("Fingerprint Sensor", "Not Detected", "FP-01");
  }

  waitForInitialWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("[WIFI] Checking server health endpoint...");
    if (checkServerHealth()) {
      Serial.println("[HEALTH] Server is online.");
      serverReachable = true;
    } else {
      Serial.println("[HEALTH] Server health check failed.");
      serverReachable = false;
    }
  }

  Serial.print("[OFFLINE] Storage backend: ");
  Serial.println(offlineStorageName());

  Serial.print(
    "[OFFLINE] Existing attendance queue: "
  );

  Serial.println(
    countPendingRecords()
  );

  Serial.print(
    "[OFFLINE] Existing enrollment queue: "
  );

  Serial.println(
    countPendingEnrollmentRequests()
  );

  if (WiFi.status() == WL_CONNECTED) {
    sendReaderHeartbeat();
    lastHeartbeatAttempt = millis();

    if (serverReachable) {
      synchronizePendingRecords();
      synchronizePendingEnrollmentRequests();
      pollDisplayCommand();
      lastDisplayCommandPoll = millis();
    }
  }

  lastConnectionTitle = connectionStatusTitle();
  lastDeviceActivityAt = millis();
  if (bootResetReason == ESP_RST_PANIC || bootResetReason == ESP_RST_TASK_WDT || bootResetReason == ESP_RST_INT_WDT) {
    showSystemError("System Recovery", resetReasonText(bootResetReason), "SYS-01");
    beginFeedback(5000);
  } else if (fingerprintReady) {
    showReadyFeedback();
  }
}

void loop() {
  handleSerialCommands();
  maintainWiFiConnection();
  maintainFeedbackState();
  maintainOledProtection();
  maintainFingerprintRecovery();

  if (!feedbackActive && !syncInProgress) {
    const String currentTitle = connectionStatusTitle();
    if (currentTitle != lastConnectionTitle) {
      lastConnectionTitle = currentTitle;
      wakeOled(true);
      showReadyFeedback();
    } else if (!oledSleeping && millis() - lastIdleOledRefresh >= 60000) {
      lastIdleOledRefresh = millis();
      showIdleOled();
    }
  }

  if (
    WiFi.status() == WL_CONNECTED &&
    millis() - lastHeartbeatAttempt >=
      HEARTBEAT_INTERVAL_MS
  ) {
    lastHeartbeatAttempt = millis();
    sendReaderHeartbeat();
  }

  if (
    WiFi.status() == WL_CONNECTED &&
    serverReachable &&
    !feedbackActive &&
    !syncInProgress &&
    millis() - lastDisplayCommandPoll >=
      DISPLAY_COMMAND_INTERVAL_MS
  ) {
    lastDisplayCommandPoll = millis();
    pollDisplayCommand();
  }

  if (
    WiFi.status() == WL_CONNECTED &&
    serverReachable &&
    millis() - lastSyncAttempt >=
      SYNC_INTERVAL_MS
  ) {
    lastSyncAttempt = millis();
    synchronizePendingRecords();
    synchronizePendingEnrollmentRequests();
  }

  if (fingerprintReady && millis() - lastFingerprintPollAt >= FINGERPRINT_POLL_INTERVAL_MS) {
    lastFingerprintPollAt = millis();
    uint16_t fingerprintId = 0;
    uint16_t confidence = 0;
    if (readFingerprintMatch(fingerprintId, confidence)) processFingerprint(fingerprintId, confidence);
  }

  if (millis() - lastHeapLogAt >= HEAP_LOG_INTERVAL_MS) {
    lastHeapLogAt = millis();
    Serial.printf("[MEMORY] Free heap: %u bytes; minimum: %u bytes.\n", ESP.getFreeHeap(), ESP.getMinFreeHeap());
  }

  esp_task_wdt_reset();
  yield();
}

/*
  Existing attendance, enrollment, queue replay, and server display-command
  functions above remain the source of truth. The loop intentionally has no
  fixed delay: each maintenance job runs from its own millis() schedule.
*/

