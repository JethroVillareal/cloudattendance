#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <WiFiUdp.h>
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
#include <ESPmDNS.h>
#include <WebServer.h>
#include <ArduinoOTA.h>

#if defined(__has_include)
  #if __has_include(<PubSubClient.h>)
    #include <PubSubClient.h>
    #define GMS_MQTT_LIBRARY_AVAILABLE 1
  #else
    #define GMS_MQTT_LIBRARY_AVAILABLE 0
  #endif
#else
  #define GMS_MQTT_LIBRARY_AVAILABLE 0
#endif

const char* WIFI_SSID = "HUAWEI-2.4G-uV3h";
const char* WIFI_PASSWORD = "ZgE8mvHe";
String wifiSsid = WIFI_SSID;
String wifiPassword = WIFI_PASSWORD;


String serverUrl = "http://192.168.100.61:3000";
String cloudApiUrl = "https://cloudattendance.onrender.com/api/attendance/scan";
const char* API_KEY = "GMS-ATTENDANCE-KEY-2026";
String deviceId = "ATTENDANCE-DEVICE-01";
String deviceLocation = "MAIN-ENTRANCE";

// Remote-management and discovery defaults. Every value can be changed later
// through Preferences, Serial CONFIG SET commands, or the Web Admin page.
String mdnsServerHost = "gms-attendance";
String otaPassword = "GMS-OTA-2026";
String webAdminUsername = "admin";
String webAdminPassword = "GMS-ADMIN-2026";
bool webAdminEnabled = true;
bool otaEnabled = true;

bool mqttEnabled = false;
String mqttHost = "";
uint16_t mqttPort = 1883;
String mqttUsername = "";
String mqttPassword = "";
String mqttTopicPrefix = "gms/attendance";

const char* FIRMWARE_VERSION =
    "6.0.3-sd-diagnostics";

// SCAN BREATHING ANIMATION LEGEND (R503 Aura):
// PURPLE breathing = finger detected / image capture starting.
// BLUE breathing   = fingerprint image captured / converting.
// PURPLE breathing = searching R503 template memory.
// GREEN breathing  = template match confirmed / preparing record.
// CYAN breathing   = sending attendance to server.
// YELLOW breathing = saving attendance to offline storage.
// Final accepted/denied/duplicate results still use flashes for clarity.

// IDLE CONNECTION COLOR LEGEND (external RGB + R503 Aura):
// RED breathing    = Wi-Fi disconnected; scans save offline.
// YELLOW breathing = Wi-Fi connected, but local/cloud server unavailable.
// GREEN breathing  = local attendance server connected.
// CYAN breathing   = cloud attendance server connected.
// Scan flow keeps its original colors: purple detect/match, blue capture,
// green accepted, yellow offline/pending, red error, cyan API/sync.

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
// When both servers are unavailable, probe less often so fingerprint scanning
// remains responsive and the terminal does not spend most of its time in HTTP.
// Re-check an unavailable local/cloud server every 10 seconds. This keeps
// recovery responsive without making HTTP retries dominate fingerprint polling.
constexpr unsigned long DISCONNECTED_HEARTBEAT_INTERVAL_MS = 10000;
constexpr unsigned long DISPLAY_COMMAND_INTERVAL_MS = 2500;
constexpr unsigned long DUPLICATE_FINGER_DELAY_MS = 3000;
constexpr unsigned long READY_RESTORE_DELAY_MS = 2500;
constexpr unsigned long FINGER_REMOVE_TIMEOUT_MS = 5000;
constexpr uint16_t HEARTBEAT_HTTP_TIMEOUT_MS = 1500;
constexpr uint16_t API_HTTP_TIMEOUT_MS = 2500;
// Live scan-status and display-command requests are optional. Keep them short
// so a dead server cannot freeze the physical fingerprint workflow.
constexpr uint16_t AUXILIARY_HTTP_TIMEOUT_MS = 600;
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

const char* ENROLL_PENDING_FILE = "/enroll_pending.ndjson";
const char* ENROLL_TEMP_FILE = "/enroll_pending.tmp";
const char* ENROLL_BACKUP_FILE = "/enroll_pending.bak";

const char* EMPLOYEE_CACHE_FILE = "/employee_cache.json";

constexpr unsigned long NTP_SYNC_INTERVAL_MS = 21600000;
constexpr unsigned long NTP_QUERY_TIMEOUT_MS = 5000;
constexpr uint16_t NTP_SERVER_PORT = 123;
constexpr uint16_t NTP_LOCAL_PORT = 2390;
constexpr float NTP_DRIFT_THRESHOLD_SECONDS = 2.0f;
const char* NTP_SERVER_PRIMARY = "pool.ntp.org";
const char* NTP_SERVER_SECONDARY = "time.google.com";

constexpr unsigned long MDNS_UPDATE_INTERVAL_MS = 60000;
constexpr unsigned long MDNS_DISCOVERY_INTERVAL_MS = 60000;
constexpr uint32_t MDNS_QUERY_TIMEOUT_MS = 1500;
constexpr int32_t LOCAL_TIME_UTC_OFFSET_SECONDS = 8 * 60 * 60;

constexpr uint16_t WEB_ADMIN_PORT = 80;
constexpr uint16_t OTA_PORT = 3232;
constexpr unsigned long REMOTE_SERVICE_RETRY_MS = 5000;

constexpr unsigned long MQTT_RECONNECT_INTERVAL_MS = 15000;
constexpr unsigned long MQTT_TELEMETRY_INTERVAL_MS = 30000;

// Independent anti-spam protection. The original 3-second duplicate-finger
// guard remains, while this table blocks the same template for 10 seconds.
constexpr unsigned long PER_FINGERPRINT_COOLDOWN_MS = 4500;
constexpr uint8_t FINGERPRINT_COOLDOWN_SLOTS = 32;

constexpr unsigned long CONFIG_SAVE_DEBOUNCE_MS = 5000;
constexpr uint16_t SERIAL_COMMAND_BUFFER_SIZE = 256;

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

WebServer webServer(WEB_ADMIN_PORT);
WiFiClient mqttNetworkClient;
#if GMS_MQTT_LIBRARY_AVAILABLE
PubSubClient mqttClient(mqttNetworkClient);
#endif

struct ApiResponse;

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
bool syncRtcWithNtp();
bool queryNtpServer(const char* ntpServer, DateTime& ntpTime);
float calculateRtcDrift(const DateTime& rtcTime, const DateTime& ntpTime);
void applyDeviceConfig();
void saveConfigIfDirty();
String getEmployeeName(uint16_t fingerprintId);
String cachedNameOrUnknown(uint16_t fingerprintId);
String normalizeMdnsHostname(String value);
void startMdns();
void stopMdns();
void startWebAdmin();
void stopWebAdmin();
void startOtaService();
void stopOtaService();
void cacheEmployeeName(uint16_t fingerprintId, const String& fullName);
void loadEmployeeCache();
void showApiFeedback(const ApiResponse& response, const DateTime& scanTime, uint16_t fingerprintId = 0);
void handleSerialCommands();
String effectiveLocalServerUrl();
String deviceMdnsHostname();
bool discoverAttendanceServer(bool force = false);
void setupWebAdminRoutes();
void maintainWebAdmin();
void maintainPendingWebActions();
void maintainOtaService();
void maintainMqtt();
void maintainRemoteServices();
void clearOfflineLogs();
void publishMqttScanEvent(uint16_t fingerprintId, uint16_t confidence, const String& resultCode, const String& fullName);
bool updateConfigSetting(const String& rawKey, const String& rawValue, String& resultMessage);

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
  ONLINE_DISCONNECTED,
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
// Set when a scan is stored offline or when connectivity is restored.
// The loop gives this replay priority before polling display commands.
bool pendingSyncRequested = false;
bool fingerprintReady = false;
bool oledReady = false;
bool rtcReady = false;
bool wasWiFiConnected = false;
bool serverReachable = false;
String activeApiUrl = String(serverUrl) + "/api/attendance/scan";
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

WiFiUDP ntpUdp;
unsigned long lastNtpSyncAt = 0;
bool ntpSynced = false;
float ntpDriftSeconds = 0.0f;
unsigned long lastMdnsAdvertisedAt = 0;
bool mdnsActive = false;
String resolvedServerHost = "";
uint16_t resolvedServerPort = 3000;
unsigned long lastConfigSaveAt = 0;
String pendingServerUrl = "";
String pendingCloudUrl = "";
String pendingDeviceId = "";
String pendingDeviceLocation = "";
String pendingWifiSsid = "";
String pendingWifiPassword = "";
bool configDirty = false;
String serialCommandBuffer = "";

String discoveredServerUrl = "";
unsigned long lastMdnsDiscoveryAt = 0;

bool webRoutesConfigured = false;
bool webAdminStarted = false;
bool otaStarted = false;
bool remoteServicesRestartRequested = false;
unsigned long lastRemoteServiceAttemptAt = 0;

int pendingWebEnrollmentId = 0;  // -1 = automatic first available ID
bool restartRequested = false;
unsigned long restartRequestedAt = 0;
bool wifiReconnectRequested = false;
unsigned long wifiReconnectRequestedAt = 0;

unsigned long lastMqttReconnectAt = 0;
unsigned long lastMqttTelemetryAt = 0;

struct FingerprintCooldownEntry {
  uint16_t fingerprintId = 0;
  unsigned long recordedAt = 0;
};
FingerprintCooldownEntry fingerprintCooldowns[FINGERPRINT_COOLDOWN_SLOTS];

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
  const String detailText = connectionDetailLine();
  const String frameKey = connectionStatusTitle() + '|' + timeText + '|' + detailText + "|SCAN FINGERPRINT";
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
  display.setCursor(12, 18);
  display.print(timeText);

  // Connection detail makes ONLINE DISCONNECTED visible even while idle.
  display.setTextSize(1);
  display.setCursor(0, 40);
  display.print(fitOledLine(detailText));

  // Bottom: scanning remains available in every connection state.
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
  // Red breathing: no Wi-Fi. Fingerprint attendance still saves offline.
  if (WiFi.status() != WL_CONNECTED) {
    setRgb(true, false, false);
    r503RedBreathing();
    return;
  }

  // Yellow breathing: Wi-Fi exists, but neither local nor cloud API responds.
  if (!serverReachable) {
    setRgb(true, true, false);
    r503YellowBreathing();
    return;
  }

  // A server-provided after-hours/close status may override normal connected
  // colors. Do not overwrite the R503 Aura color with blue afterward.
  if (idleCloseStatusActive) {
    applyDeviceColor(idleCloseStatusColor);
    return;
  }

  if (activeServerIsLocal) {
    // Green breathing: connected to the local LAN server.
    setRgb(false, true, false);
    r503GreenBreathing();
    return;
  }

  // Cyan breathing: connected through the cloud server.
  setRgb(false, true, true);
  r503CyanBreathing();
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
  feedbackActive = false;

  if (WiFi.status() != WL_CONNECTED) {
    deviceState = DeviceState::OFFLINE;
  } else if (!serverReachable) {
    deviceState = DeviceState::ONLINE_DISCONNECTED;
  } else {
    deviceState = DeviceState::IDLE;
  }

  applyIdleReadyColor();
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

