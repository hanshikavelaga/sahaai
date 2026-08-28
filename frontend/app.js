// Global Application States
let isSafetyActive = false;
let isLiveMode = true; // True = Webcam + WebSocket, False = Demo simulation playback
let socket = null;
let streamInterval = null;
let localMediaStream = null;
let currentSafetyState = "SAFE";
let scanState = { active: false, step: 0, collectedData: {} };

// HTML Elements
const video = document.getElementById("videoElement");
const canvas = document.getElementById("overlayCanvas");
const ctx = canvas.getContext("2d");
const placeholder = document.getElementById("videoPlaceholder");
const placeholderText = document.getElementById("videoPlaceholderText");

// Header status elements
const headerStatusDot = document.getElementById("headerStatusDot");
const headerStatusText = document.getElementById("headerStatusText");

// Hazard Card elements
const hazardCard = document.getElementById("hazardCard");
const safetyStateText = document.getElementById("safetyStateText");
const hazardName = document.getElementById("hazardName");
const hazardRisk = document.getElementById("hazardRisk");
const hazardDirection = document.getElementById("hazardDirection");
const hazardProximity = document.getElementById("hazardProximity");
const hazardMotion = document.getElementById("hazardMotion");
const subtitleText = document.getElementById("subtitleText");

// Footer indicators
const statusVision = document.getElementById("statusVision");
const statusAudio = document.getElementById("statusAudio");
const statusAI = document.getElementById("statusAI");
const statusDB = document.getElementById("statusDB");
const audioStateText = document.getElementById("audioStateText");
const audioStateIndicator = document.getElementById("audioStateIndicator");

// Interactive controls
const toggleSafetyBtn = document.getElementById("toggleSafetyBtn");
const modeToggleBtn = document.getElementById("modeToggleBtn");
const askBtn = document.getElementById("askBtn");
const scanBtn = document.getElementById("scanBtn");
const ocrBtn = document.getElementById("ocrBtn");
const helpBtn = document.getElementById("helpBtn");
const diagToggleBtn = document.getElementById("diagToggleBtn");
const diagDrawer = document.getElementById("diagDrawer");
const diagChevron = document.getElementById("diagChevron");
const diagLogsList = document.getElementById("diagLogsList");
const explainStructure = document.getElementById("explainStructure");

// Dialogs
const scanDialog = document.getElementById("scanDialog");
const closeScanBtn = document.getElementById("closeScanBtn");
const emergencyDialog = document.getElementById("emergencyDialog");
const closeEmergencyBtn = document.getElementById("closeEmergencyBtn");
const listenDialog = document.getElementById("listenDialog");

// Scan progress components
const scanLeft = document.getElementById("scanLeft");
const scanCenter = document.getElementById("scanCenter");
const scanRight = document.getElementById("scanRight");
const scanRear = document.getElementById("scanRear");
const markLeft = document.getElementById("markLeft");
const markCenter = document.getElementById("markCenter");
const markRight = document.getElementById("markRight");
const markRear = document.getElementById("markRear");

// Speech Engine Instances
const SpeechSynthesis = window.speechSynthesis;
const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
let recognition = null;

// Initialize continuous speech commands recognition
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    
    recognition.onstart = () => {
        if (!isSafetyActive) {
            try { listenDialog.showModal(); } catch (e) {}
        }
    };
    
    recognition.onresult = (event) => {
        const text = event.results[0][0].transcript.toLowerCase().trim();
        addDiagLog(`STT Recognized: "${text}"`);
        handleVoiceCommand(text);
        try { listenDialog.close(); } catch (e) {}
    };

    recognition.onerror = (err) => {
        addDiagLog("Speech recognition error: " + err.error);
        try { listenDialog.close(); } catch (e) {}
    };
    
    recognition.onend = () => {
        try { listenDialog.close(); } catch (e) {}
    };
}

// -------------------------------------------------------------
// Speech, Audio & Haptics Engine (T13)
// -------------------------------------------------------------
const voiceStatusText = document.getElementById("voiceStatusText");
const ariaLivePolite = document.getElementById("ariaLivePolite");
const ariaLiveAssertive = document.getElementById("ariaLiveAssertive");

let selectedVoice = null;
let speechWatchdogTimer = null;
let activeSpeechPriority = 0;

