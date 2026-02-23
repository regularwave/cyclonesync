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

let wakeLock = null;
let exitTimer = null;

let settings = {
    life: true,
    tax: false,
    taxSplit: false,
    awake: true,
    layoutLR: false
};

let currentRoomId = null;
let roomListenerUnsubscribe = null;
let myPlayerId = 'player_' + Math.random().toString(36).substr(2, 9);

let syncDebounceTimer = null;
let isSyncLocked = false;

let html5QrcodeScanner = null;

let pipsOpen = false;
let pipsMask = ['white', 'blue', 'black', 'red', 'green', 'colorless'];

document.addEventListener('DOMContentLoaded', () => {
    const inputs = document.querySelectorAll('.quantity');
    inputs.forEach(input => {
        const savedValue = localStorage.getItem('cyclonesync_tracker_' + input.id);
        if (savedValue !== null) {
            input.value = savedValue;
        }
    });

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

    if (settings.awake) {
        requestWakeLock();
    }

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
            localStorage.setItem('cyclonesync_last_backgrounded', Date.now());
        } else if (document.visibilityState === 'visible') {
            if (settings.awake) requestWakeLock();

            triggerSymbolFade();

            if (currentRoomId) {
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

    const names = ['name-p1', 'name-p2', 'name-p3', 'name-p4'];
    names.forEach(id => {
        const savedName = localStorage.getItem(id);
        if (savedName) {
            document.getElementById(id).value = savedName;
        }
    });

    const cmdNames = document.querySelectorAll('.cmd-name-input');
    cmdNames.forEach(input => {
        const savedName = localStorage.getItem('cyclonesync_tracker_' + input.id);
        if (savedName) input.value = savedName;
    });

    for (let p = 1; p <= 4; p++) {
        for (let c = 1; c <= 2; c++) {
            const id = `cmd-p${p}-c${c}`;
            const element = document.getElementById(id);
            if (element) {
                const savedVal = localStorage.getItem(id);
                if (savedVal) element.value = savedVal;
            }
        }
    }

    const allNameInputs = document.querySelectorAll('.player-name, .cmd-name-input');

    allNameInputs.forEach(input => {
        input.addEventListener('focus', function () {
            this.select();
        });
        input.addEventListener('click', function () {
            this.select();
        });
        input.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
        });
    });

    const savedName = localStorage.getItem('name-p1');
    if (savedName) document.getElementById('conn-player-name').value = savedName;
    validateConnectionInputs();

    const connectedRef = ref(db, ".info/connected");
    onValue(connectedRef, (snap) => {
        if (snap.val() === true) {
            if (currentRoomId) {
                reestablishPresence();
            }
        }
    });

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

        if (exitTimer) {
            clearTimeout(exitTimer);
            history.back();
        } else {
            showExitToast();
            history.pushState(null, '', window.location.href);
            exitTimer = setTimeout(() => {
                exitTimer = null;
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
    localStorage.setItem('cyclonesync_tracker_' + input.id, val);

    if (currentRoomId && input.id === 'life') {
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
    localStorage.setItem(input.id, input.value);
}

function saveCmdName(input) {
    localStorage.setItem('cyclonesync_tracker_' + input.id, input.value);
}

function loadSettings() {
    const savedSettings = localStorage.getItem('cyclonesync_settings');
    if (savedSettings) {
        settings = JSON.parse(savedSettings);
    }

    const savedPips = localStorage.getItem('cyclonesync_tracker_pipsOpen');
    if (savedPips !== null) {
        pipsOpen = (savedPips === 'true');
    }

    const savedMask = localStorage.getItem('cyclonesync_tracker_pipsMask');
    if (savedMask) {
        try {
            pipsMask = JSON.parse(savedMask);
        } catch (e) {
            console.error('Error parsing pips mask', e);
            pipsMask = ['white', 'blue', 'black', 'red', 'green', 'colorless'];
        }
    }

    applySettings();
    updateManaGrid();
    triggerSymbolFade();
}

function saveSettings() {
    localStorage.setItem('cyclonesync_settings', JSON.stringify(settings));
    localStorage.setItem('cyclonesync_tracker_pipsOpen', pipsOpen);
    localStorage.setItem('cyclonesync_tracker_pipsMask', JSON.stringify(pipsMask));
}

function applySettings() {
    const topRow = document.getElementById('top-row');
    const tileLife = document.getElementById('tile-life');
    const btnLife = document.getElementById('btn-life');
    const tileTax = document.getElementById('tile-tax');
    const btnTax = document.getElementById('btn-tax');

    if (!settings.life && !settings.tax) {
        topRow.classList.add('hidden');
    } else {
        topRow.classList.remove('hidden');
    }

    if (settings.life) {
        tileLife.classList.remove('hidden');
        btnLife.classList.remove('disabled');
    } else {
        tileLife.classList.add('hidden');
        btnLife.classList.add('disabled');
    }

    if (settings.tax) {
        tileTax.classList.remove('hidden');
        btnTax.classList.remove('disabled');
    } else {
        tileTax.classList.add('hidden');
        btnTax.classList.add('disabled');
    }

    const taxHalf2 = document.getElementById('tax-half-2');
    if (settings.taxSplit) {
        taxHalf2.classList.remove('hidden');
    } else {
        taxHalf2.classList.add('hidden');
    }

    const btnAwake = document.getElementById('btn-awake');
    const iconAwake = btnAwake.querySelector('i');
    if (settings.awake) {
        btnAwake.classList.remove('disabled');
        iconAwake.className = "ms ss-foil ss-grad ms-dfc-day";
    } else {
        btnAwake.classList.add('disabled');
        iconAwake.className = "ms ms-dfc-night";
    }

    if (settings.layoutLR) {
        document.body.classList.add('layout-lr');
    } else {
        document.body.classList.remove('layout-lr');
    }
}

function toggleLife() {
    settings.life = !settings.life;
    applySettings();
    saveSettings();
}

function toggleTax() {
    settings.tax = !settings.tax;
    applySettings();
    saveSettings();
}

function toggleTaxSplit() {
    if (!settings.tax) {
        settings.tax = true;
    }
    settings.taxSplit = !settings.taxSplit;
    applySettings();
    saveSettings();
}

function togglePips() {
    pipsOpen = !pipsOpen;
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

        const isManaged = pipsMask.includes(color);
        const shouldHide = isManaged && !pipsOpen;

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
    if (pipsOpen) {
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
        chk.checked = pipsMask.includes(chk.value);
    });
}

function savePipsConfig() {
    const modal = document.getElementById('pips-modal');
    const checkboxes = document.querySelectorAll('.pip-chk');

    pipsMask = [];
    checkboxes.forEach(chk => {
        if (chk.checked) {
            pipsMask.push(chk.value);
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
    }

    if (modal.classList.contains('hidden') && html5QrcodeScanner) {
        html5QrcodeScanner.clear();
    }
}

async function toggleWakeLock() {
    settings.awake = !settings.awake;
    if (settings.awake) {
        await requestWakeLock();
    } else {
        if (wakeLock !== null) {
            await wakeLock.release();
            wakeLock = null;
        }
    }
    applySettings();
    saveSettings();
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { });
        }
    } catch (err) {
        console.error(`${err.name}, ${err.message}`);
    }
}

function validateConnectionInputs() {
    const nameInput = document.getElementById('conn-player-name').value.trim();
    const roomInputValue = document.getElementById('conn-room-code').value.trim();
    const joinBtn = document.getElementById('btn-join-room');
    const scanBtn = document.getElementById('btn-scan-qr');
    const roomInput = document.getElementById('conn-room-code');
    const status = document.getElementById('conn-status');

    if (nameInput.length > 0) {
        roomInput.disabled = false;
        scanBtn.disabled = false;

        if (roomInputValue.length >= 5) {
            joinBtn.disabled = false;
            status.innerText = "Ready to connect!";
        } else {
            joinBtn.disabled = true;
            status.innerText = "Enter a room name (5+ chars) or scan a QR code.";
        }
    } else {
        roomInput.disabled = true;
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
        if (!snapshot.hasChild(myPlayerId)) {
            status.innerText = "Room is full (4/4 players).";
            return;
        }
    }

    currentRoomId = roomId;
    localStorage.setItem('name-p1', playerName);

    const p1Input = document.getElementById('name-p1');
    const p1Icon = document.getElementById('sync-icon-p1');
    if (p1Input && p1Icon) {
        p1Input.value = playerName;
        p1Input.disabled = true;
        p1Icon.classList.remove('hidden');
    }

    const myRef = ref(db, 'rooms/' + currentRoomId + '/players/' + myPlayerId);

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
    new QRCode(qrContainer, {
        text: roomId,
        width: 150,
        height: 150
    });

    listenToRoom();

    status.innerText = "Connected!";
}

function listenToRoom() {
    const playersRef = ref(db, 'rooms/' + currentRoomId + '/players');

    roomListenerUnsubscribe = onValue(playersRef, (snapshot) => {
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
        if (key === myPlayerId) return;

        hasRemotePlayers = true;

        const p = players[key];

        const tile = document.createElement('div');
        tile.className = 'remote-tile';
        tile.innerHTML = `
            <div class="remote-name">${p.name}</div>
            <div class="remote-life">${p.life}</div>
        `;
        container.appendChild(tile);

        if (remoteIndex <= 4) {
            const cmdInput = document.getElementById(`name-p${remoteIndex}`);
            const cmdIcon = document.getElementById(`sync-icon-p${remoteIndex}`);
            if (cmdInput && cmdIcon) {
                cmdInput.value = p.name;
                cmdInput.disabled = true;
                cmdIcon.classList.remove('hidden');
            }
            remoteIndex++;
        }
    });

    if (!hasRemotePlayers) {
        container.innerHTML = `<span class="waiting-text">waiting for players...</span>`;
    }
}

function syncLifeToRoom(newLife, immediate = false) {
    if (!currentRoomId || isSyncLocked) return;

    if (immediate) {
        clearTimeout(syncDebounceTimer);

        const myLifeRef = ref(db, 'rooms/' + currentRoomId + '/players/' + myPlayerId + '/life');
        set(myLifeRef, newLife);

        isSyncLocked = true;
        setTimeout(() => { isSyncLocked = false; }, 2000);

        return;
    }

    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
        const myLifeRef = ref(db, 'rooms/' + currentRoomId + '/players/' + myPlayerId + '/life');
        set(myLifeRef, newLife);
    }, 500);
}

