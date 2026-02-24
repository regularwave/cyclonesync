import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getDatabase, ref, set, onValue, onDisconnect, remove, get, child } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-database.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app-check.js";

const firebaseConfig = {
    apiKey: "AIzaSyCDGTGx59Z544DL68GYp0oyFVH5HBoGb9k",
    authDomain: "pod-seat-sync.firebaseapp.com",
    databaseURL: "https://pod-seat-sync-default-rtdb.firebaseio.com",
    projectId: "pod-seat-sync",
    storageBucket: "pod-seat-sync.firebasestorage.app",
    messagingSenderId: "642393168612",
    appId: "1:642393168612:web:a71f366f02dc7bf7842af1"
};

const app = initializeApp(firebaseConfig);

const appCheck = initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider('6LeGOHAsAAAAAMnZ24eMR7WqAJ2ZIXzFZE5bYSUx'),
    isTokenAutoRefreshEnabled: true
});

const db = getDatabase(app);

const AppState = {
    settings: { life: true, tax: false, taxSplit: false, awake: true, layoutLR: false },
    roomId: null,
    playerId: 'player_' + Math.random().toString(36).substr(2, 9),
    roomListener: null,
    debounceTimer: null,
    isSyncLocked: false,
    html5QrcodeScanner: null,
    wakeLock: null,
    exitTimer: null,
    pipsOpen: false,
    pipsMask: ['white', 'blue', 'black', 'red', 'green', 'colorless']
};

function getStored(key, defaultValue = null) {
    const val = localStorage.getItem(key);
    return val !== null ? val : defaultValue;
}

function setStored(key, value) {
    localStorage.setItem(key, value);
}