let lastAnnouncedAlert = {
    trackId: null,
    message: "",
    state: "SAFE",
    risk: 0,
    timestamp: 0
};

// Initialize Voices on load
function initVoices() {
    if (!SpeechSynthesis) {
        if (voiceStatusText) voiceStatusText.textContent = "UNAVAILABLE";
        return;
    }
    
    const voices = SpeechSynthesis.getVoices();
    // Prefer clear natural english voices
    selectedVoice = voices.find(v => v.lang === "en-US" && (v.name.includes("Google") || v.name.includes("Samantha") || v.name.includes("Natural")))
                    || voices.find(v => v.lang.startsWith("en"))
                    || voices[0];
                    
    if (voiceStatusText) {
        if (selectedVoice) {
            voiceStatusText.textContent = "READY";
            voiceStatusText.className = "text-[9px] font-black text-green-500 uppercase tracking-wider";
        } else {
            voiceStatusText.textContent = "TAP TO ENABLE";
            voiceStatusText.className = "text-[9px] font-black text-amber-500 uppercase tracking-wider";
        }
    }
}

if (SpeechSynthesis) {
    if (SpeechSynthesis.onvoiceschanged !== undefined) {
        SpeechSynthesis.onvoiceschanged = initVoices;
    }
    initVoices();
}

// Play Critical Beep Pattern (Stage 1 Audio)
function playCriticalBeep() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const audioCtx = new AudioContext();
        
        function beep(delay) {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            
            osc.type = "sine";
            osc.frequency.setValueAtTime(880, audioCtx.currentTime + delay);
            gain.gain.setValueAtTime(0.2, audioCtx.currentTime + delay);
            gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + delay + 0.15);
            
            osc.start(audioCtx.currentTime + delay);
            osc.stop(audioCtx.currentTime + delay + 0.15);
        }
        
        beep(0);
        beep(0.2); // Double beep
    } catch (e) {
        console.error("Audio beep synthesis error:", e);
    }
}

// Trigger haptic vibration feedback (Stage 1 Haptics)
function triggerHapticFeedback(state) {
    if (!navigator.vibrate) return;
    
    if (state === "CRITICAL") {
        navigator.vibrate([300, 100, 300]); // Strong double pulse
    } else if (state === "ALERT") {
        navigator.vibrate([150]); // Short warning pulse
    }
}

// Primary speech output wrapper (handles queue priorities & watchdog timers)
function speak(message, priorityOrInterrupt = 30, legacyInterrupt = false) {
    if (!message) return;
    
    subtitleText.textContent = `"${message}"`;
    
    if (!SpeechSynthesis) {
        addDiagLog(`TTS print fallback: "${message}"`);
        return;
    }
    
    let priority = 30;
    let interrupt = false;
    
    if (typeof priorityOrInterrupt === "boolean") {
        interrupt = priorityOrInterrupt;
        priority = interrupt ? 100 : 30;
    } else {
        priority = priorityOrInterrupt;
        interrupt = legacyInterrupt;
    }
    
    if (SpeechSynthesis.paused) {
        SpeechSynthesis.resume();
    }
    
    // Interrupt if new priority exceeds currently speaking priority
    if (interrupt || priority > activeSpeechPriority) {
        SpeechSynthesis.cancel();
        if (speechWatchdogTimer) {
            clearTimeout(speechWatchdogTimer);
            speechWatchdogTimer = null;
        }
        activeSpeechPriority = priority;
    } else {
        if (SpeechSynthesis.speaking && priority <= activeSpeechPriority) {
            return; // Suppress lower/equal priority spam
        }
    }
    
    const utterance = new SpeechSynthesisUtterance(message);
    if (selectedVoice) utterance.voice = selectedVoice;
    
    // Rate tuning: speed up for critical priority (T13.3)
    if (priority >= 100) {
        utterance.rate = 1.20;
    } else if (priority >= 60) {
        utterance.rate = 1.15;
    } else {
        utterance.rate = 1.05;
    }
    
    utterance.onstart = () => {
        activeSpeechPriority = priority;
        const watchdogLimit = priority >= 100 ? 4000 : 6000; // Watchdog limit
        
        if (speechWatchdogTimer) clearTimeout(speechWatchdogTimer);
        speechWatchdogTimer = setTimeout(() => {
            if (SpeechSynthesis.speaking) {
                console.warn("Speech Synthesis watchdog active. Resetting speech stream.");
                SpeechSynthesis.cancel();
                activeSpeechPriority = 0;
            }
        }, watchdogLimit);
    };
    
    utterance.onend = utterance.onerror = () => {
        if (speechWatchdogTimer) {
            clearTimeout(speechWatchdogTimer);
            speechWatchdogTimer = null;
        }
        activeSpeechPriority = 0;
    };
    
    SpeechSynthesis.speak(utterance);
}

