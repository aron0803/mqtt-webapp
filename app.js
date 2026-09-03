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

// QR 掃描相關元素
const btnScan = document.getElementById('btn-scan');
const btnScanCancel = document.getElementById('btn-scan-cancel');
const btnScanFile = document.getElementById('btn-scan-file');
const scanFileInput = document.getElementById('scan-file-input');
const scanHint = document.getElementById('scan-hint');
const scannerOverlay = document.getElementById('scanner-overlay');
const scannerVideo = document.getElementById('scanner-video');
const scannerStatus = document.getElementById('scanner-status');

// MQTT Variables
let client = null;
const TENANT_ID = 'default';
let TOPIC_CMD = '';
let TOPIC_STATE = '';
let TOPIC_STATUS = '';

// 繼電器腳位：由裝置的 retained state 回報決定並存進 localStorage，
// 換硬體、換接腳後會自動更新；尚未收到任何回報時用這個預設值只是佔位
let relayPin = parseInt(localStorage.getItem('relay_pin'), 10) || 1;

// 解碼設定字串，回傳 {b,u,p} 或 null。
// 可接受三種形式，讓「掃碼開網址」與「網頁內掃碼」共用同一種 QR：
//   1. 完整網址含 #c=<token>
//   2. 純 token（base64url 編碼的 JSON）
//   3. 直接是 JSON {"b":...,"u":...,"p":...}
function decodeConfigPayload(text) {
    if (!text) return null;
    let token = text.trim();

    const urlMatch = token.match(/[#&]c=([A-Za-z0-9_-]+)/);
    if (urlMatch) token = urlMatch[1];

    // 形式 3：直接是 JSON
    if (token.startsWith('{')) {
        try {
            const cfg = JSON.parse(token);
            return (cfg.b && cfg.u) ? cfg : null;
        } catch (e) {
            return null;
        }
    }

    if (!/^[A-Za-z0-9_-]+$/.test(token)) return null;

    try {
        let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
        base64 += '='.repeat((4 - base64.length % 4) % 4); // 補回被去掉的 padding
        // atob 產出的是 Latin-1 位元組，需再解成 UTF-8 才能正確處理非 ASCII 字元
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        const cfg = JSON.parse(new TextDecoder().decode(bytes));
        return (cfg.b && cfg.u) ? cfg : null;
    } catch (e) {
        console.error('QR config parse error:', e);
        return null;
    }
}

function encodeConfigPayload(cfg) {
    const json = JSON.stringify({ b: cfg.b, u: cfg.u, p: cfg.p || '' });
    const bytes = new TextEncoder().encode(json);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 把設定同步回網址 hash，讓「加入主畫面」不論從哪個途徑設定完成，
// 存下來的捷徑都自帶設定（iOS 捷徑存的是當下網址）。
function syncConfigToUrl(cfg) {
    try {
        history.replaceState(null, '',
            location.pathname + location.search + '#c=' + encodeConfigPayload(cfg));
    } catch (e) {
        console.error('sync config to url failed:', e);
    }
}

function saveConfig(cfg) {
    localStorage.setItem('mqtt_broker', cfg.b);
    localStorage.setItem('mqtt_user', cfg.u);
    localStorage.setItem('mqtt_pass', cfg.p || '');
    syncConfigToUrl(cfg);
}

// 從網址 hash 帶入設定。刻意使用 hash 而非 query string——hash 不會送到伺服器，
// 帳密不會進 GitHub Pages 的存取紀錄。
//
// 注意：這裡「不」清除 hash。iOS 的「加入主畫面」存的是當下網址，若先清掉 hash，
// 捷徑就只剩乾淨網址；而 iOS 獨立 App 的儲存空間與 Safari 不共用，開啟後會變成
// 未設定狀態，每次都要重設。保留 hash 才能讓捷徑自帶設定、每次開啟自動連線。
// 代價是帳密會留在網址中，因此請勿分享此網址（分享等同交出 broker 控制權）。
function applyConfigFromHash() {
    if (!location.hash.includes('c=')) return false;

    const cfg = decodeConfigPayload(location.hash);
    if (!cfg) {
        // 解析失敗才清掉，避免壞掉的字串一直卡在網址列
        history.replaceState(null, '', location.pathname + location.search);
        return false;
    }

    saveConfig(cfg);
    return true;
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

// ===== 相機掃描 QR Code =====
// 優先使用瀏覽器原生的 BarcodeDetector（Android Chrome 支援）；
// iOS Safari 尚未支援，改為延遲載入 jsQR 作為後備方案。
let scanStream = null;
let scanRafId = null;
let jsQrLoader = null;

function loadJsQr() {
    if (window.jsQR) return Promise.resolve(window.jsQR);
    if (jsQrLoader) return jsQrLoader;

    // jsQR 未上架 cdnjs，需改用 jsDelivr；unpkg 為備援來源
    const sources = [
        'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
        'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js'
    ];

    jsQrLoader = sources.reduce(
        (chain, src) => chain.catch(() => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => window.jsQR ? resolve(window.jsQR) : reject(new Error('jsQR missing'));
            s.onerror = () => reject(new Error('load failed: ' + src));
            document.head.appendChild(s);
        })),
        Promise.reject(new Error('init'))
    ).catch(err => {
        jsQrLoader = null; // 允許之後重試（例如當下沒網路）
        throw err;
    });

    return jsQrLoader;
}

function stopScanner() {
    if (scanRafId) {
        cancelAnimationFrame(scanRafId);
        scanRafId = null;
    }
    if (scanStream) {
        scanStream.getTracks().forEach(t => t.stop()); // 務必關閉，否則相機燈會一直亮著
        scanStream = null;
    }
    scannerVideo.srcObject = null;
    scannerOverlay.classList.add('hidden');
}

function onScanSuccess(text) {
    const cfg = decodeConfigPayload(text);
    if (!cfg) {
        scannerStatus.textContent = '這不是有效的設定 QR Code，請再試一次';
        scannerStatus.classList.add('error');
        return false; // 繼續掃描
    }

    stopScanner();
    saveConfig(cfg);
    inputBroker.value = cfg.b;
    inputUser.value = cfg.u;
    inputPass.value = cfg.p || '';

    scanHint.textContent = `已讀取設定：${cfg.u} @ ${cfg.b}`;
    scanHint.classList.remove('hidden', 'error');
    connectMqtt();
    return true;
}

async function startScanner() {
    scanHint.classList.add('hidden');
    scannerStatus.classList.remove('error');
    scannerStatus.textContent = '正在啟動相機…';
    scannerOverlay.classList.remove('hidden');

    // 相機需要安全來源（HTTPS 或 localhost），http 網址會直接沒有 mediaDevices
    if (!navigator.mediaDevices?.getUserMedia) {
        scannerStatus.textContent = '此瀏覽器不支援相機，或網頁不是以 HTTPS 開啟';
        scannerStatus.classList.add('error');
        return;
    }

    try {
        scanStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment' }, // 優先使用後鏡頭
            audio: false
        });
    } catch (e) {
        console.error('getUserMedia error:', e);
        scannerStatus.textContent = (e.name === 'NotAllowedError')
            ? '相機權限被拒絕，請於瀏覽器設定中允許後再試'
            : '無法開啟相機：' + e.name;
        scannerStatus.classList.add('error');
        return;
    }

    scannerVideo.srcObject = scanStream;
    await scannerVideo.play();
    scannerStatus.textContent = '請將 QR Code 對準框內';

    let detector = null;
    if ('BarcodeDetector' in window) {
        try {
            detector = new BarcodeDetector({ formats: ['qr_code'] });
        } catch (e) {
            detector = null;
        }
    }

    let jsQR = null;
    let canvas = null;
    let ctx = null;
    if (!detector) {
        try {
            jsQR = await loadJsQr();
        } catch (e) {
            scannerStatus.textContent = '無法載入掃描元件，請改用手動輸入';
            scannerStatus.classList.add('error');
            return;
        }
        canvas = document.createElement('canvas');
        ctx = canvas.getContext('2d', { willReadFrequently: true });
    }

    const tick = async () => {
        if (!scanStream) return; // 已取消

        if (scannerVideo.readyState === scannerVideo.HAVE_ENOUGH_DATA) {
            try {
                if (detector) {
                    const codes = await detector.detect(scannerVideo);
                    if (codes.length && onScanSuccess(codes[0].rawValue)) return;
                } else {
                    canvas.width = scannerVideo.videoWidth;
                    canvas.height = scannerVideo.videoHeight;
                    ctx.drawImage(scannerVideo, 0, 0, canvas.width, canvas.height);
                    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(img.data, img.width, img.height);
                    if (code && onScanSuccess(code.data)) return;
                }
            } catch (e) {
                console.error('scan error:', e);
            }
        }
        scanRafId = requestAnimationFrame(tick);
    };
    scanRafId = requestAnimationFrame(tick);
}