document.addEventListener('DOMContentLoaded', () => {

    document.querySelectorAll('.quantity, .cmd-name-input').forEach(input => {
        const saved = localStorage.getItem('cyclonesync_tracker_' + input.id);
        if (saved !== null) input.value = saved;
    });

    for (let i = 1; i <= 4; i++) {
        const savedName = localStorage.getItem(`name-p${i}`);
        if (savedName) {
            const nameInput = document.getElementById(`name-p${i}`);
            if (nameInput) nameInput.value = savedName;
        }
    }

    loadSettings();

    const pipsBtn = document.getElementById('btn-pips');
    let pressTimer;
    let isLongPress = false;

    pipsBtn.addEventListener('pointerdown', (e) => {
        isLongPress = false;
        pressTimer = setTimeout(() => {
            isLongPress = true;
            openPipsModal();
            if (navigator.vibrate) navigator.vibrate(50);
        }, 600);
    });

    pipsBtn.addEventListener('pointerup', (e) => {
        if (pressTimer) clearTimeout(pressTimer);
        if (!isLongPress) {
            const controls = document.querySelector('.controls-row');
            if (controls) {
                controls.style.pointerEvents = 'none';
                setTimeout(() => controls.style.pointerEvents = 'auto', 400);
            }
            togglePips();
        }
        isLongPress = false;
    });

    pipsBtn.addEventListener('pointercancel', () => {
        if (pressTimer) clearTimeout(pressTimer);
        isLongPress = true;
    });

    const taxBtn = document.getElementById('btn-tax');
    let taxPressTimer;
    let taxIsLongPress = false;

    taxBtn.addEventListener('pointerdown', (e) => {
        taxIsLongPress = false;
        taxPressTimer = setTimeout(() => {
            taxIsLongPress = true;
            toggleTaxSplit();
            if (navigator.vibrate) navigator.vibrate(50);
        }, 600);
    });

    taxBtn.addEventListener('pointerup', (e) => {
        if (taxPressTimer) clearTimeout(taxPressTimer);
        if (!taxIsLongPress) {
            toggleTax();
        }
        taxIsLongPress = false;
    });

    taxBtn.addEventListener('pointercancel', () => {
        if (taxPressTimer) clearTimeout(taxPressTimer);
        taxIsLongPress = true;
    });

    if (AppState.settings.awake) {
        requestWakeLock();
    }

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
            localStorage.setItem('cyclonesync_last_backgrounded', Date.now());
        } else if (document.visibilityState === 'visible') {
            if (AppState.settings.awake) requestWakeLock();
            triggerSymbolFade();

            if (AppState.roomId) {
                const lastBackgrounded = localStorage.getItem('cyclonesync_last_backgrounded');
                const timeAway = lastBackgrounded ? (Date.now() - parseInt(lastBackgrounded)) : 0;
                const SESSION_TIMEOUT = 30 * 60 * 1000;

                if (timeAway > SESSION_TIMEOUT) {
                    leaveRoom(true);
                    setTimeout(async () => {
                        await customAlert("Disconnected from PodConnect: session expired due to inactivity.");
                    }, 500);
                } else {
                    if (typeof reestablishPresence === 'function') {
                        reestablishPresence();
                    }
                }
            }
        }
    });

    const allNameInputs = document.querySelectorAll('.player-name, .cmd-name-input');
    allNameInputs.forEach(input => {
        input.addEventListener('focus', function () { this.select(); });
        input.addEventListener('click', function () { this.select(); });
        input.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        });
    });

    const savedNameP1 = localStorage.getItem('name-p1');
    if (savedNameP1) document.getElementById('conn-player-name').value = savedNameP1;
    validateConnectionInputs();

    const connectedRef = ref(db, ".info/connected");
    onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
            if (AppState.roomId) {
                reestablishPresence();
            }
        }
    });

    const urlParams = new URLSearchParams(window.location.search);
    const roomFromUrl = urlParams.get('room');

    if (roomFromUrl) {
        document.getElementById('conn-room-code').value = roomFromUrl.toUpperCase();

        window.history.replaceState({}, document.title, window.location.pathname);

        const hasSavedName = document.getElementById('conn-player-name').value.trim().length > 0;

        if (hasSavedName) {
            joinRoom();
        } else {
            toggleConnectModal();
            validateConnectionInputs();
        }
    }

    history.pushState(null, '', window.location.href);

    window.addEventListener('popstate', (e) => {
        if (!document.getElementById('qr-modal').classList.contains('hidden')) {
            stopQRScan();
            history.pushState(null, '', window.location.href);
            return;
        }
        if (!document.getElementById('connect-modal').classList.contains('hidden')) {
            toggleConnectModal();
            history.pushState(null, '', window.location.href);
            return;
        }
        if (!document.getElementById('pips-modal').classList.contains('hidden')) {
            savePipsConfig();
            history.pushState(null, '', window.location.href);
            return;
        }
        if (!document.getElementById('cmd-modal').classList.contains('hidden')) {
            toggleCmdModal();
            history.pushState(null, '', window.location.href);
            return;
        }
        const shareModal = document.getElementById('share-modal');
        if (shareModal && !shareModal.classList.contains('hidden')) {
            toggleShare();
            history.pushState(null, '', window.location.href);
            return;
        }
        if (!document.getElementById('help-modal').classList.contains('hidden')) {
            toggleHelp();
            history.pushState(null, '', window.location.href);
            return;
        }
        if (!document.getElementById('credits-modal').classList.contains('hidden')) {
            toggleCredits();
            history.pushState(null, '', window.location.href);
            return;
        }

        if (AppState.exitTimer) {
            clearTimeout(AppState.exitTimer);
            history.back();
        } else {
            showExitToast();
            history.pushState(null, '', window.location.href);
            AppState.exitTimer = setTimeout(() => {
                AppState.exitTimer = null;
            }, 2000);
        }
    });
});

function toggleCredits() {
    document.getElementById('credits-modal').classList.toggle('hidden');
}

function toggleHelp() {
    document.getElementById('help-modal').classList.toggle('hidden');
}

function toggleShare() {
    document.getElementById('share-modal').classList.toggle('hidden');

    const qrContainer = document.getElementById('share-qr-display');
    if (qrContainer && qrContainer.innerHTML === "") {
        new QRCode(qrContainer, {
            text: "https://regularwave.github.io/cyclonesync/",
            width: 150,
            height: 150
        });
    }

    if (navigator.share) {
        document.getElementById('btn-native-share').classList.remove('hidden');
    }
}