void showOfflineFeedback(uint16_t fingerprintId = 0) {
  deviceState = DeviceState::OFFLINE;
  setRgb(true, true, false);
  r503YellowFlash();
  beepOffline();
  beginFeedback();

  String employeeName = "";
  if (fingerprintId > 0) {
    employeeName = cachedNameOrUnknown(fingerprintId);
  }

  showLiveScanStage(
    "OFFLINE MODE",
    employeeName,
    "Attendance Saved",
    "Syncing Later"
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

  return String(deviceId)
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

  document["deviceId"] = deviceId;
  document["location"] = deviceLocation;

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

  document["deviceId"] = deviceId;
  document["location"] = deviceLocation;
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
String microSdCode = "SD-00";
String microSdStatus = "NOT CHECKED";
String microSdDetail = "Diagnostics have not run yet";
uint32_t microSdMountedFrequency = 0;
const char* SD_DIAGNOSTIC_FILE = "/sd_health.tmp";

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
    String("SD ERROR ") + microSdCode,
    microSdStatus,
    littleFsReady ? "Using LittleFS" : "NO BACKUP STORAGE",
    "Type SDTEST in Serial",
    ""
  );

  delay(1800);
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

void setMicroSdDiagnostic(
    const String& code,
    const String& status,
    const String& detail
) {
  microSdCode = code;
  microSdStatus = status;
  microSdDetail = detail;

  Serial.print("[SD DIAG] ");
  Serial.print(microSdCode);
  Serial.print(" ");
  Serial.println(microSdStatus);
  Serial.print("[SD DIAG] Detail: ");
  Serial.println(microSdDetail);
}

bool verifyMicroSdReadWrite() {
  const String expected = "GMS_SD_TEST_OK";

  SD.remove(SD_DIAGNOSTIC_FILE);

  File testFile = SD.open(SD_DIAGNOSTIC_FILE, FILE_WRITE);
  if (!testFile) {
    setMicroSdDiagnostic(
      "SD-04",
      "WRITE OPEN FAILED",
      "Card may be read-only, full, corrupt, or unstable"
    );
    return false;
  }

  const size_t written = testFile.print(expected);
  testFile.flush();
  testFile.close();

  if (written != expected.length()) {
    SD.remove(SD_DIAGNOSTIC_FILE);
    setMicroSdDiagnostic(
      "SD-04",
      "WRITE FAILED",
      "Card may be full, damaged, read-only, or poorly connected"
    );
    return false;
  }

  testFile = SD.open(SD_DIAGNOSTIC_FILE, FILE_READ);
  if (!testFile) {
    SD.remove(SD_DIAGNOSTIC_FILE);
    setMicroSdDiagnostic(
      "SD-05",
      "READ OPEN FAILED",
      "Card mounted but the test file could not be read back"
    );
    return false;
  }

  String actual = testFile.readString();
  testFile.close();
  SD.remove(SD_DIAGNOSTIC_FILE);
  actual.trim();

  if (actual != expected) {
    setMicroSdDiagnostic(
      "SD-05",
      "VERIFY FAILED",
      "Read-back mismatch; card or SPI connection is unstable"
    );
    return false;
  }

  return true;
}

bool tryMountMicroSd(uint32_t frequency) {
  SD.end();
  delay(30);

  Serial.print("[SD DIAG] Trying SPI frequency: ");
  Serial.print(frequency / 1000UL);
  Serial.println(" kHz");

  if (!SD.begin(SD_CS_PIN, SPI, frequency)) {
    return false;
  }

  microSdMountedFrequency = frequency;
  return true;
}

bool initializeMicroSdStorage() {
  microSdReady = false;
  useMicroSdStorage = false;
  microSdMountedFrequency = 0;

  if (!ENABLE_MICROSD) {
    setMicroSdDiagnostic(
      "SD-00",
      "DISABLED",
      "MicroSD support is disabled in firmware"
    );
    return false;
  }

  Serial.println("[STORAGE] Running MicroSD diagnostics over SPI...");
  Serial.printf(
    "[SD DIAG] Pins CS=%u SCK=%u MISO=%u MOSI=%u\n",
    SD_CS_PIN,
    SD_SCK_PIN,
    SD_MISO_PIN,
    SD_MOSI_PIN
  );

  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);

  SPI.begin(
    SD_SCK_PIN,
    SD_MISO_PIN,
    SD_MOSI_PIN,
    SD_CS_PIN
  );

  const uint32_t diagnosticFrequencies[] = {
    SD_SPI_FREQUENCY,
    1000000,
    400000
  };

  bool mounted = false;
  for (uint8_t index = 0; index < 3; index++) {
    if (tryMountMicroSd(diagnosticFrequencies[index])) {
      mounted = true;
      break;
    }
  }

  if (!mounted) {
    setMicroSdDiagnostic(
      "SD-01",
      "NO RESPONSE / MOUNT FAILED",
      "Check card insertion, FAT32, 3.3V, wiring, or SD module"
    );
    return false;
  }

  const uint8_t cardType = SD.cardType();

  if (cardType == CARD_NONE) {
    SD.end();
    setMicroSdDiagnostic(
      "SD-02",
      "CARD NOT DETECTED",
      "Slot is responding but no readable card is detected"
    );
    return false;
  }

  const uint64_t cardSizeBytes = SD.cardSize();
  if (cardSizeBytes == 0) {
    SD.end();
    setMicroSdDiagnostic(
      "SD-03",
      "INVALID CARD SIZE",
      "Card is detected but may be damaged or unsupported"
    );
    return false;
  }

  if (!verifyMicroSdReadWrite()) {
    SD.end();
    return false;
  }

  microSdReady = true;
  useMicroSdStorage = true;

  const unsigned long cardSizeMb = static_cast<unsigned long>(
    cardSizeBytes / (1024ULL * 1024ULL)
  );

  setMicroSdDiagnostic(
    "SD-OK",
    String("READY ") + microSdCardTypeName(cardType),
    String(cardSizeMb) + " MB, read/write verified at "
      + String(microSdMountedFrequency / 1000UL) + " kHz"
  );

  Serial.println("[STORAGE] MicroSD read/write test passed.");
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
// LOCAL SERVER ROUTING
// =====================================================

String effectiveLocalServerUrl() {
  return discoveredServerUrl.isEmpty() ? serverUrl : discoveredServerUrl;
}

// =====================================================
// WI-FI
// =====================================================

void startWiFiConnection() {
  Serial.println();
  Serial.print("[WIFI] Connecting to 2.4 GHz SSID: ");
  Serial.println(wifiSsid);
  Serial.println("[WIFI] Ensure this is the 2.4 GHz network; ESP32-S3 cannot use 5 GHz.");

  WiFi.setHostname(deviceMdnsHostname().c_str());
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);

  WiFi.begin(
    wifiSsid.c_str(),
    wifiPassword.c_str()
  );

  lastWiFiAttempt = millis();
}

void waitForInitialWiFi() {
  startWiFiConnection();
  wasWiFiConnected = false;
  deviceState = DeviceState::OFFLINE;
  showOledScreen("OFFLINE MODE", "WiFi connecting", "Attendance Saved", "Syncing Later", "CODE: WIFI-01");
  Serial.println("[WIFI] Connection continues in background; local scanning is ready.");
  Serial.printf("[WIFI] Target server: %s\n", effectiveLocalServerUrl().c_str());
}