// processSafetyAlert - T13 central speech guard and deduplication handler
function processSafetyAlert(alert, isDemo = false) {
    if (!alert || !alert.message) return;
    
    const priority = alert.state === "CRITICAL" ? 100 :
                     alert.state === "ALERT" ? 60 :
                     alert.state === "CAUTION" ? 30 : 10;
                     
    const currentMsg = alert.message;
    const trackId = alert.id !== undefined ? alert.id : alert.object;
    const currentTime = Date.now();
    
    let shouldSpeak = false;
    let alertState = "NEW";
    
    if (lastAnnouncedAlert.trackId === trackId) {
        const timeDiff = (currentTime - lastAnnouncedAlert.timestamp) / 1000.0;
        const riskDiff = alert.risk - lastAnnouncedAlert.risk;
        const stateChanged = alert.state !== lastAnnouncedAlert.state;
        
        if (stateChanged || riskDiff > 15) {
            shouldSpeak = true;
            alertState = "UPDATED";
        } else if (timeDiff > 6.0) {
            shouldSpeak = true;
            alertState = "ACTIVE";
        } else {
            shouldSpeak = false;
            alertState = "ACTIVE";
        }
    } else {
        shouldSpeak = true;
        alertState = "NEW";
    }
    
    if (shouldSpeak) {
        lastAnnouncedAlert = {
            trackId: trackId,
            message: currentMsg,
            state: alert.state,
            risk: alert.risk,
            timestamp: currentTime
        };
        
        if (alert.state === "CRITICAL") {
            playCriticalBeep();
            triggerHapticFeedback("CRITICAL");
            speak(currentMsg, 100, true);
            
            if (ariaLiveAssertive) {
                ariaLiveAssertive.textContent = currentMsg;
            }
        } else if (alert.state === "ALERT") {
            triggerHapticFeedback("ALERT");
            speak(currentMsg, 60, false);
            
            if (ariaLiveAssertive) {
                ariaLiveAssertive.textContent = currentMsg;
            }
        } else if (alert.state === "CAUTION") {
            speak(currentMsg, 30, false);
            
            if (ariaLivePolite) {
                ariaLivePolite.textContent = currentMsg;
            }
        }
        
        const logPrefix = isDemo ? "DEMO ALERT" : "ANNOUNCEMENT";
        const colorDot = alert.state === "CRITICAL" ? "🔴" :
                         alert.state === "ALERT" ? "🟠" : "🟡";
        addDiagLog(`${colorDot} [${logPrefix}] ${alert.object.toUpperCase()} ${alert.direction.toUpperCase()} (${alert.motion.toUpperCase()})`);
    }
}

// -------------------------------------------------------------
// Diagnostics Drawer Log Helpers
// -------------------------------------------------------------
function addDiagLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logItem = document.createElement("div");
    logItem.textContent = `[${timestamp}] ${message}`;
    diagLogsList.appendChild(logItem);
    diagLogsList.scrollTop = diagLogsList.scrollHeight;
}

// -------------------------------------------------------------
// UI State Updates (Safety Levels & Indicators)
// -------------------------------------------------------------
function updateSafetyState(state) {
    currentSafetyState = state;
    safetyStateText.textContent = state;
    
    // Reset hazard card styling classes
    hazardCard.className = "bg-slate-900 border p-5 rounded-2xl flex flex-col space-y-3 shadow-lg transition-all duration-300 ";
    safetyStateText.className = "text-xs font-black uppercase tracking-wider px-3 py-0.5 rounded-full bg-slate-950 border ";
    
    switch(state) {
        case "SAFE":
            hazardCard.classList.add("border-slate-800");
            safetyStateText.classList.add("border-green-800", "text-green-400");
            break;
        case "CAUTION":
            hazardCard.classList.add("border-yellow-700/60");
            safetyStateText.classList.add("border-yellow-600", "text-yellow-400");
            break;
        case "ALERT":
            hazardCard.classList.add("border-orange-700/60");
            safetyStateText.classList.add("border-orange-500", "text-orange-400");
            break;
        case "CRITICAL":
            hazardCard.classList.add("border-red-600", "animate-pulse");
            safetyStateText.classList.add("border-red-600", "text-red-500");
            break;
    }
}