function toggleCmdModal() {
    document.getElementById('cmd-modal').classList.toggle('hidden');
}

function updateValue(id, change) {
    const input = document.getElementById(id);
    let val = parseInt(input.value) || 0;
    val += change;
    saveValues(input, val);
}

let holdTimer = null;
let repeatInterval = null;
let holdDuration = 0;

function startHold(e, targetId, change, isCmd = false) {
    if (isCmd) {
        updateCmdValue(targetId, change);
    } else {
        updateValue(targetId, change);
    }
    if (navigator.vibrate) navigator.vibrate(10);

    holdDuration = 0;

    holdTimer = setTimeout(() => {
        repeatInterval = setInterval(() => {
            holdDuration += 100;

            const multiplier = holdDuration >= 2000 ? 5 : 1;
            const finalChange = change * multiplier;

            if (isCmd) {
                updateCmdValue(targetId, finalChange);
            } else {
                updateValue(targetId, finalChange);
            }

            if (navigator.vibrate) navigator.vibrate(5);
        }, 100);
    }, 400);
}

function stopHold() {
    if (holdTimer) clearTimeout(holdTimer);
    if (repeatInterval) clearInterval(repeatInterval);
    holdTimer = null;
    repeatInterval = null;
}

function saveValues(input, val) {
    if (val < 0) val = 0;
    if (val > 999) val = 999;
    input.value = val;
    setStored('cyclonesync_tracker_' + input.id, val);

    if (AppState.roomId && input.id === 'life') {
        syncLifeToRoom(val);
    }
}

function updateCmdValue(id, change) {
    const cmdInput = document.getElementById(id);
    let cmdVal = parseInt(cmdInput.value) || 0;

    if (cmdVal + change < 0) return;

    cmdVal += change;
    saveValues(cmdInput, cmdVal);

    const lifeInput = document.getElementById('life');
    let lifeVal = parseInt(lifeInput.value) || 0;
    lifeVal -= change;
    saveValues(lifeInput, lifeVal);
}

async function resetAll() {
    if (!(await customConfirm("Are you sure you want to reset?"))) return;

    const allInputs = document.querySelectorAll('.quantity');
    allInputs.forEach(input => {
        const defaultVal = (input.id === 'life') ? 40 : 0;
        input.value = defaultVal;
        localStorage.setItem('cyclonesync_tracker_' + input.id, defaultVal);

        if (input.id === 'life') {
            syncLifeToRoom(defaultVal, true);
        }
    });
    if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
}

function savePlayerName(input) {
    setStored(input.id, input.value);
}

function saveCmdName(input) {
    setStored('cyclonesync_tracker_' + input.id, input.value);
}

function loadSettings() {
    const savedSettings = getStored('cyclonesync_settings');
    if (savedSettings) AppState.settings = JSON.parse(savedSettings);

    AppState.pipsOpen = getStored('cyclonesync_tracker_pipsOpen') === 'true';

    const savedMask = getStored('cyclonesync_tracker_pipsMask');
    if (savedMask) {
        try { AppState.pipsMask = JSON.parse(savedMask); }
        catch (e) { AppState.pipsMask = ['white', 'blue', 'black', 'red', 'green', 'colorless']; }
    }

    applySettings();
    updateManaGrid();
    triggerSymbolFade();
}

function saveSettings() {
    setStored('cyclonesync_settings', JSON.stringify(AppState.settings));
    setStored('cyclonesync_tracker_pipsOpen', AppState.pipsOpen);
    setStored('cyclonesync_tracker_pipsMask', JSON.stringify(AppState.pipsMask));
}

