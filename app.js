// DOM Elements
const modal = document.getElementById('settings-modal');
const dashboard = document.getElementById('dashboard');
const btnConnect = document.getElementById('btn-connect');
const btnSettings = document.getElementById('btn-settings');
const statusDot = document.getElementById('mqtt-status-dot');
const statusText = document.getElementById('mqtt-status-text');
const toggleBtn = document.getElementById('toggle-gpio4');
const statusLabel = document.getElementById('label-gpio4');

// Inputs
const inputBroker = document.getElementById('broker');
const inputUser = document.getElementById('username');
const inputPass = document.getElementById('password');

// MQTT Variables
let client = null;
const TENANT_ID = 'default';
let TOPIC_CMD = '';
let TOPIC_STATE = '';
let TOPIC_STATUS = '';

// 繼電器腳位：ESP32-C6 為 GPIO18、ESP-01 為 GPIO0，收到裝置 state 回報後會自動更新
let relayPin = 18;

// 從 QR Code 帶入設定：格式為 #c=<base64url 編碼的 {"b":broker,"u":user,"p":pass}>
// 刻意使用 hash 而非 query string——hash 不會送到伺服器，帳密不會進 GitHub Pages 的存取紀錄。
// 讀取後立刻清除網址中的 hash，避免帳密殘留在網址列與瀏覽歷史中。
function applyConfigFromHash() {
    const match = location.hash.match(/[#&]c=([A-Za-z0-9_-]+)/);
    if (!match) return false;

    // 無論解析成功與否都先清掉 hash，避免帳密留在網址列
    history.replaceState(null, '', location.pathname + location.search);

    try {
        const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
        // atob 產出的是 Latin-1 位元組，需再解成 UTF-8 才能正確處理非 ASCII 字元
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const cfg = JSON.parse(new TextDecoder().decode(bytes));

        if (!cfg.b || !cfg.u) return false;

        localStorage.setItem('mqtt_broker', cfg.b);
        localStorage.setItem('mqtt_user', cfg.u);
        localStorage.setItem('mqtt_pass', cfg.p || '');
        return true;
    } catch (e) {
        console.error('QR config parse error:', e);
        return false;
    }
}

// Load saved settings
function loadSettings() {
    applyConfigFromHash();

    inputBroker.value = localStorage.getItem('mqtt_broker') || '';
    inputUser.value = localStorage.getItem('mqtt_user') || '';
    inputPass.value = localStorage.getItem('mqtt_pass') || '';

    if (inputBroker.value && inputUser.value) {
        connectMqtt();
    } else {
        modal.classList.remove('hidden');
    }
}

// Save settings and connect
btnConnect.addEventListener('click', () => {
    localStorage.setItem('mqtt_broker', inputBroker.value);
    localStorage.setItem('mqtt_user', inputUser.value);
    localStorage.setItem('mqtt_pass', inputPass.value);
    connectMqtt();
});

btnSettings.addEventListener('click', () => {
    dashboard.classList.add('hidden');
    modal.classList.remove('hidden');
    if (client && client.isConnected()) {
        client.disconnect();
    }
});

// MQTT Connection Logic
function connectMqtt() {
    const broker = inputBroker.value;
    const user = inputUser.value;
    const pass = inputPass.value;
    
    if (!broker || !user) return;

    modal.classList.add('hidden');
    dashboard.classList.remove('hidden');
    
    statusText.textContent = "Connecting...";
    statusDot.className = "dot offline";

    TOPIC_CMD = `iot/v1/${TENANT_ID}/${user}/cmd`;
    TOPIC_STATE = `iot/v1/${TENANT_ID}/${user}/state`;
    TOPIC_STATUS = `iot/v1/${TENANT_ID}/${user}/status`;

    // Create client instance (Use WSS port 8884 for HiveMQ Cloud)
    const clientId = "WebApp_" + Math.random().toString(16).substr(2, 8);
    client = new Paho.MQTT.Client(broker, 8884, clientId);

    client.onConnectionLost = onConnectionLost;
    client.onMessageArrived = onMessageArrived;

    const options = {
        userName: user,
        password: pass,
        useSSL: true,
        onSuccess: onConnect,
        onFailure: onFailure
    };

    try {
        client.connect(options);
    } catch (e) {
        console.error("Connection error:", e);
        onFailure();
    }
}

function onConnect() {
    console.log("Connected to MQTT broker");
    statusText.textContent = "Connected";
    statusDot.className = "dot online";
    
    // Subscribe to state and status topics
    client.subscribe(TOPIC_STATE);
    client.subscribe(TOPIC_STATUS);
    
    // Enable controls
    toggleBtn.disabled = false;
    statusLabel.textContent = "Ready to control";
}

function onFailure(err) {
    console.error("Failed to connect:", err);
    statusText.textContent = "Failed";
    statusDot.className = "dot offline";
    toggleBtn.disabled = true;
    setTimeout(connectMqtt, 5000); // Auto reconnect
}

function onConnectionLost(responseObject) {
    if (responseObject.errorCode !== 0) {
        console.log("Connection lost:", responseObject.errorMessage);
        statusText.textContent = "Disconnected";
        statusDot.className = "dot offline";
        toggleBtn.disabled = true;
        statusLabel.textContent = "Connection lost";
        setTimeout(connectMqtt, 3000); // Auto reconnect
    }
}

function onMessageArrived(message) {
    console.log("Received:", message.destinationName, message.payloadString);
    try {
        const data = JSON.parse(message.payloadString);
        
        if (message.destinationName === TOPIC_STATUS) {
            if (data.status === 'offline') {
                statusLabel.textContent = "Device is Offline 🔴";
                statusLabel.style.color = 'var(--danger)';
            } else if (data.status === 'online') {
                statusLabel.textContent = "Device is Online 🟢";
                statusLabel.style.color = 'var(--text-secondary)';
            }
        } 
        else if (message.destinationName === TOPIC_STATE) {
            // 以裝置回報的腳位為準，避免寫死腳位在換硬體後（ESP-01 GPIO0 / ESP32-C6 GPIO18）失效
            if (typeof data.pin === 'number') {
                relayPin = data.pin;
                toggleBtn.checked = (data.state === 1);
                statusLabel.textContent = toggleBtn.checked ? "Device is ON" : "Device is OFF";
                statusLabel.style.color = 'var(--text-secondary)';
            }
        }
    } catch (e) {
        console.error("JSON parse error:", e);
    }
}

// UI Interaction
toggleBtn.addEventListener('change', (e) => {
    if (!client || !client.isConnected()) return;
    
    const isChecked = e.target.checked;
    statusLabel.textContent = "Sending command...";
    
    const payload = JSON.stringify({
        pin: relayPin, // 由裝置的 state 回報決定，未收到前用預設值
        val: isChecked ? 1 : 0
    });
    
    const message = new Paho.MQTT.Message(payload);
    message.destinationName = TOPIC_CMD;
    client.send(message);
});

// Initialize
loadSettings();