void maintainWiFiConnection() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wasWiFiConnected) {
      wasWiFiConnected = true;
      currentWiFiRetryIntervalMs = WIFI_RETRY_INTERVAL_MS;

      // Wi-Fi being connected does not prove that either API is reachable.
      // Reset stale server state and force a fresh heartbeat immediately.
      serverReachable = false;
      lastServerStatusCode = 0;
      lastConnectionTitle = "";
      activeApiUrl = effectiveLocalServerUrl() + "/api/attendance/scan";
      activeServerIsLocal = true;
      lastHeartbeatAttempt = millis() - DISCONNECTED_HEARTBEAT_INTERVAL_MS;

      Serial.println("[WIFI] Reconnected.");
      Serial.print("[WIFI] IP: ");
      Serial.println(WiFi.localIP());
      Serial.print("[WIFI] RSSI: ");
      Serial.print(WiFi.RSSI());
      Serial.println(" dBm");
      showReadyFeedback();
    }
    return;
  }

  if (wasWiFiConnected) {
    wasWiFiConnected = false;
    serverReachable = false;
    lastServerStatusCode = 0;
    lastConnectionTitle = "";
    showReadyFeedback();
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
    wifiSsid.c_str(),
    wifiPassword.c_str()
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
  http.addHeader("X-Device-ID", deviceId);

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

  String healthUrl = effectiveLocalServerUrl() + "/api/health";
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

  Serial.println("[API] Trying local attendance server...");
  const String localScanUrl = effectiveLocalServerUrl() + "/api/attendance/scan";
  if (sendScanToEndpoint(localScanUrl, json, response)) {
    lastLocalServerProbeAt = millis();
    selectActiveServer(localScanUrl, true);
    return true;
  }

  Serial.println("[API] Local unavailable; trying cloud once...");
  if (sendScanToEndpoint(String(cloudApiUrl), json, response)) {
    selectActiveServer(String(cloudApiUrl), false);
    return true;
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
      + String(deviceId);
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
  document["deviceId"] = deviceId;
  document["status"] = status;
  String json;
  serializeJson(document, json);
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  HTTPClient http;
  http.setTimeout(AUXILIARY_HTTP_TIMEOUT_MS);
  if (!beginDeviceHttp(http, plainClient, secureClient, fingerprintScanStatusUrl())) return;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", deviceId);
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
  http.addHeader("X-Device-ID", deviceId);

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

void cacheEmployeesFromHeartbeat(JsonVariantConst source) {
  if (source.isNull()) {
    return;
  }

  size_t cachedCount = 0;

  if (source.is<JsonArrayConst>()) {
    for (JsonVariantConst item : source.as<JsonArrayConst>()) {
      uint16_t fingerprintId = item["fingerprintId"] | 0;
      if (fingerprintId == 0) fingerprintId = item["id"] | 0;
      String fullName = String(item["fullName"] | "");
      if (fullName.isEmpty()) fullName = String(item["name"] | "");
      fullName.trim();

      if (fingerprintId > 0 && !fullName.isEmpty()) {
        cacheEmployeeName(fingerprintId, fullName);
        cachedCount++;
      }
    }
  } else if (source.is<JsonObjectConst>()) {
    for (JsonPairConst pair : source.as<JsonObjectConst>()) {
      const uint16_t fingerprintId =
          static_cast<uint16_t>(String(pair.key().c_str()).toInt());
      String fullName = "";

      if (pair.value().is<const char*>()) {
        fullName = String(pair.value().as<const char*>());
      } else if (pair.value().is<JsonObjectConst>()) {
        fullName = String(pair.value()["fullName"] | "");
        if (fullName.isEmpty()) fullName = String(pair.value()["name"] | "");
      }

      fullName.trim();
      if (fingerprintId > 0 && !fullName.isEmpty()) {
        cacheEmployeeName(fingerprintId, fullName);
        cachedCount++;
      }
    }
  }

  if (cachedCount > 0) {
    Serial.print("[CACHE] Heartbeat refreshed ");
    Serial.print(cachedCount);
    Serial.println(" employee name(s).");
  }
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

  JsonVariantConst employeeCache = document["employeeCache"];
  if (employeeCache.isNull()) employeeCache = document["employees"];
  if (employeeCache.isNull()) employeeCache = document["fingerprints"];
  cacheEmployeesFromHeartbeat(employeeCache);
}

void sendReaderHeartbeat() {
  const bool serverWasReachable = serverReachable;

  if (WiFi.status() != WL_CONNECTED) {
    serverReachable = false;
    lastServerStatusCode = 0;
    resetIdleCloseStatus();
    return;
  }

  JsonDocument document;
  document["deviceId"] = deviceId;
  document["source"] = "ESP32-S3";
  document["location"] = deviceLocation;
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
  capabilities["ntpRtcCorrection"] = true;
  capabilities["mdnsDiscovery"] = true;
  capabilities["preferencesConfig"] = true;
  capabilities["employeeNameCache"] = true;
  capabilities["webAdmin"] = webAdminEnabled;
  capabilities["ota"] = otaEnabled;
  capabilities["mqtt"] = mqttEnabled && (GMS_MQTT_LIBRARY_AVAILABLE == 1);
  capabilities["perFingerprintRateLimit"] = true;
  document["webAdminUrl"] = String("http://") + deviceMdnsHostname() + ".local/";
  document["discoveredServerUrl"] = discoveredServerUrl;

  String json;
  serializeJson(document, json);

  bool sent = false;
  int statusCode = 0;

  activeApiUrl = effectiveLocalServerUrl() + "/api/attendance/scan";
  activeServerIsLocal = true;
  {
    WiFiClient plainClient;
    WiFiClientSecure secureClient;
    HTTPClient http;
    http.setTimeout(HEARTBEAT_HTTP_TIMEOUT_MS);
    if (beginDeviceHttp(http, plainClient, secureClient, heartbeatUrl())) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-API-Key", API_KEY);
      http.addHeader("X-Device-ID", deviceId);
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
      }
    } else {
      Serial.println("[HEARTBEAT] Local HTTP init failed.");
    }
  }

  if (!sent) {
    activeApiUrl = String(cloudApiUrl);
    activeServerIsLocal = false;
    WiFiClient plainClient;
    WiFiClientSecure secureClient;
    HTTPClient http;
    http.setTimeout(HEARTBEAT_HTTP_TIMEOUT_MS);
    if (beginDeviceHttp(http, plainClient, secureClient, heartbeatUrl())) {
      http.addHeader("Content-Type", "application/json");
      http.addHeader("X-API-Key", API_KEY);
      http.addHeader("X-Device-ID", deviceId);
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
      }
    } else {
      Serial.println("[HEARTBEAT] Cloud HTTP init failed.");
    }
  }

  if (!sent) {
    serverReachable = false;
    lastServerStatusCode = statusCode;
    resetIdleCloseStatus();
  } else if (!serverWasReachable) {
    const size_t pendingTotal =
        countPendingRecords() + countPendingEnrollmentRequests();

    if (pendingTotal > 0) {
      pendingSyncRequested = true;
      Serial.print("[SYNC] Server restored; immediate replay requested for ");
      Serial.print(pendingTotal);
      Serial.println(" pending record(s).");
    }
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
  document["deviceId"] = deviceId;
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
  http.setTimeout(AUXILIARY_HTTP_TIMEOUT_MS);

  if (!beginDeviceHttp(http, plainClient, secureClient, displayCommandAckUrl())) {
    Serial.println("[COMMAND] ACK HTTP init failed.");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", deviceId);

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
  http.setTimeout(AUXILIARY_HTTP_TIMEOUT_MS);

  if (!beginDeviceHttp(http, plainClient, secureClient, displayCommandUrl())) {
    Serial.println("[COMMAND] Display command HTTP init failed.");
    return;
  }

  http.addHeader("X-API-Key", API_KEY);
  http.addHeader("X-Device-ID", deviceId);

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
// NTP TIME SYNC
// =====================================================

bool queryNtpServer(const char* ntpServer, DateTime& ntpTime) {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  uint8_t ntpPacket[48] = {0};
  ntpPacket[0] = 0b11100011;  // LI, Version 4, Client mode
  ntpPacket[1] = 0;           // Stratum
  ntpPacket[2] = 6;           // Polling interval
  ntpPacket[3] = 0xEC;        // Peer clock precision
  ntpPacket[12] = 49;
  ntpPacket[13] = 0x4E;
  ntpPacket[14] = 49;
  ntpPacket[15] = 52;

  if (!ntpUdp.begin(NTP_LOCAL_PORT)) {
    Serial.println("[NTP] UDP begin failed.");
    return false;
  }

  ntpUdp.beginPacket(ntpServer, NTP_SERVER_PORT);
  ntpUdp.write(ntpPacket, 48);
  ntpUdp.endPacket();

  const unsigned long startedAt = millis();
  while (millis() - startedAt < NTP_QUERY_TIMEOUT_MS) {
    const int packetSize = ntpUdp.parsePacket();
    if (packetSize >= 48) {
      uint8_t packetBuffer[48];
      ntpUdp.read(packetBuffer, 48);

      const uint32_t secondsSince1900 =
        ((uint32_t)packetBuffer[40] << 24) |
        ((uint32_t)packetBuffer[41] << 16) |
        ((uint32_t)packetBuffer[42] << 8) |
        (uint32_t)packetBuffer[43];

      const uint32_t secondsSince1970 = secondsSince1900 - 2208988800UL;
      const uint32_t fraction =
        ((uint32_t)packetBuffer[44] << 24) |
        ((uint32_t)packetBuffer[45] << 16) |
        ((uint32_t)packetBuffer[46] << 8) |
        (uint32_t)packetBuffer[47];

      const float subSeconds = (float)fraction / 4294967296.0f;
      const time_t epoch = (time_t)(secondsSince1970 + LOCAL_TIME_UTC_OFFSET_SECONDS + (subSeconds > 0.5f ? 1 : 0));
      ntpTime = DateTime(epoch);
      ntpUdp.stop();
      return true;
    }
    delay(50);
  }

  ntpUdp.stop();
  return false;
}

float calculateRtcDrift(const DateTime& rtcTime, const DateTime& ntpTime) {
  const time_t rtcEpoch = rtcTime.unixtime();
  const time_t ntpEpoch = ntpTime.unixtime();
  const float drift = (float)(ntpEpoch - rtcEpoch);
  return drift > 0 ? drift : -drift;
}

bool syncRtcWithNtp() {
  if (WiFi.status() != WL_CONNECTED || !rtcReady) {
    return false;
  }

  DateTime ntpTime;
  bool primaryOk = queryNtpServer(NTP_SERVER_PRIMARY, ntpTime);
  bool secondaryOk = false;

  if (!primaryOk) {
    secondaryOk = queryNtpServer(NTP_SERVER_SECONDARY, ntpTime);
  }

  if (!primaryOk && !secondaryOk) {
    Serial.println("[NTP] Both NTP servers unreachable.");
    lastNtpSyncAt = millis() - NTP_SYNC_INTERVAL_MS + 300000;
    return false;
  }

  const DateTime rtcTime = rtc.now();
  ntpDriftSeconds = calculateRtcDrift(rtcTime, ntpTime);

  Serial.print("[NTP] RTC drift: ");
  Serial.print(ntpDriftSeconds, 1);
  Serial.println(" seconds.");

  if (ntpDriftSeconds > NTP_DRIFT_THRESHOLD_SECONDS) {
    rtc.adjust(ntpTime);
    Serial.print("[NTP] RTC corrected to: ");
    Serial.println(formatTimestamp(ntpTime));
  } else {
    Serial.println("[NTP] RTC drift within tolerance; no adjustment needed.");
  }

  ntpSynced = true;
  lastNtpSyncAt = millis();
  return true;
}

void maintainNtpSync() {
  if (
    WiFi.status() != WL_CONNECTED ||
    !rtcReady ||
    millis() - lastNtpSyncAt < NTP_SYNC_INTERVAL_MS
  ) {
    return;
  }

  Serial.println("[NTP] Scheduled sync...");
  syncRtcWithNtp();
}

// =====================================================
// MDNS / DNS-SD DEVICE ADVERTISING + SERVER DISCOVERY
// =====================================================

String normalizeMdnsHostname(String value) {
  value.trim();
  value.toLowerCase();

  String normalized = "";
  normalized.reserve(32);
  bool previousWasDash = false;

  for (size_t i = 0; i < value.length() && normalized.length() < 31; i++) {
    const char character = value.charAt(i);
    const bool isAlphaNumeric =
        (character >= 'a' && character <= 'z') ||
        (character >= '0' && character <= '9');

    if (isAlphaNumeric) {
      normalized += character;
      previousWasDash = false;
    } else if (!previousWasDash && !normalized.isEmpty()) {
      normalized += '-';
      previousWasDash = true;
    }
  }

  while (normalized.endsWith("-")) {
    normalized.remove(normalized.length() - 1);
  }

  if (normalized.isEmpty()) {
    normalized = "gms-device";
  }

  return normalized;
}

String deviceMdnsHostname() {
  return normalizeMdnsHostname(deviceId);
}

bool applyDiscoveredServer(
    const IPAddress& address,
    uint16_t port,
    const String& hostname
) {
  if (
    address == IPAddress(0, 0, 0, 0) ||
    address == WiFi.localIP() ||
    port == 0
  ) {
    return false;
  }

  const String candidateUrl =
      String("http://") + address.toString() + ":" + String(port);

  const bool changed = candidateUrl != discoveredServerUrl;
  discoveredServerUrl = candidateUrl;
  resolvedServerHost = hostname.isEmpty() ? address.toString() : hostname;
  resolvedServerPort = port;

  if (changed) {
    Serial.print("[MDNS] Attendance server discovered: ");
    Serial.println(discoveredServerUrl);
    activeApiUrl = discoveredServerUrl + "/api/attendance/scan";
    activeServerIsLocal = true;
    serverReachable = false;
    lastHeartbeatAttempt = millis() - DISCONNECTED_HEARTBEAT_INTERVAL_MS;
  }

  return true;
}

bool discoverAttendanceServer(bool force) {
  if (!WiFi.isConnected() || !mdnsActive) {
    return false;
  }

  if (!force && serverReachable && activeServerIsLocal) {
    return true;
  }

  if (
    !force &&
    millis() - lastMdnsDiscoveryAt < MDNS_DISCOVERY_INTERVAL_MS
  ) {
    return !discoveredServerUrl.isEmpty();
  }

  lastMdnsDiscoveryAt = millis();
  Serial.println("[MDNS] Searching for attendance server...");

  // Preferred method: the PC/server advertises _attendance._tcp.
  const int serviceCount = MDNS.queryService("attendance", "tcp");
  for (int index = 0; index < serviceCount; index++) {
    const IPAddress serviceIp = MDNS.address(index);
    const uint16_t servicePort = MDNS.port(index);
    const String serviceHost = MDNS.hostname(index);

    if (applyDiscoveredServer(serviceIp, servicePort, serviceHost)) {
      return true;
    }
  }

  // Fallback method: resolve gms-attendance.local (configurable).
  const String normalizedHost = normalizeMdnsHostname(mdnsServerHost);
  const IPAddress hostIp =
      MDNS.queryHost(normalizedHost.c_str(), MDNS_QUERY_TIMEOUT_MS);

  if (applyDiscoveredServer(hostIp, 3000, normalizedHost)) {
    return true;
  }

  Serial.println("[MDNS] No server found; using configured SERVER_URL fallback.");
  return false;
}

void advertiseMdns() {
  if (!WiFi.isConnected() || !mdnsActive) {
    return;
  }

  if (millis() - lastMdnsAdvertisedAt < MDNS_UPDATE_INTERVAL_MS) {
    return;
  }

  // ESPmDNS continues advertising automatically after begin()/addService().
  lastMdnsAdvertisedAt = millis();
}

void startMdns() {
  if (!WiFi.isConnected() || mdnsActive) {
    return;
  }

  const String hostname = deviceMdnsHostname();
  if (MDNS.begin(hostname.c_str())) {
    MDNS.addService("http", "tcp", WEB_ADMIN_PORT);
    MDNS.addService("gms-device", "tcp", WEB_ADMIN_PORT);
    MDNS.addServiceTxt("gms-device", "tcp", "deviceId", deviceId.c_str());
    MDNS.addServiceTxt("gms-device", "tcp", "version", FIRMWARE_VERSION);
    MDNS.addServiceTxt("gms-device", "tcp", "location", deviceLocation.c_str());
    mdnsActive = true;
    lastMdnsAdvertisedAt = 0;
    lastMdnsDiscoveryAt = 0;
    Serial.println(String("[MDNS] Device available at http://") + hostname + ".local/");
    discoverAttendanceServer(true);
  } else {
    mdnsActive = false;
    Serial.println("[MDNS] Failed to start.");
  }
}

void stopMdns() {
  if (!mdnsActive) {
    return;
  }

  MDNS.end();
  mdnsActive = false;
  Serial.println("[MDNS] Stopped.");
}

void maintainMdns() {
  if (WiFi.isConnected() && !mdnsActive) {
    startMdns();
  }

  if (!WiFi.isConnected()) {
    stopMdns();
    discoveredServerUrl = "";
    resolvedServerHost = "";
    return;
  }

  advertiseMdns();
  discoverAttendanceServer(false);
}

// =====================================================
// PREFERENCES-BASED CONFIG
// =====================================================

Preferences devicePreferences;

bool settingValueIsTrue(String value) {
  value.trim();
  value.toUpperCase();
  return value == "1" || value == "TRUE" || value == "YES" || value == "ON" || value == "ENABLE" || value == "ENABLED";
}

void loadDeviceConfig() {
  devicePreferences.begin("gms-config", true);

  const String savedServerUrl = devicePreferences.getString("server_url", "");
  const String savedCloudUrl = devicePreferences.getString("cloud_url", "");
  const String savedDeviceId = devicePreferences.getString("device_id", "");
  const String savedLocation = devicePreferences.getString("location", "");
  const String savedWifiSsid = devicePreferences.getString("wifi_ssid", "");
  const String savedWifiPassword = devicePreferences.getString("wifi_pass", "");
  const String savedMdnsHost = devicePreferences.getString("mdns_host", "");
  const String savedOtaPassword = devicePreferences.getString("ota_pass", "");
  const String savedWebUser = devicePreferences.getString("web_user", "");
  const String savedWebPassword = devicePreferences.getString("web_pass", "");
  const String savedMqttHost = devicePreferences.getString("mqtt_host", "");
  const String savedMqttUser = devicePreferences.getString("mqtt_user", "");
  const String savedMqttPassword = devicePreferences.getString("mqtt_pass", "");
  const String savedMqttTopic = devicePreferences.getString("mqtt_topic", "");

  webAdminEnabled = devicePreferences.getBool("web_enabled", webAdminEnabled);
  otaEnabled = devicePreferences.getBool("ota_enabled", otaEnabled);
  mqttEnabled = devicePreferences.getBool("mqtt_enabled", mqttEnabled);
  mqttPort = static_cast<uint16_t>(devicePreferences.getUInt("mqtt_port", mqttPort));

  devicePreferences.end();

  if (!savedServerUrl.isEmpty()) serverUrl = savedServerUrl;
  if (!savedCloudUrl.isEmpty()) cloudApiUrl = savedCloudUrl;
  if (!savedDeviceId.isEmpty()) deviceId = savedDeviceId;
  if (!savedLocation.isEmpty()) deviceLocation = savedLocation;
  if (!savedWifiSsid.isEmpty()) wifiSsid = savedWifiSsid;
  if (!savedWifiPassword.isEmpty()) wifiPassword = savedWifiPassword;
  if (!savedMdnsHost.isEmpty()) mdnsServerHost = savedMdnsHost;
  if (!savedOtaPassword.isEmpty()) otaPassword = savedOtaPassword;
  if (!savedWebUser.isEmpty()) webAdminUsername = savedWebUser;
  if (!savedWebPassword.isEmpty()) webAdminPassword = savedWebPassword;
  if (!savedMqttHost.isEmpty()) mqttHost = savedMqttHost;
  if (!savedMqttUser.isEmpty()) mqttUsername = savedMqttUser;
  if (!savedMqttPassword.isEmpty()) mqttPassword = savedMqttPassword;
  if (!savedMqttTopic.isEmpty()) mqttTopicPrefix = savedMqttTopic;

  activeApiUrl = effectiveLocalServerUrl() + "/api/attendance/scan";
}

void requestRemoteServicesRestart() {
  remoteServicesRestartRequested = true;
  lastRemoteServiceAttemptAt = 0;
}

bool updateConfigSetting(
    const String& rawKey,
    const String& rawValue,
    String& resultMessage
) {
  String key = rawKey;
  String value = rawValue;
  key.trim();
  key.toUpperCase();
  value.trim();

  if (key.isEmpty()) {
    resultMessage = "Missing configuration key.";
    return false;
  }

  devicePreferences.begin("gms-config", false);
  bool recognized = true;
  bool reconnectWifi = false;
  bool restartRemoteServices = false;
  bool resetLocalRoute = false;

  if (key == "SERVER_URL") {
    if (!value.startsWith("http://") && !value.startsWith("https://")) {
      recognized = false;
      resultMessage = "SERVER_URL must start with http:// or https://";
    } else {
      serverUrl = value;
      devicePreferences.putString("server_url", serverUrl);
      resetLocalRoute = true;
    }
  } else if (key == "CLOUD_URL") {
    if (!value.startsWith("http://") && !value.startsWith("https://")) {
      recognized = false;
      resultMessage = "CLOUD_URL must start with http:// or https://";
    } else {
      cloudApiUrl = value;
      devicePreferences.putString("cloud_url", cloudApiUrl);
    }
  } else if (key == "DEVICE_ID") {
    if (value.isEmpty()) {
      recognized = false;
      resultMessage = "DEVICE_ID cannot be empty.";
    } else {
      deviceId = value;
      devicePreferences.putString("device_id", deviceId);
      restartRequested = true;
      restartRequestedAt = millis();
    }
  } else if (key == "LOCATION") {
    deviceLocation = value;
    devicePreferences.putString("location", deviceLocation);
    restartRemoteServices = true;
  } else if (key == "WIFI_SSID") {
    if (value.isEmpty()) {
      recognized = false;
      resultMessage = "WIFI_SSID cannot be empty.";
    } else {
      wifiSsid = value;
      devicePreferences.putString("wifi_ssid", wifiSsid);
      reconnectWifi = true;
    }
  } else if (key == "WIFI_PASS") {
    wifiPassword = value;
    devicePreferences.putString("wifi_pass", wifiPassword);
    reconnectWifi = true;
  } else if (key == "MDNS_SERVER_HOST") {
    mdnsServerHost = normalizeMdnsHostname(value);
    devicePreferences.putString("mdns_host", mdnsServerHost);
    discoveredServerUrl = "";
    lastMdnsDiscoveryAt = 0;
  } else if (key == "OTA_PASSWORD") {
    if (value.length() < 8) {
      recognized = false;
      resultMessage = "OTA_PASSWORD must be at least 8 characters.";
    } else {
      otaPassword = value;
      devicePreferences.putString("ota_pass", otaPassword);
      restartRemoteServices = true;
    }
  } else if (key == "OTA_ENABLED") {
    otaEnabled = settingValueIsTrue(value);
    devicePreferences.putBool("ota_enabled", otaEnabled);
    restartRemoteServices = true;
  } else if (key == "WEB_ENABLED") {
    webAdminEnabled = settingValueIsTrue(value);
    devicePreferences.putBool("web_enabled", webAdminEnabled);
  } else if (key == "WEB_USER") {
    webAdminUsername = value;
    devicePreferences.putString("web_user", webAdminUsername);
  } else if (key == "WEB_PASSWORD") {
    if (value.length() < 8) {
      recognized = false;
      resultMessage = "WEB_PASSWORD must be at least 8 characters.";
    } else {
      webAdminPassword = value;
      devicePreferences.putString("web_pass", webAdminPassword);
    }
  } else if (key == "MQTT_ENABLED") {
    mqttEnabled = settingValueIsTrue(value);
    devicePreferences.putBool("mqtt_enabled", mqttEnabled);
  } else if (key == "MQTT_HOST") {
    mqttHost = value;
    devicePreferences.putString("mqtt_host", mqttHost);
  } else if (key == "MQTT_PORT") {
    const long parsedPort = value.toInt();
    if (parsedPort < 1 || parsedPort > 65535) {
      recognized = false;
      resultMessage = "MQTT_PORT must be from 1 to 65535.";
    } else {
      mqttPort = static_cast<uint16_t>(parsedPort);
      devicePreferences.putUInt("mqtt_port", mqttPort);
    }
  } else if (key == "MQTT_USER") {
    mqttUsername = value;
    devicePreferences.putString("mqtt_user", mqttUsername);
  } else if (key == "MQTT_PASSWORD") {
    mqttPassword = value;
    devicePreferences.putString("mqtt_pass", mqttPassword);
  } else if (key == "MQTT_TOPIC") {
    mqttTopicPrefix = value;
    while (mqttTopicPrefix.endsWith("/")) {
      mqttTopicPrefix.remove(mqttTopicPrefix.length() - 1);
    }
    devicePreferences.putString("mqtt_topic", mqttTopicPrefix);
  } else {
    recognized = false;
    resultMessage = "Unknown configuration key.";
  }

  devicePreferences.end();

  if (!recognized) {
    return false;
  }

#if GMS_MQTT_LIBRARY_AVAILABLE
  if (key.startsWith("MQTT_") && mqttClient.connected()) {
    mqttClient.disconnect();
  }
#endif

  if (resetLocalRoute) {
    discoveredServerUrl = "";
    serverReachable = false;
    activeApiUrl = effectiveLocalServerUrl() + "/api/attendance/scan";
    lastHeartbeatAttempt = millis() - DISCONNECTED_HEARTBEAT_INTERVAL_MS;
  }

  if (restartRemoteServices) {
    requestRemoteServicesRestart();
  }

  if (reconnectWifi) {
    Serial.println("[CONFIG] WiFi settings changed; reconnect scheduled.");
    serverReachable = false;
    discoveredServerUrl = "";
    wifiReconnectRequested = true;
    wifiReconnectRequestedAt = millis();
  }

  lastConfigSaveAt = millis();
  resultMessage = key + " saved.";
  Serial.print("[CONFIG] ");
  Serial.println(resultMessage);
  return true;
}

// Compatibility wrappers retained so existing calls and server-side commands do
// not lose behavior. New code should call updateConfigSetting().
void applyDeviceConfig() {
  String message;
  if (!pendingServerUrl.isEmpty()) updateConfigSetting("SERVER_URL", pendingServerUrl, message);
  if (!pendingCloudUrl.isEmpty()) updateConfigSetting("CLOUD_URL", pendingCloudUrl, message);
  if (!pendingDeviceId.isEmpty()) updateConfigSetting("DEVICE_ID", pendingDeviceId, message);
  if (!pendingDeviceLocation.isEmpty()) updateConfigSetting("LOCATION", pendingDeviceLocation, message);
  if (!pendingWifiSsid.isEmpty()) updateConfigSetting("WIFI_SSID", pendingWifiSsid, message);
  if (!pendingWifiPassword.isEmpty()) updateConfigSetting("WIFI_PASS", pendingWifiPassword, message);

  pendingServerUrl = "";
  pendingCloudUrl = "";
  pendingDeviceId = "";
  pendingDeviceLocation = "";
  pendingWifiSsid = "";
  pendingWifiPassword = "";
  configDirty = false;
}

void saveConfigIfDirty() {
  if (!configDirty) return;
  applyDeviceConfig();
}

void queueConfigUpdate(
  const String& newServerUrl,
  const String& newCloudUrl,
  const String& newDeviceId,
  const String& newLocation,
  const String& newWifiSsid,
  const String& newWifiPassword
) {
  if (!newServerUrl.isEmpty()) pendingServerUrl = newServerUrl;
  if (!newCloudUrl.isEmpty()) pendingCloudUrl = newCloudUrl;
  if (!newDeviceId.isEmpty()) pendingDeviceId = newDeviceId;
  if (!newLocation.isEmpty()) pendingDeviceLocation = newLocation;
  if (!newWifiSsid.isEmpty()) pendingWifiSsid = newWifiSsid;
  if (!newWifiPassword.isEmpty()) pendingWifiPassword = newWifiPassword;
  configDirty = true;
  applyDeviceConfig();
}

// =====================================================
// EMPLOYEE NAME CACHE
// =====================================================

Preferences employeeCachePrefs;
const char* EMPLOYEE_CACHE_INDEX_KEY = "_ids";

String loadEmployeeCacheIndex() {
  employeeCachePrefs.begin("emp-cache", true);
  const String index =
      employeeCachePrefs.getString(EMPLOYEE_CACHE_INDEX_KEY, "");
  employeeCachePrefs.end();
  return index;
}

bool cacheIndexContains(const String& index, uint16_t fingerprintId) {
  const String token = String(fingerprintId);
  int start = 0;

  while (start < index.length()) {
    int separator = index.indexOf(',', start);
    if (separator < 0) separator = index.length();

    String current = index.substring(start, separator);
    current.trim();
    if (current == token) return true;

    start = separator + 1;
  }

  return false;
}

void rememberEmployeeCacheId(uint16_t fingerprintId) {
  employeeCachePrefs.begin("emp-cache", false);
  String index =
      employeeCachePrefs.getString(EMPLOYEE_CACHE_INDEX_KEY, "");

  if (!cacheIndexContains(index, fingerprintId)) {
    if (!index.isEmpty()) index += ',';
    index += String(fingerprintId);
    employeeCachePrefs.putString(EMPLOYEE_CACHE_INDEX_KEY, index);
  }

  employeeCachePrefs.end();
}

String getEmployeeName(uint16_t fingerprintId) {
  employeeCachePrefs.begin("emp-cache", true);
  const String key = String(fingerprintId);
  const String name = employeeCachePrefs.getString(key.c_str(), "");
  employeeCachePrefs.end();
  return name;
}

void cacheEmployeeName(uint16_t fingerprintId, const String& fullName) {
  employeeCachePrefs.begin("emp-cache", false);
  const String key = String(fingerprintId);
  employeeCachePrefs.putString(key.c_str(), fullName);
  employeeCachePrefs.end();
  rememberEmployeeCacheId(fingerprintId);

  Serial.print("[CACHE] Cached name for ID ");
  Serial.print(fingerprintId);
  Serial.print(": ");
  Serial.println(fullName);
}

void clearEmployeeCache() {
  employeeCachePrefs.begin("emp-cache", false);
  employeeCachePrefs.clear();
  employeeCachePrefs.end();
  Serial.println("[CACHE] Cleared all cached names.");
}

size_t countCachedEmployees() {
  const String index = loadEmployeeCacheIndex();
  size_t count = 0;
  int start = 0;

  while (start < index.length()) {
    int separator = index.indexOf(',', start);
    if (separator < 0) separator = index.length();

    String token = index.substring(start, separator);
    token.trim();
    if (!token.isEmpty()) count++;

    start = separator + 1;
  }

  return count;
}

void printCachedEmployeeNames() {
  const String index = loadEmployeeCacheIndex();
  int start = 0;

  if (index.isEmpty()) {
    Serial.println("  (none indexed yet)");
    return;
  }

  while (start < index.length()) {
    int separator = index.indexOf(',', start);
    if (separator < 0) separator = index.length();

    String token = index.substring(start, separator);
    token.trim();

    if (!token.isEmpty()) {
      const uint16_t id = static_cast<uint16_t>(token.toInt());
      Serial.print("  ID ");
      Serial.print(id);
      Serial.print(": ");
      Serial.println(getEmployeeName(id));
    }

    start = separator + 1;
  }
}

void loadEmployeeCache() {
  const size_t count = countCachedEmployees();
  Serial.print("[CACHE] Loaded ");
  Serial.print(count);
  Serial.println(" cached employee names.");
}

String cachedNameOrUnknown(uint16_t fingerprintId) {
  const String cached = getEmployeeName(fingerprintId);
  if (!cached.isEmpty()) {
    return cached;
  }
  return String("ID: ") + String(fingerprintId);
}

// =====================================================
// WEB ADMIN INTERFACE
// =====================================================

String htmlEscape(const String& input) {
  String output = input;
  output.replace("&", "&amp;");
  output.replace("<", "&lt;");
  output.replace(">", "&gt;");
  output.replace("\"", "&quot;");
  output.replace("'", "&#39;");
  return output;
}

bool requireWebAdminAuthentication() {
  if (webAdminUsername.isEmpty() || webAdminPassword.isEmpty()) {
    return true;
  }

  if (webServer.authenticate(
        webAdminUsername.c_str(),
        webAdminPassword.c_str()
      )) {
    return true;
  }

  webServer.requestAuthentication();
  return false;
}

String buildStatusJson() {
  JsonDocument document;
  document["deviceId"] = deviceId;
  document["location"] = deviceLocation;
  document["firmwareVersion"] = FIRMWARE_VERSION;
  document["uptimeSeconds"] = millis() / 1000UL;
  document["wifiConnected"] = WiFi.isConnected();
  document["wifiSsid"] = WiFi.SSID();
  document["wifiRssi"] = WiFi.isConnected() ? WiFi.RSSI() : 0;
  document["deviceIp"] = WiFi.localIP().toString();
  document["serverReachable"] = serverReachable;
  document["activeServer"] = activeServerIsLocal ? "LOCAL" : "CLOUD";
  document["effectiveLocalServerUrl"] = effectiveLocalServerUrl();
  document["discoveredServerUrl"] = discoveredServerUrl;
  document["lastHttpStatus"] = lastServerStatusCode;
  document["pendingAttendance"] = countPendingRecords();
  document["pendingEnrollment"] = countPendingEnrollmentRequests();
  document["cachedEmployees"] = countCachedEmployees();
  document["fingerprintReady"] = fingerprintReady;
  document["fingerprintTemplates"] = finger.templateCount;
  document["rtcReady"] = rtcReady;
  document["currentTime"] = rtcReady ? formatTimestamp(rtc.now()) : String("RTC unavailable");
  document["ntpSynced"] = ntpSynced;
  document["rtcDriftSeconds"] = ntpDriftSeconds;
  document["oledReady"] = oledReady;
  document["storage"] = offlineStorageName();
  document["microSd"] = microSdStatus;
  document["microSdCode"] = microSdCode;
  document["microSdDetail"] = microSdDetail;
  document["microSdReady"] = microSdReady;
  document["freeHeap"] = ESP.getFreeHeap();
  document["minimumFreeHeap"] = ESP.getMinFreeHeap();
  document["mdnsHostname"] = deviceMdnsHostname() + ".local";
  document["otaEnabled"] = otaEnabled;
  document["otaStarted"] = otaStarted;
  document["webAdminEnabled"] = webAdminEnabled;
  document["mqttEnabled"] = mqttEnabled;
  document["mqttLibraryAvailable"] = GMS_MQTT_LIBRARY_AVAILABLE == 1;
#if GMS_MQTT_LIBRARY_AVAILABLE
  document["mqttConnected"] = mqttClient.connected();
#else
  document["mqttConnected"] = false;
#endif

  String json;
  serializeJson(document, json);
  return json;
}

String webPageHeader(const String& title) {
  String html;
  html.reserve(1800);
  html += F("<!doctype html><html><head><meta charset='utf-8'>");
  html += F("<meta name='viewport' content='width=device-width,initial-scale=1'>");
  html += F("<style>body{font-family:Arial,sans-serif;max-width:980px;margin:24px auto;padding:0 14px;background:#f5f7fb;color:#172033}nav a{margin-right:12px}section{background:white;border-radius:14px;padding:18px;margin:14px 0;box-shadow:0 3px 14px #0001}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.card{background:#f7f8fc;border:1px solid #e3e6ef;border-radius:10px;padding:12px}.ok{color:#087f5b}.bad{color:#c92a2a}input,select{width:100%;box-sizing:border-box;padding:10px;margin:5px 0 12px;border:1px solid #ccd2df;border-radius:8px}button{padding:10px 15px;border:0;border-radius:8px;background:#5b3df5;color:white;cursor:pointer}.danger{background:#c92a2a}small{color:#667085}code{word-break:break-all}</style>");
  html += "<title>" + htmlEscape(title) + "</title></head><body>";
  html += "<h1>GMS Attendance Device</h1><nav>";
  html += F("<a href='/'>Status</a><a href='/config'>Config</a><a href='/logs'>Logs</a><a href='/enroll'>Enroll</a><a href='/api/status'>JSON</a></nav>");
  return html;
}

String webPageFooter() {
  return F("</body></html>");
}

void handleWebRoot() {
  if (!requireWebAdminAuthentication()) return;

  String html = webPageHeader("Device Status");
  html.reserve(7000);
  html += "<section><h2>Connection</h2><div class='grid'>";
  html += "<div class='card'><b>Wi-Fi</b><br><span class='" + String(WiFi.isConnected() ? "ok" : "bad") + "'>" + String(WiFi.isConnected() ? "Connected" : "Disconnected") + "</span><br>" + htmlEscape(WiFi.SSID()) + "<br>RSSI: " + String(WiFi.isConnected() ? WiFi.RSSI() : 0) + " dBm</div>";
  html += "<div class='card'><b>Device IP</b><br><code>" + WiFi.localIP().toString() + "</code><br><small>http://" + htmlEscape(deviceMdnsHostname()) + ".local/</small></div>";
  html += "<div class='card'><b>Attendance Server</b><br><span class='" + String(serverReachable ? "ok" : "bad") + "'>" + String(serverReachable ? "Reachable" : "Unavailable") + "</span><br><code>" + htmlEscape(activeApiUrl) + "</code></div>";
  html += "<div class='card'><b>Route</b><br>" + String(activeServerIsLocal ? "Local LAN" : "Cloud") + "<br>HTTP " + String(lastServerStatusCode) + "</div></div></section>";

  html += "<section><h2>Hardware</h2><div class='grid'>";
  html += "<div class='card'><b>R503</b><br>" + String(fingerprintReady ? "Ready" : "Not ready") + "<br>Templates: " + String(finger.templateCount) + "</div>";
  html += "<div class='card'><b>RTC / NTP</b><br>" + htmlEscape(rtcReady ? formatTimestamp(rtc.now()) : String("RTC unavailable")) + "<br>Drift: " + String(ntpDriftSeconds, 1) + " sec</div>";
  html += "<div class='card'><b>Storage</b><br>" + String(offlineStorageName()) + "<br>SD: " + htmlEscape(microSdCode + " " + microSdStatus) + "<br><small>" + htmlEscape(microSdDetail) + "</small></div>";
  html += "<div class='card'><b>Memory</b><br>Free: " + String(ESP.getFreeHeap()) + " bytes<br>Minimum: " + String(ESP.getMinFreeHeap()) + "</div></div></section>";

  html += "<section><h2>Queues and Services</h2><div class='grid'>";
  html += "<div class='card'><b>Attendance pending</b><br>" + String(countPendingRecords()) + "</div>";
  html += "<div class='card'><b>Enrollment pending</b><br>" + String(countPendingEnrollmentRequests()) + "</div>";
  html += "<div class='card'><b>Employee cache</b><br>" + String(countCachedEmployees()) + " names</div>";
  html += "<div class='card'><b>Remote services</b><br>Web: " + String(webAdminStarted ? "ON" : "OFF") + "<br>OTA: " + String(otaStarted ? "ON" : "OFF") + "<br>MQTT: ";
#if GMS_MQTT_LIBRARY_AVAILABLE
  html += String(mqttClient.connected() ? "CONNECTED" : (mqttEnabled ? "DISCONNECTED" : "OFF"));
#else
  html += String(mqttEnabled ? "LIBRARY MISSING" : "OFF");
#endif
  html += "</div></div></section>";

  html += F("<section><form method='post' action='/discover'><button>Discover server now</button></form><br><form method='post' action='/restart'><button class='danger'>Restart device</button></form></section>");
  html += webPageFooter();
  webServer.send(200, "text/html", html);
}

void handleWebStatusJson() {
  if (!requireWebAdminAuthentication()) return;
  webServer.send(200, "application/json", buildStatusJson());
}

void handleWebLogs() {
  if (!requireWebAdminAuthentication()) return;

  String html = webPageHeader("Offline Logs");
  html += "<section><h2>Offline queues</h2><p>Attendance records waiting: <b>" + String(countPendingRecords()) + "</b></p>";
  html += "<p>Enrollment requests waiting: <b>" + String(countPendingEnrollmentRequests()) + "</b></p>";
  html += "<p>Storage backend: <b>" + String(offlineStorageName()) + "</b></p>";
  html += F("<form method='post' action='/clear-logs' onsubmit=\"return confirm('Clear all offline logs?')\"><button class='danger'>Clear offline logs</button></form></section>");
  html += webPageFooter();
  webServer.send(200, "text/html", html);
}

void handleWebConfigGet() {
  if (!requireWebAdminAuthentication()) return;

  String html = webPageHeader("Configuration");
  html.reserve(9000);
  html += F("<section><h2>Device configuration</h2><form method='post' action='/config'>");
  html += "<label>Local server URL</label><input name='server_url' value='" + htmlEscape(serverUrl) + "'>";
  html += "<label>Cloud scan API URL</label><input name='cloud_url' value='" + htmlEscape(cloudApiUrl) + "'>";
  html += "<label>mDNS server host</label><input name='mdns_host' value='" + htmlEscape(mdnsServerHost) + "'><small>Resolves as .local and also searches _attendance._tcp.</small>";
  html += "<label>Device ID</label><input name='device_id' value='" + htmlEscape(deviceId) + "'>";
  html += "<label>Location</label><input name='location' value='" + htmlEscape(deviceLocation) + "'>";
  html += "<label>Wi-Fi SSID</label><input name='wifi_ssid' value='" + htmlEscape(wifiSsid) + "'>";
  html += F("<label>New Wi-Fi password</label><input type='password' name='wifi_pass' placeholder='Leave blank to keep current password'>");

  html += "<label>Web Admin enabled</label><select name='web_enabled'><option value='1'" + String(webAdminEnabled ? " selected" : "") + ">Enabled</option><option value='0'" + String(!webAdminEnabled ? " selected" : "") + ">Disabled</option></select>";
  html += "<label>Web username</label><input name='web_user' value='" + htmlEscape(webAdminUsername) + "'>";
  html += F("<label>New Web password</label><input type='password' name='web_pass' placeholder='Leave blank to keep current password'>");

  html += "<label>OTA enabled</label><select name='ota_enabled'><option value='1'" + String(otaEnabled ? " selected" : "") + ">Enabled</option><option value='0'" + String(!otaEnabled ? " selected" : "") + ">Disabled</option></select>";
  html += F("<label>New OTA password</label><input type='password' name='ota_pass' placeholder='Leave blank to keep current password'>");

  html += "<label>MQTT enabled</label><select name='mqtt_enabled'><option value='1'" + String(mqttEnabled ? " selected" : "") + ">Enabled</option><option value='0'" + String(!mqttEnabled ? " selected" : "") + ">Disabled</option></select>";
  html += "<label>MQTT host</label><input name='mqtt_host' value='" + htmlEscape(mqttHost) + "'>";
  html += "<label>MQTT port</label><input name='mqtt_port' type='number' value='" + String(mqttPort) + "'>";
  html += "<label>MQTT username</label><input name='mqtt_user' value='" + htmlEscape(mqttUsername) + "'>";
  html += F("<label>New MQTT password</label><input type='password' name='mqtt_pass' placeholder='Leave blank to keep current password'>");
  html += "<label>MQTT topic prefix</label><input name='mqtt_topic' value='" + htmlEscape(mqttTopicPrefix) + "'>";
  html += F("<button>Save configuration</button></form><p><small>Wi-Fi changes reconnect automatically. Device ID, OTA password, and mDNS changes restart remote services.</small></p></section>");
  html += webPageFooter();
  webServer.send(200, "text/html", html);
}

void handleWebConfigPost() {
  if (!requireWebAdminAuthentication()) return;

  String messages = "";
  String result;
  auto applyArgument = [&](const char* argument, const char* key, bool allowEmpty) {
    if (!webServer.hasArg(argument)) return;
    const String value = webServer.arg(argument);
    if (!allowEmpty && value.isEmpty()) return;
    if (updateConfigSetting(key, value, result)) {
      messages += result + " ";
    } else {
      messages += "ERROR: " + result + " ";
    }
  };

  applyArgument("server_url", "SERVER_URL", false);
  applyArgument("cloud_url", "CLOUD_URL", false);
  applyArgument("mdns_host", "MDNS_SERVER_HOST", false);
  applyArgument("device_id", "DEVICE_ID", false);
  applyArgument("location", "LOCATION", true);
  applyArgument("wifi_ssid", "WIFI_SSID", false);
  applyArgument("wifi_pass", "WIFI_PASS", false);
  applyArgument("web_enabled", "WEB_ENABLED", false);
  applyArgument("web_user", "WEB_USER", true);
  applyArgument("web_pass", "WEB_PASSWORD", false);
  applyArgument("ota_enabled", "OTA_ENABLED", false);
  applyArgument("ota_pass", "OTA_PASSWORD", false);
  applyArgument("mqtt_enabled", "MQTT_ENABLED", false);
  applyArgument("mqtt_host", "MQTT_HOST", true);
  applyArgument("mqtt_port", "MQTT_PORT", false);
  applyArgument("mqtt_user", "MQTT_USER", true);
  applyArgument("mqtt_pass", "MQTT_PASSWORD", false);
  applyArgument("mqtt_topic", "MQTT_TOPIC", false);

  String html = webPageHeader("Configuration Saved");
  html += "<section><h2>Configuration result</h2><p>" + htmlEscape(messages) + "</p><p><a href='/config'>Back to configuration</a></p></section>";
  html += webPageFooter();
  webServer.send(200, "text/html", html);
}

void handleWebEnrollGet() {
  if (!requireWebAdminAuthentication()) return;

  String html = webPageHeader("Fingerprint Enrollment");
  html += F("<section><h2>Start enrollment</h2><p>After pressing Start, go to the terminal and follow the OLED prompts.</p><form method='post' action='/enroll'><label>Fingerprint ID</label><input type='number' min='1' max='1000' name='id' placeholder='Leave blank for first available ID'><button>Start enrollment</button></form></section>");
  html += webPageFooter();
  webServer.send(200, "text/html", html);
}

void handleWebEnrollPost() {
  if (!requireWebAdminAuthentication()) return;

  int requestedId = -1;
  if (webServer.hasArg("id") && !webServer.arg("id").isEmpty()) {
    requestedId = webServer.arg("id").toInt();
    if (requestedId < 1 || requestedId > 1000) {
      webServer.send(400, "text/plain", "Fingerprint ID must be 1 to 1000.");
      return;
    }
  }

  pendingWebEnrollmentId = requestedId;
  webServer.send(202, "text/plain", "Enrollment queued. Follow the OLED and R503 prompts.");
}

void handleWebClearLogs() {
  if (!requireWebAdminAuthentication()) return;
  clearOfflineLogs();
  webServer.sendHeader("Location", "/logs");
  webServer.send(303, "text/plain", "Logs cleared.");
}

void handleWebDiscover() {
  if (!requireWebAdminAuthentication()) return;
  const bool found = discoverAttendanceServer(true);
  webServer.sendHeader("Location", "/");
  webServer.send(303, "text/plain", found ? "Server discovered." : "No mDNS server found.");
}

void handleWebRestart() {
  if (!requireWebAdminAuthentication()) return;
  restartRequested = true;
  restartRequestedAt = millis();
  webServer.send(202, "text/plain", "Device restart scheduled.");
}

void setupWebAdminRoutes() {
  if (webRoutesConfigured) return;

  webServer.on("/", HTTP_GET, handleWebRoot);
  webServer.on("/api/status", HTTP_GET, handleWebStatusJson);
  webServer.on("/logs", HTTP_GET, handleWebLogs);
  webServer.on("/config", HTTP_GET, handleWebConfigGet);
  webServer.on("/config", HTTP_POST, handleWebConfigPost);
  webServer.on("/enroll", HTTP_GET, handleWebEnrollGet);
  webServer.on("/enroll", HTTP_POST, handleWebEnrollPost);
  webServer.on("/clear-logs", HTTP_POST, handleWebClearLogs);
  webServer.on("/discover", HTTP_POST, handleWebDiscover);
  webServer.on("/restart", HTTP_POST, handleWebRestart);
  webServer.onNotFound([]() {
    if (!requireWebAdminAuthentication()) return;
    webServer.send(404, "text/plain", "Not found");
  });

  webRoutesConfigured = true;
}

void startWebAdmin() {
  if (webAdminStarted || !webAdminEnabled || !WiFi.isConnected()) return;
  setupWebAdminRoutes();
  webServer.begin();
  webAdminStarted = true;
  Serial.print("[WEB] Admin interface: http://");
  Serial.print(WiFi.localIP());
  Serial.println("/");
}

void stopWebAdmin() {
  if (!webAdminStarted) return;
  webServer.stop();
  webAdminStarted = false;
  Serial.println("[WEB] Admin interface stopped.");
}

void maintainWebAdmin() {
  if (!WiFi.isConnected() || !webAdminEnabled) {
    stopWebAdmin();
    return;
  }

  startWebAdmin();
  if (webAdminStarted) {
    webServer.handleClient();
  }
}

void maintainPendingWebActions() {
  if (pendingWebEnrollmentId != 0 && !feedbackActive && !syncInProgress) {
    int enrollmentId = pendingWebEnrollmentId;
    pendingWebEnrollmentId = 0;

    if (enrollmentId < 0) {
      enrollmentId = firstAvailableFingerprintId();
    }

    if (enrollmentId < 1) {
      showErrorFeedback("R503 memory is full.");
    } else {
      enrollFingerprint(static_cast<uint16_t>(enrollmentId));
    }
  }

  if (
    wifiReconnectRequested &&
    millis() - wifiReconnectRequestedAt >= 750
  ) {
    wifiReconnectRequested = false;
    Serial.println("[WIFI] Applying saved WiFi settings now.");
    stopOtaService();
    stopWebAdmin();
    stopMdns();
    WiFi.disconnect();
    delay(50);
    startWiFiConnection();
  }

  if (restartRequested && millis() - restartRequestedAt >= 1500) {
    Serial.println("[SYSTEM] Restarting to apply configuration.");
    delay(50);
    ESP.restart();
  }
}

// =====================================================
// OTA FIRMWARE UPDATES
// =====================================================

void startOtaService() {
  if (otaStarted || !otaEnabled || !WiFi.isConnected()) return;

  const String otaHostname = deviceMdnsHostname();
  ArduinoOTA.setMdnsEnabled(false);  // ESPmDNS is managed by this firmware.
  ArduinoOTA.setPort(OTA_PORT);
  ArduinoOTA.setHostname(otaHostname.c_str());
  if (!otaPassword.isEmpty()) {
    ArduinoOTA.setPassword(otaPassword.c_str());
  }

  ArduinoOTA.onStart([]() {
    syncInProgress = true;
    feedbackActive = true;
    setRgb(false, true, true);
    r503CyanBreathing();
    showOledScreen("OTA UPDATE", "RECEIVING FIRMWARE", "DO NOT POWER OFF", "", "");
    Serial.println("[OTA] Firmware update started.");
  });

  ArduinoOTA.onEnd([]() {
    Serial.println("[OTA] Update complete; restarting.");
  });

  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    const unsigned int percent = total > 0 ? (progress * 100U) / total : 0;
    showOledScreen("OTA UPDATE", String(percent) + "%", "DO NOT POWER OFF", "", "");
    esp_task_wdt_reset();
  });

  ArduinoOTA.onError([](ota_error_t error) {
    syncInProgress = false;
    feedbackActive = false;
    Serial.print("[OTA] Error: ");
    Serial.println(static_cast<unsigned int>(error));
    showErrorFeedback("OTA update failed.");
  });

  ArduinoOTA.begin();
  otaStarted = true;
  Serial.print("[OTA] Ready: ");
  Serial.print(otaHostname);
  Serial.print(".local:");
  Serial.println(OTA_PORT);
}