function applySettings() {
    const topRow = document.getElementById('top-row');
    const tileLife = document.getElementById('tile-life');
    const btnLife = document.getElementById('btn-life');
    const tileTax = document.getElementById('tile-tax');
    const btnTax = document.getElementById('btn-tax');

    if (!AppState.settings.life && !AppState.settings.tax) {
        topRow.classList.add('hidden');
    } else {
        topRow.classList.remove('hidden');
    }

    if (AppState.settings.life) {
        tileLife.classList.remove('hidden');
        btnLife.classList.remove('disabled');
    } else {
        tileLife.classList.add('hidden');
        btnLife.classList.add('disabled');
    }

    if (AppState.settings.tax) {
        tileTax.classList.remove('hidden');
        btnTax.classList.remove('disabled');
    } else {
        tileTax.classList.add('hidden');
        btnTax.classList.add('disabled');
    }

    const taxHalf2 = document.getElementById('tax-half-2');
    if (AppState.settings.taxSplit) {
        taxHalf2.classList.remove('hidden');
    } else {
        taxHalf2.classList.add('hidden');
    }

    const btnAwake = document.getElementById('btn-awake');
    const iconAwake = btnAwake.querySelector('i');
    if (AppState.settings.awake) {
        btnAwake.classList.remove('disabled');
        iconAwake.className = "ms ss-foil ss-grad ms-dfc-day";
    } else {
        btnAwake.classList.add('disabled');
        iconAwake.className = "ms ms-dfc-night";
    }

    if (AppState.settings.layoutLR) {
        document.body.classList.add('layout-lr');
    } else {
        document.body.classList.remove('layout-lr');
    }
}

function toggleLife() {
    AppState.settings.life = !AppState.settings.life;
    applySettings();
    saveSettings();
}

function toggleTax() {
    AppState.settings.tax = !AppState.settings.tax;
    applySettings();
    saveSettings();
}

function toggleTaxSplit() {
    if (!AppState.settings.tax) {
        AppState.settings.tax = true;
    }
    AppState.settings.taxSplit = !AppState.settings.taxSplit;
    applySettings();
    saveSettings();
}

function togglePips() {
    AppState.pipsOpen = !AppState.pipsOpen;
    updateManaGrid();
    saveSettings();
}

function updateManaGrid() {
    const colorMap = {
        'white': 'tile-w',
        'blue': 'tile-u',
        'black': 'tile-b',
        'red': 'tile-r',
        'green': 'tile-g',
        'colorless': 'tile-c'
    };

    let visibleTiles = [];

    Object.keys(colorMap).forEach(color => {
        const wrapperId = colorMap[color];
        const wrapper = document.getElementById(wrapperId);
        if (!wrapper) return;

        wrapper.classList.remove('span-full');

        const isManaged = AppState.pipsMask.includes(color);
        const shouldHide = isManaged && !AppState.pipsOpen;

        if (shouldHide) {
            wrapper.classList.add('hidden');
        } else {
            wrapper.classList.remove('hidden');
            visibleTiles.push(wrapper);
        }
    });

    if (visibleTiles.length % 2 !== 0) {
        const lastTile = visibleTiles[visibleTiles.length - 1];
        lastTile.classList.add('span-full');
    }

    const btn = document.getElementById('btn-pips');
    if (AppState.pipsOpen) {
        btn.classList.remove('disabled');
        btn.style.opacity = '1';
    } else {
        btn.style.opacity = '0.5';
    }
}

function openPipsModal() {
    const modal = document.getElementById('pips-modal');
    modal.classList.remove('hidden');

    const checkboxes = document.querySelectorAll('.pip-chk');
    checkboxes.forEach(chk => {
        chk.checked = AppState.pipsMask.includes(chk.value);
    });
}

function savePipsConfig() {
    const modal = document.getElementById('pips-modal');
    const checkboxes = document.querySelectorAll('.pip-chk');

    AppState.pipsMask = [];
    checkboxes.forEach(chk => {
        if (chk.checked) {
            AppState.pipsMask.push(chk.value);
        }
    });

    modal.classList.add('hidden');

    updateManaGrid();
    saveSettings();
}

function toggleConnectModal() {
    const modal = document.getElementById('connect-modal');
    modal.classList.toggle('hidden');

    if (!modal.classList.contains('hidden')) {
        validateConnectionInputs();
        checkIOSBrowserEnvironment();
    }

    if (modal.classList.contains('hidden') && AppState.html5QrcodeScanner) {
        AppState.html5QrcodeScanner.clear();
    }
}