btnScan.addEventListener('click', startScanner);
btnScanCancel.addEventListener('click', stopScanner);

// 從相簿/檔案讀取 QR：適合截圖存下的 QR、桌機沒相機、或相機權限被拒的情況
btnScanFile.addEventListener('click', () => scanFileInput.click());

scanFileInput.addEventListener('change', async () => {
    const file = scanFileInput.files && scanFileInput.files[0];
    scanFileInput.value = ''; // 清空，允許選同一張圖也能觸發下一次 change
    if (!file) return;

    scanHint.textContent = '正在辨識圖片中的 QR Code…';
    scanHint.classList.remove('hidden', 'error');

    try {
        const bitmap = await loadImageFile(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let text = null;

        // 優先用原生 BarcodeDetector（多數 Android Chrome 支援，速度較快）
        if ('BarcodeDetector' in window) {
            try {
                const detector = new BarcodeDetector({ formats: ['qr_code'] });
                const codes = await detector.detect(bitmap);
                if (codes.length) text = codes[0].rawValue;
            } catch (e) { /* 退回 jsQR */ }
        }

        if (!text) {
            const jsQR = await loadJsQr();
            const code = jsQR(img.data, img.width, img.height);
            if (code) text = code.data;
        }

        if (!text) {
            scanHint.textContent = '這張圖片裡沒有偵測到 QR Code，請換一張';
            scanHint.classList.add('error');
            return;
        }

        // onScanSuccess 失敗時只會更新相機覆蓋層自己的 scannerStatus，但這裡
        // 沒有開啟覆蓋層（不是用相機掃的），因此失敗要另外在 scanHint 顯示
        if (!onScanSuccess(text)) {
            scanHint.textContent = '這不是有效的設定 QR Code，請確認圖片內容';
            scanHint.classList.add('error');
        }
    } catch (e) {
        console.error('QR image decode error:', e);
        scanHint.textContent = '無法讀取這張圖片，請確認格式後再試一次';
        scanHint.classList.add('error');
    }
});

// 將使用者選取的圖片檔載入成可畫進 canvas 的 bitmap；
// createImageBitmap 效能較好，不支援的瀏覽器退回傳統 <img> 載入方式
function loadImageFile(file) {
    if (window.createImageBitmap) {
        return createImageBitmap(file);
    }
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
    });
}

// Save settings and connect
btnConnect.addEventListener('click', () => {
    // 走 saveConfig 統一入口，設定才會一併同步到網址，供「加入主畫面」使用
    saveConfig({ b: inputBroker.value, u: inputUser.value, p: inputPass.value });
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
                localStorage.setItem('relay_pin', String(relayPin)); // 供一鍵開門頁 (open.html) 使用
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