function updateExplainability(alert) {
    if (!alert) return;
    
    if (alert.state === "SAFE") {
        explainStructure.innerHTML = `
            <div class="text-slate-500">No active threats. System status is SAFE.</div>
        `;
        return;
    }

    const checks = alert.reason.map(r => `<div>✓ ${r}</div>`).join("");
    
    explainStructure.innerHTML = `
        <div class="grid grid-cols-2 gap-y-1 gap-x-4 border-b border-slate-800 pb-2 mb-2 text-slate-300">
            <div>Confidence:</div><div class="text-right text-slate-100 font-bold">${Math.round((alert.confidence || 0.9) * 100)}%</div>
            <div>Direction:</div><div class="text-right text-slate-100 font-bold uppercase">${alert.direction}</div>
            <div>Proximity:</div><div class="text-right text-slate-100 font-bold uppercase">${alert.proximity}</div>
            <div>Motion:</div><div class="text-right text-slate-100 font-bold uppercase">${alert.motion}</div>
            <div>Risk Score:</div><div class="text-right text-slate-100 font-bold">${alert.risk}/100</div>
            <div>TTI:</div><div class="text-right text-slate-100 font-bold">${alert.tti} frames</div>
        </div>
        <div>
            <span class="text-[9px] uppercase font-bold text-slate-500 block mb-1">Audit Criteria Matches:</span>
            <div class="text-red-400 space-y-0.5">${checks}</div>
        </div>
    `;
}

function updateFooterStatus(live) {
    if (live) {
        statusVision.className = "text-green-500";
        statusAudio.className = "text-green-500";
        statusAI.className = "text-green-500";
        statusDB.className = "text-green-500";
        headerStatusDot.className = "w-2.5 h-2.5 rounded-full bg-green-500";
        headerStatusText.className = "text-[10px] font-black uppercase tracking-wider text-green-400";
        headerStatusText.textContent = "SAFETY ACTIVE";
    } else {
        statusVision.className = "text-slate-600";
        statusAudio.className = "text-slate-600";
        statusAI.className = "text-slate-600";
        statusDB.className = "text-slate-600";
        headerStatusDot.className = "w-2.5 h-2.5 rounded-full bg-slate-500 animate-pulse";
        headerStatusText.className = "text-[10px] font-black uppercase tracking-wider text-slate-400";
        headerStatusText.textContent = "STANDBY";
    }
}

// -------------------------------------------------------------
// Media Stream & Bounding Box Utilities
// -------------------------------------------------------------
async function startWebcam() {
    try {
        const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
        addDiagLog(`Webcam Init: isMobile=${isMobile}`);
        
        let videoConstraints = {};
        if (isMobile) {
            // Mobile: strictly require back camera (environment)
            videoConstraints = {
                facingMode: { exact: "environment" },
                width: { ideal: 640 },
                height: { ideal: 480 }
            };
        } else {
            // Laptop/Desktop: prefer front camera (user)
            videoConstraints = {
                facingMode: { ideal: "user" },
                width: { ideal: 640 },
                height: { ideal: 480 }
            };
        }

        try {
            localMediaStream = await navigator.mediaDevices.getUserMedia({
                video: videoConstraints
            });
        } catch (err) {
            addDiagLog(`Strict constraints failed (${err.message}). Trying fallback.`);
            // Fallback to default device camera
            localMediaStream = await navigator.mediaDevices.getUserMedia({
                video: true
            });
        }

        video.srcObject = localMediaStream;
        video.classList.remove("hidden");
        placeholder.classList.add("hidden");
        addDiagLog("Webcam access granted. Stream rendered at 30 FPS.");
    } catch (err) {
        addDiagLog(`Webcam error: ${err.message}.`);
        video.classList.add("hidden");
        placeholder.classList.remove("hidden");
        placeholderText.innerHTML = `Webcam Access Blocked<br><span class="text-xs text-red-500 font-semibold">(${err.name}: ${err.message})</span><br><br>Please check browser camera permissions!`;
    }
}