void stopOtaService() {
  if (!otaStarted) return;
  ArduinoOTA.end();
  otaStarted = false;
  Serial.println("[OTA] Service stopped.");
}

void maintainOtaService() {
  if (!WiFi.isConnected() || !otaEnabled) {
    stopOtaService();
    return;
  }

  startOtaService();
  if (otaStarted) {
    ArduinoOTA.handle();
  }
}

// =====================================================
// MQTT TELEMETRY (OPTIONAL PUBSUBCLIENT INTEGRATION)
// =====================================================

String mqttTopic(const String& suffix) {
  String prefix = mqttTopicPrefix;
  while (prefix.endsWith("/")) prefix.remove(prefix.length() - 1);
  return prefix + "/" + deviceMdnsHostname() + "/" + suffix;
}

bool publishMqttMessage(
    const String& suffix,
    const String& payload,
    bool retained = false
) {
#if GMS_MQTT_LIBRARY_AVAILABLE
  if (!mqttEnabled || !mqttClient.connected()) return false;
  const String topic = mqttTopic(suffix);
  return mqttClient.publish(topic.c_str(), payload.c_str(), retained);
#else
  (void)suffix;
  (void)payload;
  (void)retained;
  return false;
#endif
}

void publishMqttStatus() {
  publishMqttMessage("status", buildStatusJson(), true);
}