async function toggleWakeLock() {
    AppState.settings.awake = !AppState.settings.awake;
    if (AppState.settings.awake) {
        await requestWakeLock();
    } else {
        if (AppState.wakeLock !== null) {
            await AppState.wakeLock.release();
            AppState.wakeLock = null;
        }
    }
    applySettings();
    saveSettings();
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
            if (AppState.wakeLock !== null) return;
            AppState.wakeLock = await navigator.wakeLock.request('screen');
            AppState.wakeLock.addEventListener('release', () => {
                AppState.wakeLock = null;
            });
        }
    } catch (err) {
        console.error(`${err.name}, ${err.message}`);
    }
}

function validateConnectionInputs() {
    const nameInputEl = document.getElementById('conn-player-name');
    const roomInputEl = document.getElementById('conn-room-code');
    const nameInput = nameInputEl.value.trim();
    const roomInputValue = roomInputEl.value.trim();
    const joinBtn = document.getElementById('btn-join-room');
    const scanBtn = document.getElementById('btn-scan-qr');
    const status = document.getElementById('conn-status');

    if (nameInput.length === 0) {
        nameInputEl.classList.add('needs-attention');
        roomInputEl.classList.remove('needs-attention');
    } else if (roomInputValue.length < 5) {
        nameInputEl.classList.remove('needs-attention');
        roomInputEl.classList.add('needs-attention');
    } else {
        nameInputEl.classList.remove('needs-attention');
        roomInputEl.classList.remove('needs-attention');
    }

    if (nameInput.length > 0) {
        roomInputEl.disabled = false;
        scanBtn.disabled = false;

        if (roomInputValue.length >= 5) {
            joinBtn.disabled = false;
            status.innerText = "Ready to connect!";
        } else {
            joinBtn.disabled = true;
            status.innerText = "Enter a room name (5+ chars) or scan a QR code.";
        }
    } else {
        roomInputEl.disabled = true;
        joinBtn.disabled = true;
        scanBtn.disabled = true;
        status.innerText = "Enter a name to begin.";
    }
}

async function joinRoom() {
    const nameInput = document.getElementById('conn-player-name');
    const roomInput = document.getElementById('conn-room-code');
    const status = document.getElementById('conn-status');
    const playerName = nameInput.value.trim();
    const roomId = roomInput.value.trim().toUpperCase();

    if (!playerName) {
        status.innerText = "Please enter your name.";
        return;
    }

    if (roomId.length < 5 || roomId.length > 20) {
        status.innerText = "Room name must be between 5 and 20 characters.";
        return;
    }

    status.innerText = "Connecting...";

    const roomRef = ref(db, 'rooms/' + roomId + '/players');
    const snapshot = await get(roomRef);

    if (snapshot.exists() && snapshot.size >= 4) {
        if (!snapshot.hasChild(AppState.playerId)) {
            status.innerText = "Room is full (4/4 players).";
            return;
        }
    }

    AppState.roomId = roomId;
    localStorage.setItem('name-p1', playerName);

    const p1Input = document.getElementById('name-p1');
    const p1Icon = document.getElementById('sync-icon-p1');
    if (p1Input && p1Icon) {
        p1Input.value = playerName;
        p1Input.disabled = true;
        p1Icon.classList.remove('hidden');
    }

    const myRef = ref(db, 'rooms/' + AppState.roomId + '/players/' + AppState.playerId);

    const myData = {
        name: playerName,
        life: parseInt(document.getElementById('life').value) || 40,
        lastSeen: Date.now()
    };

    set(myRef, myData);
    onDisconnect(myRef).remove();

    document.getElementById('connect-step-1').classList.add('hidden');
    document.getElementById('connect-step-2').classList.remove('hidden');
    document.getElementById('display-room-code').innerText = roomId;
    document.getElementById('room-row').classList.remove('hidden');

    const qrContainer = document.getElementById('room-qr-display');
    qrContainer.innerHTML = "";

    const joinUrl = `https://regularwave.github.io/cyclonesync/?room=${roomId}`;

    new QRCode(qrContainer, {
        text: joinUrl,
        width: 150,
        height: 150
    });

    listenToRoom();

    status.innerText = "Connected!";
}