function reestablishPresence() {
    if (!currentRoomId || !myPlayerId) return;

    const myRef = ref(db, 'rooms/' + currentRoomId + '/players/' + myPlayerId);

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

    html5QrcodeScanner = new Html5Qrcode("qr-reader");

    html5QrcodeScanner.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: 250 },
        (decodedText, decodedResult) => {
            document.getElementById('conn-room-code').value = decodedText;
            stopQRScan();
            joinRoom();
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
    if (html5QrcodeScanner) {
        html5QrcodeScanner.stop().then(() => {
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
        if (currentRoomId) {
            const myRef = ref(db, 'rooms/' + currentRoomId + '/players/' + myPlayerId);
            remove(myRef);
        }

        if (roomListenerUnsubscribe) {
            roomListenerUnsubscribe();
            roomListenerUnsubscribe = null;
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

        currentRoomId = null;

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
    settings.layoutLR = !settings.layoutLR;
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

function copyRoomCode() {
    if (!currentRoomId) return;

    navigator.clipboard.writeText(currentRoomId).then(() => {
        const display = document.getElementById('display-room-code');

        display.innerText = "COPIED!";
        display.style.color = "#4da6ff";

        setTimeout(() => {
            display.innerText = currentRoomId;
            display.style.color = "";
        }, 1500);

        if (navigator.vibrate) navigator.vibrate(20);
    }).catch(err => {
        console.error("Clipboard copy failed", err);
    });
}

window.toggleCredits = toggleCredits;
window.toggleHelp = toggleHelp;
window.toggleShare = toggleShare;
window.toggleCmdModal = toggleCmdModal;
window.toggleConnectModal = toggleConnectModal;
window.toggleLife = toggleLife;
window.toggleTax = toggleTax;
window.togglePips = togglePips;
window.toggleWakeLock = toggleWakeLock;
window.updateValue = updateValue;
window.updateCmdValue = updateCmdValue;
window.resetAll = resetAll;
window.savePlayerName = savePlayerName;
window.saveCmdName = saveCmdName;
window.savePipsConfig = savePipsConfig;
window.validateConnectionInputs = validateConnectionInputs;
window.joinRoom = joinRoom;
window.startQRScan = startQRScan;
window.stopQRScan = stopQRScan;
window.showRoomQR = showRoomQR;
window.leaveRoom = leaveRoom;
window.switchHelpTab = switchHelpTab;
window.toggleUDLR = toggleUDLR;
window.startHold = startHold;
window.stopHold = stopHold;
window.shareNatively = shareNatively;
window.copyRoomCode = copyRoomCode;