void publishMqttScanEvent(
    uint16_t fingerprintId,
    uint16_t confidence,
    const String& resultCode,
    const String& fullName
) {
  JsonDocument document;
  document["eventId"] = String(deviceId) + "-mqtt-" + String(millis());
  document["deviceId"] = deviceId;
  document["location"] = deviceLocation;
  document["fingerprintId"] = fingerprintId;
  document["confidence"] = confidence;
  document["result"] = resultCode;
  document["fullName"] = fullName;
  document["timestamp"] = rtcReady ? formatTimestamp(rtc.now()) : String("");
  document["serverReachable"] = serverReachable;

  String payload;
  serializeJson(document, payload);
  publishMqttMessage("scan", payload, false);
}

void maintainMqtt() {
#if GMS_MQTT_LIBRARY_AVAILABLE
  if (!mqttEnabled || mqttHost.isEmpty() || !WiFi.isConnected()) {
    if (mqttClient.connected()) mqttClient.disconnect();
    return;
  }

  mqttClient.setServer(mqttHost.c_str(), mqttPort);
  mqttClient.setBufferSize(1536);

  if (!mqttClient.connected()) {
    if (millis() - lastMqttReconnectAt < MQTT_RECONNECT_INTERVAL_MS) return;
    lastMqttReconnectAt = millis();

    const String clientId = deviceMdnsHostname() + "-" + String(static_cast<uint32_t>(ESP.getEfuseMac()), HEX);
    bool connected = false;
    if (mqttUsername.isEmpty()) {
      connected = mqttClient.connect(clientId.c_str());
    } else {
      connected = mqttClient.connect(
        clientId.c_str(),
        mqttUsername.c_str(),
        mqttPassword.c_str()
      );
    }

    Serial.print("[MQTT] Connection: ");
    Serial.println(connected ? "CONNECTED" : "FAILED");
    if (connected) {
      lastMqttTelemetryAt = 0;
      publishMqttMessage("availability", "online", true);
    }
  }

  if (!mqttClient.connected()) return;
  mqttClient.loop();

  if (millis() - lastMqttTelemetryAt >= MQTT_TELEMETRY_INTERVAL_MS) {
    lastMqttTelemetryAt = millis();
    publishMqttStatus();
  }
#else
  static bool missingLibraryNoticeShown = false;
  if (mqttEnabled && !missingLibraryNoticeShown) {
    missingLibraryNoticeShown = true;
    Serial.println("[MQTT] PubSubClient library is not installed; MQTT is disabled until it is added.");
  }
#endif
}