function listenToRoom() {
    const playersRef = ref(db, 'rooms/' + AppState.roomId + '/players');

    AppState.roomListener = onValue(playersRef, (snapshot) => {
        const players = snapshot.val() || {};
        renderRemotePlayers(players);
    });
}

function renderRemotePlayers(players) {
    const container = document.getElementById('remote-players-container');
    container.innerHTML = '';

    let hasRemotePlayers = false;
    let remoteIndex = 2;

    for (let i = 2; i <= 4; i++) {
        const input = document.getElementById(`name-p${i}`);
        const icon = document.getElementById(`sync-icon-p${i}`);
        if (input && icon) {
            const savedName = localStorage.getItem(`name-p${i}`);
            input.value = savedName || `Player ${i}`;
            input.disabled = false;
            icon.classList.add('hidden');
        }
    }

    Object.keys(players).forEach(key => {
        if (key === AppState.playerId) return;

        hasRemotePlayers = true;

        const p = players[key] || {};
        const safeName = typeof p.name === 'string' ? p.name : '';
        const safeLife = (p.life === 0 || p.life) ? String(p.life) : '';

        const tile = document.createElement('div');
        tile.className = 'remote-tile';

        const nameEl = document.createElement('div');
        nameEl.className = 'remote-name';
        nameEl.textContent = safeName;

        const lifeEl = document.createElement('div');
        lifeEl.className = 'remote-life';
        lifeEl.textContent = safeLife;

        tile.appendChild(nameEl);
        tile.appendChild(lifeEl);
        container.appendChild(tile);

        if (remoteIndex <= 4) {
            const cmdInput = document.getElementById(`name-p${remoteIndex}`);
            const cmdIcon = document.getElementById(`sync-icon-p${remoteIndex}`);
            if (cmdInput && cmdIcon) {
                cmdInput.value = safeName;
                cmdInput.disabled = true;
                cmdIcon.classList.remove('hidden');
            }
            remoteIndex++;
        }
    });

    if (!hasRemotePlayers) {
        const waiting = document.createElement('span');
        waiting.className = 'waiting-text';
        waiting.textContent = 'waiting for players...';
        container.appendChild(waiting);
    }
}

function syncLifeToRoom(newLife, immediate = false) {
    if (!AppState.roomId || AppState.isSyncLocked) return;

    if (immediate) {
        clearTimeout(AppState.debounceTimer);

        const myLifeRef = ref(db, 'rooms/' + AppState.roomId + '/players/' + AppState.playerId + '/life');
        set(myLifeRef, newLife);

        AppState.isSyncLocked = true;
        setTimeout(() => { AppState.isSyncLocked = false; }, 2000);

        return;
    }

    if (AppState.debounceTimer) clearTimeout(AppState.debounceTimer);
    AppState.debounceTimer = setTimeout(() => {
        const myLifeRef = ref(db, 'rooms/' + AppState.roomId + '/players/' + AppState.playerId + '/life');
        set(myLifeRef, newLife);
    }, 500);
}

function reestablishPresence() {
    if (!AppState.roomId || !AppState.playerId) return;

    const myRef = ref(db, 'rooms/' + AppState.roomId + '/players/' + AppState.playerId);

    const myData = {
        name: document.getElementById('conn-player-name').value.trim() || localStorage.getItem('name-p1'),
        life: parseInt(document.getElementById('life').value) || 40,
        lastSeen: Date.now()
    };

    set(myRef, myData);
    onDisconnect(myRef).remove();
}

function startQRScan() {
    document.getElementById('conn-room-code').value = '';

    validateConnectionInputs();

    document.getElementById('qr-modal').classList.remove('hidden');

    AppState.html5QrcodeScanner = new Html5Qrcode("qr-reader");

    AppState.html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (decodedText, decodedResult) => {
            let scannedRoomId = decodedText;

            if (decodedText.startsWith('http')) {
                try {
                    const url = new URL(decodedText);
                    const param = url.searchParams.get('room');

                    if (param) {
                        scannedRoomId = param;
                    } else {
                        scannedRoomId = "";
                    }
                } catch (e) { console.error("Invalid URL scanned"); }
            }

            if (scannedRoomId) {
                document.getElementById('conn-room-code').value = scannedRoomId.toUpperCase();
                stopQRScan();
                joinRoom();
            } else {
                document.getElementById('conn-status').innerText = "Invalid room code scanned.";
                stopQRScan();
            }
        },
        (errorMessage) => {
        }
    ).catch(err => {
        document.getElementById('conn-status').innerText = "Camera error: " + err;
        stopQRScan();
    });
}