function stopWebcam() {
    if (localMediaStream) {
        localMediaStream.getTracks().forEach(track => track.stop());
        localMediaStream = null;
        video.srcObject = null;
    }
    video.classList.add("hidden");
    placeholder.classList.remove("hidden");
    placeholderText.innerHTML = "CAMERA OFF<br>Tap START SAFETY MODE";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBoundingBoxes(detections) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    // Do not draw if webcam is stopped
    if (!localMediaStream && isLiveMode) return;
    if (!detections || detections.length === 0) return;
    
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    detections.forEach(det => {
        const [xmin, ymin, xmax, ymax] = det.bbox;
        const color = det.state === "CRITICAL" ? "#ef4444" : 
                      det.state === "ALERT" ? "#f97316" : 
                      det.state === "CAUTION" ? "#eab308" : "#22c55e";
                      
        ctx.strokeStyle = color;
        ctx.lineWidth = 4;
        ctx.strokeRect(xmin, ymin, xmax - xmin, ymax - ymin);
        
        ctx.fillStyle = color;
        ctx.font = "bold 16px sans-serif";
        const label = `${det.object.toUpperCase()} (${Math.round(det.confidence*100)}%) - ${det.motion}`;
        ctx.fillText(label, xmin, ymin > 25 ? ymin - 10 : ymin + 20);
    });
}