void maintainRemoteServices() {
  if (!WiFi.isConnected()) {
    stopOtaService();
    stopWebAdmin();
    stopMdns();
    return;
  }

  if (
    remoteServicesRestartRequested &&
    millis() - lastRemoteServiceAttemptAt >= REMOTE_SERVICE_RETRY_MS
  ) {
    lastRemoteServiceAttemptAt = millis();
    stopOtaService();
    stopMdns();
    remoteServicesRestartRequested = false;
  }

  maintainMdns();
  maintainWebAdmin();
  maintainOtaService();
  maintainMqtt();
  maintainPendingWebActions();
}

String displayNameOrNeedRegister(const ApiResponse& response, uint16_t fingerprintId = 0) {
  String name = response.fullName;
  name.trim();

  if (!name.isEmpty()) {
    return name;
  }

  if (fingerprintId > 0) {
    const String cached = getEmployeeName(fingerprintId);
    if (!cached.isEmpty()) {
      return cached;
    }
  }

  return "NOT REGISTERED";
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
    const DateTime& scanTime,
    uint16_t fingerprintId
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
      displayNameOrNeedRegister(response, fingerprintId);

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

bool isFingerprintRateLimited(
    uint16_t fingerprintId,
    unsigned long& remainingMs
) {
  const unsigned long now = millis();
  int reusableSlot = -1;
  int oldestSlot = 0;
  unsigned long oldestAge = 0;

  for (uint8_t index = 0; index < FINGERPRINT_COOLDOWN_SLOTS; index++) {
    FingerprintCooldownEntry& entry = fingerprintCooldowns[index];

    if (entry.fingerprintId == fingerprintId) {
      const unsigned long elapsed = now - entry.recordedAt;
      if (elapsed < PER_FINGERPRINT_COOLDOWN_MS) {
        remainingMs = PER_FINGERPRINT_COOLDOWN_MS - elapsed;
        return true;
      }

      entry.recordedAt = now;
      remainingMs = 0;
      return false;
    }

    if (entry.fingerprintId == 0 && reusableSlot < 0) {
      reusableSlot = index;
    }

    const unsigned long age = now - entry.recordedAt;
    if (age >= oldestAge) {
      oldestAge = age;
      oldestSlot = index;
    }
  }

  const int targetSlot = reusableSlot >= 0 ? reusableSlot : oldestSlot;
  fingerprintCooldowns[targetSlot].fingerprintId = fingerprintId;
  fingerprintCooldowns[targetSlot].recordedAt = now;
  remainingMs = 0;
  return false;
}

void showRateLimitFeedback(
    uint16_t fingerprintId,
    unsigned long remainingMs
) {
  const unsigned long remainingSeconds = (remainingMs + 999UL) / 1000UL;
  setRgb(true, true, false);
  r503YellowFlash();
  buzzerTone(950, 90);
  beginFeedback(1800);

  showLiveScanStage(
    "PLEASE WAIT",
    cachedNameOrUnknown(fingerprintId),
    String("TRY IN ") + String(remainingSeconds) + " SEC",
    "ANTI-SPAM ACTIVE"
  );

  Serial.print("[RATE LIMIT] Fingerprint ID ");
  Serial.print(fingerprintId);
  Serial.print(" blocked for another ");
  Serial.print(remainingSeconds);
  Serial.println(" second(s).");
}

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
  setRgb(true, false, true);    // external RGB stays purple during capture
  r503PurpleBreathing();           // R503 breathes while finger is detected

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
  setRgb(false, false, true);   // external RGB stays blue while image is processed
  sendFingerprintScanStatus("IMAGE_CAPTURED");
  r503BlueBreathing();             // R503 breathes while converting the image
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
  setRgb(false, true, false);   // external RGB stays green after local match
  r503GreenBreathing();            // R503 breathes until recording begins
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
    Serial.println("[R503] Same finger repeated inside 3-second guard.");
    showRateLimitFeedback(fingerprintId, DUPLICATE_FINGER_DELAY_MS);
    return;
  }

  unsigned long remainingCooldownMs = 0;
  if (isFingerprintRateLimited(fingerprintId, remainingCooldownMs)) {
    showRateLimitFeedback(fingerprintId, remainingCooldownMs);
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

  // Only attempt live delivery when the most recent heartbeat says a server
  // is reachable. Otherwise save immediately and synchronize later.
  if (WiFi.status() == WL_CONNECTED && serverReachable) {
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
        if (!response.fullName.isEmpty() && response.accepted) {
          cacheEmployeeName(fingerprintId, response.fullName);
        }
        showApiFeedback(
          response,
          currentTime,
          fingerprintId
        );
        publishMqttScanEvent(
          fingerprintId,
          confidence,
          response.code,
          response.fullName
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
        publishMqttScanEvent(
          fingerprintId,
          confidence,
          "SERVER_RECEIVED",
          cachedNameOrUnknown(fingerprintId)
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
  setRgb(true, true, false);    // external RGB stays yellow while writing offline
  r503YellowBreathing();           // R503 breathes during offline storage write

  const bool offlineSaved =
      saveRecordOffline(scanJson);

  if (offlineSaved) {
    // Remember that a replay is required. It will run immediately after the
    // heartbeat confirms that local or cloud service is reachable again.
    pendingSyncRequested = true;
    showOfflineFeedback(fingerprintId);
    publishMqttScanEvent(
      fingerprintId,
      confidence,
      "OFFLINE_SAVED",
      cachedNameOrUnknown(fingerprintId)
    );
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
  Serial.println("SDTEST          - rerun detailed MicroSD diagnostics");
  Serial.println("TIME            - show RTC time and NTP drift");
  Serial.println("NTP             - force NTP time sync");
  Serial.println("MDNS            - show mDNS and discovered server");
  Serial.println("DISCOVER        - force mDNS server discovery");
  Serial.println("WEB             - show Web Admin address");
  Serial.println("OTA             - show OTA status");
  Serial.println("MQTT            - show MQTT status");
  Serial.println("CONFIG          - show current config");
  Serial.println("CONFIG SET <K> <V> - save any supported setting");
  Serial.println("RESTART         - restart the device");
  Serial.println("NAMES           - show cached employee name count");
  Serial.println("NAMES LIST      - list all cached employee names");
  Serial.println("NAME <id> <name>- cache employee name for offline display");
  Serial.println("CLEAR NAMES     - clear all cached employee names");
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
    Serial.print("[STATUS] MicroSD code: ");
    Serial.println(microSdCode);
    Serial.print("[STATUS] MicroSD status: ");
    Serial.println(microSdStatus);
    Serial.print("[STATUS] MicroSD detail: ");
    Serial.println(microSdDetail);
    Serial.print("[STATUS] MicroSD read/write: ");
    Serial.println(microSdReady ? "VERIFIED" : "NOT AVAILABLE");
    Serial.print("[STATUS] LittleFS ready: ");
    Serial.println(littleFsReady ? "YES" : "NO");

    showOledStatus(
      String("SD: ") + microSdCode,
      microSdStatus,
      String("Storage: ") + offlineStorageName(),
      String("Flash: ") + (littleFsReady ? "OK" : "FAILED")
    );

    return;
  }

  if (upperCommand == "SDTEST") {
    Serial.println();
    Serial.println("========== MICROSD DIAGNOSTIC ==========");
    const bool sdOkay = initializeMicroSdStorage();

    if (!sdOkay && littleFsReady) {
      useMicroSdStorage = false;
      Serial.println("[SD DIAG] LittleFS fallback remains active.");
    }

    Serial.print("[SD DIAG] Final code: ");
    Serial.println(microSdCode);
    Serial.print("[SD DIAG] Final status: ");
    Serial.println(microSdStatus);
    Serial.print("[SD DIAG] Final detail: ");
    Serial.println(microSdDetail);
    Serial.println("========================================");

    showOledStatus(
      String("SD TEST ") + microSdCode,
      microSdStatus,
      microSdReady ? "READ/WRITE VERIFIED" : "CHECK SERIAL DETAIL",
      littleFsReady ? "LittleFS backup OK" : "NO BACKUP STORAGE"
    );

    return;
  }

  if (upperCommand == "TIME") {
    Serial.print("[RTC] Current time: ");
    Serial.println(formatTimestamp(rtc.now()));
    Serial.print("[NTP] Drift: ");
    Serial.print(ntpDriftSeconds, 1);
    Serial.println("s");
    Serial.print("[NTP] Last sync: ");
    Serial.print((millis() - lastNtpSyncAt) / 1000);
    Serial.println("s ago");
    return;
  }

  if (upperCommand == "NTP") {
    Serial.println("[NTP] Manual sync requested...");
    syncRtcWithNtp();
    return;
  }

  if (upperCommand == "MDNS") {
    Serial.print("[MDNS] Status: ");
    Serial.println(mdnsActive ? "ACTIVE" : "INACTIVE");
    Serial.print("[MDNS] Device hostname: ");
    Serial.println(deviceMdnsHostname() + ".local");
    Serial.print("[MDNS] Server host target: ");
    Serial.println(normalizeMdnsHostname(mdnsServerHost) + ".local");
    Serial.print("[MDNS] Discovered URL: ");
    Serial.println(discoveredServerUrl.isEmpty() ? "none; using configured fallback" : discoveredServerUrl);
    return;
  }

  if (upperCommand == "DISCOVER") {
    discoverAttendanceServer(true);
    return;
  }

  if (upperCommand == "WEB") {
    Serial.print("[WEB] Enabled: ");
    Serial.println(webAdminEnabled ? "YES" : "NO");
    Serial.print("[WEB] Address: http://");
    Serial.print(WiFi.localIP());
    Serial.println("/");
    return;
  }

  if (upperCommand == "OTA") {
    Serial.print("[OTA] Enabled: ");
    Serial.println(otaEnabled ? "YES" : "NO");
    Serial.print("[OTA] Service: ");
    Serial.println(otaStarted ? "READY" : "STOPPED");
    Serial.print("[OTA] Host: ");
    Serial.println(deviceMdnsHostname() + ".local");
    return;
  }

  if (upperCommand == "MQTT") {
    Serial.print("[MQTT] Library: ");
    Serial.println(GMS_MQTT_LIBRARY_AVAILABLE ? "AVAILABLE" : "MISSING");
    Serial.print("[MQTT] Enabled: ");
    Serial.println(mqttEnabled ? "YES" : "NO");
    Serial.print("[MQTT] Broker: ");
    Serial.print(mqttHost);
    Serial.print(":");
    Serial.println(mqttPort);
#if GMS_MQTT_LIBRARY_AVAILABLE
    Serial.print("[MQTT] Connected: ");
    Serial.println(mqttClient.connected() ? "YES" : "NO");
#endif
    return;
  }

  if (upperCommand == "RESTART") {
    Serial.println("[SYSTEM] Restarting...");
    delay(100);
    ESP.restart();
    return;
  }

  if (upperCommand == "CONFIG") {
    Serial.println("[CONFIG] Current settings:");
    Serial.print("  Server fallback URL: "); Serial.println(serverUrl);
    Serial.print("  Discovered local URL: "); Serial.println(discoveredServerUrl.isEmpty() ? "none" : discoveredServerUrl);
    Serial.print("  Effective local URL: "); Serial.println(effectiveLocalServerUrl());
    Serial.print("  Cloud URL: "); Serial.println(cloudApiUrl);
    Serial.print("  Device ID: "); Serial.println(deviceId);
    Serial.print("  Location: "); Serial.println(deviceLocation);
    Serial.print("  WiFi SSID: "); Serial.println(wifiSsid);
    Serial.print("  WiFi IP: "); Serial.println(WiFi.localIP());
    Serial.print("  mDNS device: "); Serial.println(deviceMdnsHostname() + ".local");
    Serial.print("  mDNS server target: "); Serial.println(normalizeMdnsHostname(mdnsServerHost) + ".local");
    Serial.print("  Web Admin: "); Serial.println(webAdminEnabled ? "ENABLED" : "DISABLED");
    Serial.print("  OTA: "); Serial.println(otaEnabled ? "ENABLED" : "DISABLED");
    Serial.print("  MQTT: "); Serial.println(mqttEnabled ? "ENABLED" : "DISABLED");
    Serial.print("  MQTT broker: "); Serial.print(mqttHost); Serial.print(":"); Serial.println(mqttPort);
    Serial.print("  NTP synced: "); Serial.println(ntpSynced ? "YES" : "NO");
    return;
  }

  if (upperCommand.startsWith("CONFIG SET")) {
    String params = command.substring(String("CONFIG SET").length());
    params.trim();
    const int firstSpace = params.indexOf(' ');

    if (firstSpace <= 0) {
      Serial.println("[CONFIG] Usage: CONFIG SET <KEY> <VALUE>");
      return;
    }

    String key = params.substring(0, firstSpace);
    String value = params.substring(firstSpace + 1);
    key.trim();
    value.trim();

    String resultMessage;
    if (!updateConfigSetting(key, value, resultMessage)) {
      Serial.print("[CONFIG] ERROR: ");
      Serial.println(resultMessage);
      Serial.println("[CONFIG] Keys: SERVER_URL, CLOUD_URL, DEVICE_ID, LOCATION, WIFI_SSID, WIFI_PASS, MDNS_SERVER_HOST, WEB_ENABLED, WEB_USER, WEB_PASSWORD, OTA_ENABLED, OTA_PASSWORD, MQTT_ENABLED, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD, MQTT_TOPIC");
    }
    return;
  }

  if (upperCommand == "NAMES") {
    const size_t count = countCachedEmployees();
    Serial.print("[CACHE] Cached employee names: ");
    Serial.println(count);
    showOledStatus(
      "EMPLOYEE CACHE",
      String("Cached: ") + String(count),
      "Use NAMES LIST",
      "or CLEAR NAMES"
    );
    return;
  }

  if (upperCommand == "NAMES LIST") {
    Serial.println("[CACHE] Cached names:");
    printCachedEmployeeNames();
    return;
  }

  if (upperCommand == "CLEAR NAMES") {
    clearEmployeeCache();
    showOledStatus(
      "CACHE CLEARED",
      "All names removed",
      "Re-scan to rebuild",
      ""
    );
    return;
  }

  if (upperCommand.startsWith("NAME ")) {
    String params = command.substring(5);
    params.trim();
    int spaceIdx = params.indexOf(' ');
    if (spaceIdx > 0) {
      uint16_t id = params.substring(0, spaceIdx).toInt();
      String name = params.substring(spaceIdx + 1);
      if (id > 0 && !name.isEmpty()) {
        cacheEmployeeName(id, name);
        showOledStatus(
          "NAME CACHED",
          String("ID: ") + String(id),
          name,
          "Saved offline"
        );
      } else {
        Serial.println("[CACHE] Usage: NAME <id> <full name>");
      }
    } else {
      Serial.println("[CACHE] Usage: NAME <id> <full name>");
    }
    return;
  }

  Serial.println("[R503] Unknown command. Type HELP.");
}


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

  loadDeviceConfig();
  loadEmployeeCache();
  setupWebAdminRoutes();

  Serial.println("[CONFIG] Loaded device configuration from Preferences.");
  Serial.print("[CONFIG] Server fallback URL: ");
  Serial.println(serverUrl);
  Serial.print("[CONFIG] Device ID: ");
  Serial.println(deviceId);
  Serial.print("[CONFIG] Location: ");
  Serial.println(deviceLocation);
  Serial.print("[CONFIG] mDNS server host: ");
  Serial.println(normalizeMdnsHostname(mdnsServerHost) + ".local");

  waitForInitialWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    maintainRemoteServices();
    discoverAttendanceServer(true);
    syncRtcWithNtp();
  }

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
  saveConfigIfDirty();
  maintainFeedbackState();
  maintainOledProtection();
  maintainFingerprintRecovery();
  if (
    fingerprintReady &&
    millis() - lastFingerprintPollAt >= FINGERPRINT_POLL_INTERVAL_MS
  ) {
    lastFingerprintPollAt = millis();
    uint16_t fingerprintId = 0;
    uint16_t confidence = 0;
    if (readFingerprintMatch(fingerprintId, confidence)) {
      processFingerprint(fingerprintId, confidence);
    }
  }

  maintainRemoteServices();
  maintainNtpSync();

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

  const unsigned long heartbeatInterval =
      serverReachable
        ? HEARTBEAT_INTERVAL_MS
        : DISCONNECTED_HEARTBEAT_INTERVAL_MS;

  if (
    WiFi.status() == WL_CONNECTED &&
    !feedbackActive &&
    !syncInProgress &&
    millis() - lastHeartbeatAttempt >= heartbeatInterval
  ) {
    sendReaderHeartbeat();
    lastHeartbeatAttempt = millis();
  }

  // Replay pending attendance before display-command polling. Previously the
  // display poll ran first and could repeatedly activate feedback, postponing
  // the offline queue replay.
  if (
    WiFi.status() == WL_CONNECTED &&
    serverReachable &&
    !feedbackActive &&
    !syncInProgress &&
    (
      pendingSyncRequested ||
      millis() - lastSyncAttempt >= SYNC_INTERVAL_MS
    )
  ) {
    pendingSyncRequested = false;
    lastSyncAttempt = millis();
    synchronizePendingRecords();
    synchronizePendingEnrollmentRequests();
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

  if (millis() - lastHeapLogAt >= HEAP_LOG_INTERVAL_MS) {
    lastHeapLogAt = millis();
    Serial.printf("[MEMORY] Free heap: %u bytes; minimum: %u bytes.\n", ESP.getFreeHeap(), ESP.getMinFreeHeap());
  }

  esp_task_wdt_reset();
  yield();
}