function stopQRScan() {
    document.getElementById('qr-modal').classList.add('hidden');
    if (AppState.html5QrcodeScanner) {
        AppState.html5QrcodeScanner.stop().then(() => {
            document.getElementById('qr-reader').innerHTML = "";
        }).catch(err => console.error("Failed to stop scanner", err));
    }
}

function showRoomQR() {
    document.getElementById('connect-modal').classList.remove('hidden');
    document.getElementById('connect-step-1').classList.add('hidden');
    document.getElementById('connect-step-2').classList.remove('hidden');
}

async function leaveRoom(force = false) {
    if (force || (await customConfirm("Disconnect from room?"))) {
        if (AppState.roomId) {
            const myRef = ref(db, 'rooms/' + AppState.roomId + '/players/' + AppState.playerId);
            remove(myRef);
        }

        if (AppState.roomListener) {
            AppState.roomListener();
            AppState.roomListener = null;
        }

        for (let i = 1; i <= 4; i++) {
            const input = document.getElementById(`name-p${i}`);
            const icon = document.getElementById(`sync-icon-p${i}`);
            if (input && icon) {
                const savedName = localStorage.getItem(`name-p${i}`);
                input.value = savedName || `Player ${i}`;
                input.disabled = false;
                icon.classList.add('hidden');
            }
        }

        AppState.roomId = null;

        document.getElementById('room-row').classList.add('hidden');
        document.getElementById('btn-connect').classList.remove('hidden');
        document.getElementById('connect-step-1').classList.remove('hidden');
        document.getElementById('connect-step-2').classList.add('hidden');

        document.getElementById('remote-players-container').innerHTML = '';

        document.getElementById('connect-modal').classList.add('hidden');

        document.getElementById('conn-status').innerText = "Enter a room name or scan a QR code.";

        validateConnectionInputs();
    }
}

function customConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const msgBox = document.getElementById('confirm-msg');
        const btnYes = document.getElementById('confirm-yes');
        const btnNo = document.getElementById('confirm-no');

        msgBox.innerText = message;
        modal.classList.remove('hidden');

        const cleanup = () => {
            modal.classList.add('hidden');
            btnYes.removeEventListener('click', onYes);
            btnNo.removeEventListener('click', onNo);
        };

        const onYes = () => { cleanup(); resolve(true); };
        const onNo = () => { cleanup(); resolve(false); };

        btnYes.addEventListener('click', onYes);
        btnNo.addEventListener('click', onNo);
    });
}

function customAlert(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('alert-modal');
        const msgBox = document.getElementById('alert-msg');
        const btnOk = document.getElementById('alert-ok');

        msgBox.innerText = message;
        modal.classList.remove('hidden');

        const cleanup = () => {
            modal.classList.add('hidden');
            btnOk.removeEventListener('click', onOk);
        };

        const onOk = () => {
            cleanup();
            resolve();
        };

        btnOk.addEventListener('click', onOk);
    });
}

