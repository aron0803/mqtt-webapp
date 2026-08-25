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

// Load saved settings
function loadSettings() {
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
            if (data.pin === 0) {
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
        pin: 0, // ESP-01 繼電器控制腳位 (GPIO0)
        val: isChecked ? 1 : 0
    });
    
    const message = new Paho.MQTT.Message(payload);
    message.destinationName = TOPIC_CMD;
    client.send(message);
});

// Initialize
loadSettings();