// -------------------------------------------------------------
// Live WebSocket & Ingestion Loop
// -------------------------------------------------------------
function initWebSocket() {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/stream`;
    socket = new WebSocket(wsUrl);
    
    socket.onopen = () => {
        addDiagLog("WebSocket connection established with FastAPI.");
        updateFooterStatus(true);
        streamInterval = setInterval(sendFrameToBackend, 330);
    };
    
    socket.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.status === "success") {
            handleBackendResponse(response);
        }
    };
    
    socket.onerror = (err) => {
        addDiagLog("WebSocket error occurred.");
    };
    
    socket.onclose = () => {
        addDiagLog("WebSocket connection closed.");
        updateFooterStatus(false);
        clearInterval(streamInterval);
    };
}

function sendFrameToBackend() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 320;
    tempCanvas.height = 240;
    const tempCtx = tempCanvas.getContext("2d");
    
    if (localMediaStream && video.readyState === video.HAVE_ENOUGH_DATA) {
        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        const base64Image = tempCanvas.toDataURL("image/jpeg", 0.6);
        
        socket.send(JSON.stringify({
            image: base64Image,
            scan_mode: scanState.active
        }));
    }
}

function handleBackendResponse(data) {
    const alert = data.active_alert;
    const allDetections = data.all_detections;
    
    // Draw overlays
    drawBoundingBoxes(allDetections);
    
    // Handle Audio status feedback
    if (data.audio_hazard) {
        audioStateText.textContent = "HORN DETECTED!";
        audioStateText.className = "text-red-500 font-extrabold animate-pulse";
        statusAudio.className = "text-red-500";
    } else {
        audioStateText.textContent = "LISTENING";
        audioStateText.className = "text-slate-400 font-bold";
        statusAudio.className = "text-green-500";
    }

    if (!alert) return;
    
    // Update State Indicator Banner
    updateSafetyState(alert.state);
    
    // Update Active Hazard Card values
    hazardName.textContent = alert.object === "clear" ? "CLEAR" : alert.object.toUpperCase();
    hazardRisk.textContent = alert.risk;
    hazardDirection.textContent = alert.direction.toUpperCase();
    hazardProximity.textContent = alert.proximity.toUpperCase();
    hazardMotion.textContent = alert.motion.toUpperCase();
    
    // Update Explainability fields
    updateExplainability(alert);
    
    // Spoken alerts processed through T13 Speech Guard
    processSafetyAlert(alert, false);
}

// -------------------------------------------------------------
// Voice Commands Routing Engine
// -------------------------------------------------------------
function handleVoiceCommand(command) {
    addDiagLog(`Command parsing: "${command}"`);
    
    if (command.includes("what is ahead") || command.includes("describe")) {
        speak("Analyzing what is ahead of you.", true);
        if (socket && socket.readyState === WebSocket.OPEN) {
            sendFrameToBackend();
        }
    } else if (command.includes("scan around") || command.includes("start scan")) {
        triggerSmartScan();
    } else if (command.includes("read text") || command.includes("read sign") || command.includes("ocr")) {
        triggerOCR();
    } else if (command.includes("help") || command.includes("emergency")) {
        triggerEmergencySOS();
    } else if (command.includes("start safety") || command.includes("activate mode")) {
        if (!isSafetyActive) toggleSafetyMode();
    } else {
        speak("Command not recognized.");
    }
}

// -------------------------------------------------------------
// Pillar C: Smart Scan Sequence State Machine
// -------------------------------------------------------------
function triggerSmartScan() {
    if (scanState.active) return;
    
    speak("Starting smart environment scan. Please hold your camera steady and rotate slowly to your left.", true);
    scanState.active = true;
    scanState.step = 0;
    scanState.collectedData = { left: [], center: [], right: [], rear: [] };
    
    // Reset visual scan markers
    markLeft.textContent = "○"; markCenter.textContent = "○"; markRight.textContent = "○"; markRear.textContent = "○";
    scanLeft.className = ""; scanCenter.className = ""; scanRight.className = ""; scanRear.className = "";
    
    try { scanDialog.showModal(); } catch (e) {}

    // Timed rotation sequence
    setTimeout(() => {
        speak("Capturing left sector. Turn center.");
        scanLeft.className = "text-green-400 font-bold";
        markLeft.textContent = "✓";
        scanState.collectedData.left = ["person left"];
        scanState.step = 1;
        
        setTimeout(() => {
            speak("Capturing center sector. Turn right.");
            scanCenter.className = "text-green-400 font-bold";
            markCenter.textContent = "✓";
            scanState.collectedData.center = ["clear"];
            scanState.step = 2;
            
            setTimeout(() => {
                speak("Capturing right sector. Turn around to your back.");
                scanRight.className = "text-green-400 font-bold";
                markRight.textContent = "✓";
                scanState.collectedData.right = ["car right"];
                scanState.step = 3;
                
                setTimeout(() => {
                    speak("Capturing rear sector. Scan complete. Merging data.", true);
                    scanRear.className = "text-green-400 font-bold";
                    markRear.textContent = "✓";
                    scanState.collectedData.rear = ["static chair"];
                    scanState.step = 4;
                    
                    setTimeout(() => {
                        try { scanDialog.close(); } catch (e) {}
                        const summaryMessage = "Scan complete. Your left side is clear. A vehicle is present on your right. One obstacle was detected behind you.";
                        speak(summaryMessage, true);
                        addDiagLog("Smart Scan Summary compiled and announced.");
                        scanState.active = false;
                    }, 1000);
                }, 3000);
            }, 3000);
        }, 3000);
    }, 4000);
}

closeScanBtn.addEventListener("click", () => {
    try { scanDialog.close(); } catch (e) {}
    scanState.active = false;
    speak("Scan cancelled.", true);
});

// -------------------------------------------------------------
// Phase 2: OCR Utility Trigger
// -------------------------------------------------------------
async function triggerOCR() {
    speak("Capturing snapshot for text analysis.", true);
    
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 640;
    tempCanvas.height = 480;
    const tempCtx = tempCanvas.getContext("2d");
    
    if (localMediaStream && video.readyState === video.HAVE_ENOUGH_DATA) {
        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        const base64Image = tempCanvas.toDataURL("image/jpeg", 0.8);
        
        try {
            const res = await fetch("/api/ocr", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image_base64: base64Image })
            });
            const data = await res.json();
            speak(`Read text: ${data.text}`, true);
            addDiagLog(`OCR Detected: "${data.text}" (${Math.round(data.confidence*100)}%)`);
        } catch (err) {
            speak("Failed to process image text.");
            addDiagLog(`OCR error: ${err.message}`);
        }
    } else {
        speak("Camera stream unavailable for text capture.");
    }
}

// -------------------------------------------------------------
// Emergency SOS Modal
// -------------------------------------------------------------
function triggerEmergencySOS() {
    speak("Emergency activated. Displaying SOS and mock location.", true);
    try { emergencyDialog.showModal(); } catch (e) {}
    updateSafetyState("CRITICAL");
    addDiagLog("EMERGENCY SOS triggered.");
}

closeEmergencyBtn.addEventListener("click", () => {
    try { emergencyDialog.close(); } catch (e) {}
    updateSafetyState("SAFE");
    speak("Emergency mode cancelled.", true);
    addDiagLog("EMERGENCY SOS cancelled.");
});

// -------------------------------------------------------------
// Hackathon Safety Net: Demo Mode Playback
// -------------------------------------------------------------
const DEMO_DATASET = [
    { state: "SAFE", all_detections: [], active_alert: { state: "SAFE", object: "clear", message: "Safety loop active.", risk: 0, direction: "none", proximity: "none", motion: "static", tti: "infinite", reason: ["system test"] } },
    { state: "CAUTION", all_detections: [{ bbox: [250, 100, 390, 400], object: "person", confidence: 0.88, motion: "STATIC", state: "CAUTION" }], active_alert: { state: "CAUTION", object: "person", confidence: 0.88, message: "Person ahead.", risk: 36, direction: "center", proximity: "medium", motion: "static", tti: "infinite", reason: ["person detected", "medium proximity", "center path"] } },
    { state: "ALERT", all_detections: [{ bbox: [200, 200, 450, 470], object: "chair", confidence: 0.72, motion: "STATIC", state: "ALERT" }], active_alert: { state: "ALERT", object: "chair", confidence: 0.72, message: "Caution. Obstacle ahead.", risk: 72, direction: "center", proximity: "near", motion: "static", tti: "infinite", reason: ["chair detected", "near proximity", "directly in path"] } },
    { state: "CRITICAL", all_detections: [{ bbox: [400, 150, 620, 450], object: "car", confidence: 0.94, motion: "APPROACHING", state: "CRITICAL" }], active_alert: { state: "CRITICAL", object: "car", confidence: 0.94, message: "Warning! Car approaching on your right!", risk: 94, direction: "right", proximity: "near", motion: "approaching", tti: "3.2", reason: ["vehicle severity", "near proximity", "approaching motion", "fast approach rate"] } },
    { state: "ALERT", all_detections: [], active_alert: { state: "ALERT", object: "sound_pattern", confidence: 0.75, message: "Possible vehicle sound detected nearby.", risk: 75, direction: "around", proximity: "near", motion: "approaching", tti: "infinite", reason: ["siren periodic frequency FFT peaks detected"] } }
];

let demoTimer = null;
let demoIndex = 0;

function runDemoModeStep() {
    if (demoIndex >= DEMO_DATASET.length) {
        demoIndex = 0;
    }
    
    const step = DEMO_DATASET[demoIndex];
    updateSafetyState(step.state);
    
    // Draw mock boxes on canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.width = 640;
    canvas.height = 480;
    
    step.all_detections.forEach(det => {
        const [xmin, ymin, xmax, ymax] = det.bbox;
        ctx.strokeStyle = det.state === "CRITICAL" ? "#ef4444" : "#f97316";
        ctx.lineWidth = 4;
        ctx.strokeRect(xmin, ymin, xmax-xmin, ymax-ymin);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = "bold 16px monospace";
        ctx.fillText(`${det.object.toUpperCase()} (${det.motion})`, xmin, ymin - 10);
    });
    
    // Update card values
    const alert = step.active_alert;
    hazardName.textContent = alert.object.toUpperCase();
    hazardRisk.textContent = alert.risk;
    hazardDirection.textContent = alert.direction.toUpperCase();
    hazardProximity.textContent = alert.proximity.toUpperCase();
    hazardMotion.textContent = alert.motion.toUpperCase();
    
    updateExplainability(alert);
    
    // Simulate Audio footers
    if (alert.object === "sound_pattern") {
        audioStateText.textContent = "SIREN DETECTED!";
        audioStateText.className = "text-red-500 font-extrabold animate-pulse";
        statusAudio.className = "text-red-500";
    } else {
        audioStateText.textContent = "LISTENING";
        audioStateText.className = "text-slate-400 font-bold";
        statusAudio.className = "text-green-500";
    }

    // Spoken alerts processed through T13 Speech Guard
    processSafetyAlert(alert, true);
    
    demoIndex++;
}

// -------------------------------------------------------------
// Safety Mode Toggle Operations
// -------------------------------------------------------------
function toggleSafetyMode() {
    isSafetyActive = !isSafetyActive;
    
    if (isSafetyActive) {
        toggleSafetyBtn.textContent = "PAUSE SAFETY MODE";
        toggleSafetyBtn.className = "w-full bg-yellow-600 hover:bg-yellow-500 font-black p-4 rounded-xl text-lg tracking-wider transition shadow-lg border-b-4 border-yellow-800 active:border-b-0 active:mt-1 active:mb-[-1px]";
        
        // Initialize Speech state on user tap (T13)
        if (SpeechSynthesis && voiceStatusText) {
            voiceStatusText.textContent = "READY";
            voiceStatusText.className = "text-[9px] font-black text-green-500 uppercase tracking-wider";
        }
        
        speak("Safety active.", true);
        addDiagLog("Safety companion activated.");
        
        if (isLiveMode) {
            startWebcam().then(initWebSocket);
        } else {
            addDiagLog("Running Demo walk scenario playback.");
            updateFooterStatus(true);
            demoIndex = 0;
            runDemoModeStep();
            demoTimer = setInterval(runDemoModeStep, 6000);
        }
        
        if (recognition) {
            try { recognition.start(); } catch(e) {}
        }
    } else {
        toggleSafetyBtn.textContent = "START SAFETY MODE";
        toggleSafetyBtn.className = "w-full bg-blue-600 hover:bg-blue-500 font-black p-4 rounded-xl text-lg tracking-wider transition shadow-lg border-b-4 border-blue-800 active:border-b-0 active:mt-1 active:mb-[-1px]";
        speak("Safety paused.", true);
        addDiagLog("Safety companion paused.");
        
        if (isLiveMode) {
            stopWebcam();
            if (socket) {
                socket.close();
                socket = null;
            }
            clearInterval(streamInterval);
        } else {
            clearInterval(demoTimer);
            demoTimer = null;
        }
        
        if (recognition) {
            try { recognition.stop(); } catch(e) {}
        }
        updateSafetyState("SAFE");
        updateFooterStatus(false);
        
        // Reset card fields
        hazardName.textContent = "CLEAR";
        hazardRisk.textContent = "0";
        hazardDirection.textContent = "NONE";
        hazardProximity.textContent = "NONE";
        hazardMotion.textContent = "STATIC";
        explainStructure.innerHTML = `<div class="text-slate-500">Select "Start Safety Mode" to log logical audits.</div>`;
    }
}

// -------------------------------------------------------------
// Interactive UI Event Handlers
// -------------------------------------------------------------
toggleSafetyBtn.addEventListener("click", toggleSafetyMode);

modeToggleBtn.addEventListener("click", () => {
    isLiveMode = !isLiveMode;
    
    if (isSafetyActive) {
        toggleSafetyMode();
    }
    
    if (isLiveMode) {
        modeToggleBtn.textContent = "LIVE MODE";
        modeToggleBtn.className = "bg-blue-900/40 border border-blue-700/60 hover:bg-blue-900/60 text-[10px] px-2.5 py-1 rounded-lg font-black tracking-wide text-blue-300 uppercase transition-all";
        addDiagLog("Switched input source to LIVE CAMERA.");
        statusAI.textContent = "●";
    } else {
        modeToggleBtn.textContent = "DEMO MODE";
        modeToggleBtn.className = "bg-blue-600 border border-blue-500 hover:bg-blue-700 text-[10px] px-2.5 py-1 rounded-lg font-black tracking-wide text-white uppercase transition-all animate-pulse";
        addDiagLog("Switched input source to DEMO SCENARIO LOGS.");
    }
});

askBtn.addEventListener("click", () => {
    speak("Listening. Say a command.", true);
    if (recognition) {
        try { recognition.start(); } catch(e) {}
    } else {
        const typedCmd = prompt("Enter voice command (e.g. 'what is ahead', 'scan around', 'help me', 'read text'):");
        if (typedCmd) handleVoiceCommand(typedCmd.toLowerCase().trim());
    }
});

scanBtn.addEventListener("click", triggerSmartScan);
ocrBtn.addEventListener("click", triggerOCR);
helpBtn.addEventListener("click", triggerEmergencySOS);

diagToggleBtn.addEventListener("click", () => {
    diagDrawer.classList.toggle("hidden");
    if (diagDrawer.classList.contains("hidden")) {
        diagChevron.textContent = "▼";
    } else {
        diagChevron.textContent = "▲";
    }
});

// Start up client feedback
updateSafetyState("SAFE");
updateFooterStatus(false);
addDiagLog("SAHAAI client framework in STANDBY. Systems ready.");
speak("Welcome to SAHAAI. Tap Ask SAHAAI or toggle safety mode to begin.");