function switchHelpTab(tabId) {
    const contents = document.querySelectorAll('.help-tab-content');
    contents.forEach(content => content.classList.add('hidden'));

    const buttons = document.querySelectorAll('.help-tab-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    document.getElementById(tabId).classList.remove('hidden');
    const targetBtn = Array.from(buttons).find(btn => btn.getAttribute('onclick').includes(tabId));
    if (targetBtn) targetBtn.classList.add('active');
}

function showExitToast() {
    let toast = document.getElementById('exit-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'exit-toast';
        toast.className = 'exit-toast';
        toast.innerText = "Press back again to exit";
        document.body.appendChild(toast);
    }

    toast.style.transition = 'none';
    toast.style.opacity = '1';

    void toast.offsetWidth;
    toast.style.transition = 'opacity 0.5s ease-in-out';

    setTimeout(() => {
        if (toast) toast.style.opacity = '0';
    }, 2000);
}

function toggleUDLR() {
    AppState.settings.layoutLR = !AppState.settings.layoutLR;
    applySettings();
    saveSettings();
    triggerSymbolFade();
}

function triggerSymbolFade() {
    document.body.classList.remove('symbols-hidden');

    void document.body.offsetWidth;

    document.body.classList.add('symbols-hidden');
}

function shareNatively() {
    if (navigator.share) {
        navigator.share({
            title: 'CycloneSync',
            text: 'Check out CycloneSync, a synchronized Magic: the Gathering tracker!',
            url: 'https://regularwave.github.io/cyclonesync/'
        }).catch(err => console.log('User canceled share or error:', err));
    }
}

function shareRoomLink() {
    if (!AppState.roomId) return;

    const joinUrl = `https://regularwave.github.io/cyclonesync/?room=${AppState.roomId}`;

    if (navigator.share) {
        navigator.share({
            title: 'Join my CycloneSync Pod',
            text: `Join my Magic: The Gathering pod on CycloneSync! Room code: ${AppState.roomId}`,
            url: joinUrl
        }).catch(err => console.log('User canceled share or error:', err));
    } else {
        navigator.clipboard.writeText(joinUrl).then(async () => {
            if (navigator.vibrate) navigator.vibrate(20);
            await customAlert("Room link copied to clipboard!");
        }).catch(err => {
            console.error("Clipboard copy failed", err);
        });
    }
}

function copyRoomCode() {
    if (!AppState.roomId) return;

    navigator.clipboard.writeText(AppState.roomId).then(() => {
        const display = document.getElementById('display-room-code');

        display.innerText = "COPIED!";
        display.style.color = "#4da6ff";

        setTimeout(() => {
            display.innerText = AppState.roomId;
            display.style.color = "";
        }, 1500);

        if (navigator.vibrate) navigator.vibrate(20);
    }).catch(err => {
        console.error("Clipboard copy failed", err);
    });
}

function checkIOSBrowserEnvironment() {
    const warningBox = document.getElementById('ios-pwa-warning');
    if (!warningBox) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    if (isIOS && !isStandalone) {
        warningBox.classList.remove('hidden');

        const roomCodeInput = document.getElementById('conn-room-code').value.trim();
        const codeSection = document.getElementById('ios-room-code-section');
        const codeDisplay = document.getElementById('ios-room-code-display');

        if (roomCodeInput && roomCodeInput.length >= 5) {
            codeDisplay.innerText = roomCodeInput;
            codeSection.classList.remove('hidden');
        } else {
            codeSection.classList.add('hidden');
        }
    } else {
        warningBox.classList.add('hidden');
    }
}

function copyPendingRoomCode() {
    const roomCode = document.getElementById('conn-room-code').value.trim();
    if (!roomCode) return;

    navigator.clipboard.writeText(roomCode).then(() => {
        const display = document.getElementById('ios-room-code-display');
        const originalText = display.innerText;

        display.innerText = "COPIED!";
        display.style.color = "#09a6e9";

        setTimeout(() => {
            display.innerText = originalText;
            display.style.color = "";
        }, 1500);

        if (navigator.vibrate) navigator.vibrate(20);
    }).catch(err => {
        console.error("Clipboard copy failed", err);
    });
}

Object.assign(window, {
    toggleCredits, toggleHelp, toggleShare, toggleCmdModal, toggleConnectModal,
    toggleLife, toggleTax, togglePips, toggleWakeLock, updateValue, updateCmdValue,
    resetAll, savePlayerName, saveCmdName, savePipsConfig, validateConnectionInputs,
    joinRoom, startQRScan, stopQRScan, showRoomQR, leaveRoom, switchHelpTab,
    toggleUDLR, startHold, stopHold, shareNatively, copyRoomCode, shareRoomLink,
    copyPendingRoomCode
});