// Global Application States
let isSafetyActive = false;
let isLiveMode = true; // True = Webcam + WebSocket, False = Demo simulation playback
let socket = null;
let streamInterval = null;
let localMediaStream = null;
let currentSafetyState = "SAFE";
let scanState = {
    active: false,
    currentStep: "OFF", // "OFF", "LEFT", "CENTER", "RIGHT", "REAR", "COMPILING"
    subState: "ROTATING", // "ROTATING", "STABILIZING", "CAPTURING"
    startHeading: null,
    currentHeading: null,
    isPaused: false,
    consecutiveNonCriticalFrames: 0,
    tempDetections: [],
    sensorTimeout: null,
    collectedData: {
        LEFT: [],
        CENTER: [],
        RIGHT: [],
        REAR: []
    }
};

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
const scanManualBtn = document.getElementById("scanManualBtn");
const scanPauseBanner = document.getElementById("scanPauseBanner");
const scanInstruction = document.getElementById("scanInstruction");
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
// Web Audio FFT Pipeline & Feature Extractor (T14)
// -------------------------------------------------------------
let audioCtx = null;
let audioAnalyser = null;
let audioStream = null;
let audioSource = null;

async function startAudio() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) {
            addDiagLog("Web Audio API is not supported in this browser.");
            return;
        }
        
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioCtx = new AudioContext();
        audioAnalyser = audioCtx.createAnalyser();
        audioAnalyser.fftSize = 2048;
        
        audioSource = audioCtx.createMediaStreamSource(audioStream);
        audioSource.connect(audioAnalyser);
        addDiagLog("Microphone capture active. FFT spectral analysis initialized.");
    } catch (err) {
        addDiagLog(`Audio capture error: ${err.message}. Running without mic support.`);
    }
}

function stopAudio() {
    if (audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }
    if (audioSource) {
        audioSource.disconnect();
        audioSource = null;
    }
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    audioAnalyser = null;
}

function getAudioFeatures() {
    if (!audioAnalyser || !audioCtx) return null;
    
    const bufferLength = audioAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    audioAnalyser.getByteFrequencyData(dataArray);
    
    // Calculate RMS in time domain
    const timeData = new Uint8Array(bufferLength);
    audioAnalyser.getByteTimeDomainData(timeData);
    
    let sumSquares = 0;
    for (let i = 0; i < bufferLength; i++) {
        const val = (timeData[i] - 128) / 128.0;
        sumSquares += val * val;
    }
    const rms = Math.sqrt(sumSquares / bufferLength);
    
    const sampleRate = audioCtx.sampleRate;
    let maxVal = -1;
    let peakBin = 0;
    
    let sumAmps = 0;
    let sumCentroid = 0;
    let sumBandwidth = 0;
    let logSumAmps = 0;
    let numBins = 0;
    
    for (let i = 0; i < bufferLength; i++) {
        const amp = dataArray[i] / 255.0;
        const freq = i * (sampleRate / 2.0) / bufferLength;
        
        if (freq >= 100) {
            numBins++;
            sumAmps += amp;
            sumCentroid += amp * freq;
            logSumAmps += Math.log(Math.max(1e-7, amp));
            
            if (amp > maxVal) {
                maxVal = amp;
                peakBin = i;
            }
        }
    }
    
    if (sumAmps === 0) {
        return {
            rms: rms,
            peak_hz: 0.0,
            centroid_hz: 0.0,
            bandwidth_hz: 0.0,
            flatness: 1.0,
            peak_strength: 0.0,
            timestamp: Date.now()
        };
    }
    
    const peakHz = peakBin * (sampleRate / 2.0) / bufferLength;
    const centroidHz = sumCentroid / sumAmps;
    
    for (let i = 0; i < bufferLength; i++) {
        const amp = dataArray[i] / 255.0;
        const freq = i * (sampleRate / 2.0) / bufferLength;
        if (freq >= 100) {
            sumBandwidth += amp * Math.pow(freq - centroidHz, 2);
        }
    }
    const bandwidthHz = Math.sqrt(sumBandwidth / sumAmps);
    
    const geometricMean = Math.exp(logSumAmps / numBins);
    const arithmeticMean = sumAmps / numBins;
    const flatness = arithmeticMean > 0 ? geometricMean / arithmeticMean : 1.0;
    const peakStrength = maxVal / Math.max(0.01, arithmeticMean);
    
    return {
        rms: parseFloat(rms.toFixed(4)),
        peak_hz: parseFloat(peakHz.toFixed(1)),
        centroid_hz: parseFloat(centroidHz.toFixed(1)),
        bandwidth_hz: parseFloat(bandwidthHz.toFixed(1)),
        flatness: parseFloat(flatness.toFixed(4)),
        peak_strength: parseFloat(peakStrength.toFixed(2)),
        timestamp: Date.now()
    };
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
        
        // Extract 6 real-time audio spectral features (T14)
        const audioFeatures = getAudioFeatures();
        
        socket.send(JSON.stringify({
            image: base64Image,
            scan_mode: scanState.active,
            audio_features: audioFeatures,
            timestamp: Date.now()
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

    // Accumulate detections for T16 Smart Scan persistence calculations
    if (scanState.active && scanState.subState === "CAPTURING" && !scanState.isPaused) {
        const detections = data.all_detections || [];
        scanState.tempDetections.push(detections);
    }

    // Critical Alert preemption check for T16 Smart Scan (Hysteresis)
    if (alert && alert.state === "CRITICAL") {
        if (scanState.active && !scanState.isPaused) {
            scanState.isPaused = true;
            scanState.consecutiveNonCriticalFrames = 0;
            scanPauseBanner.classList.remove("hidden");
            addDiagLog("Smart Scan PAUSED due to critical safety threat.");
        }
    } else {
        if (scanState.active && scanState.isPaused) {
            scanState.consecutiveNonCriticalFrames++;
            if (scanState.consecutiveNonCriticalFrames >= 4) {
                scanState.isPaused = false;
                scanState.consecutiveNonCriticalFrames = 0;
                scanPauseBanner.classList.add("hidden");
                addDiagLog("Smart Scan RESUMED. Environment secure.");
                speak(`Resuming smart scan. Continue rotating to the ${scanState.currentStep.toLowerCase()}.`, 30, true);
                setStepSensorTimeout();
            }
        }
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
// -------------------------------------------------------------
// Pillar C: Guided Smart Scan Sequence State Machine (T16)
// -------------------------------------------------------------
function triggerSmartScan() {
    if (scanState.active) return;
    
    speak("Starting smart environment scan. Please turn slowly to your left.", 30, true);
    addDiagLog("Smart Scan initiated.");
    
    scanState.active = true;
    scanState.currentStep = "LEFT";
    scanState.subState = "ROTATING";
    scanState.startHeading = null;
    scanState.currentHeading = 0;
    scanState.isPaused = false;
    scanState.consecutiveNonCriticalFrames = 0;
    scanState.tempDetections = [];
    scanState.collectedData = { LEFT: [], CENTER: [], RIGHT: [], REAR: [] };
    
    // Reset visual scan markers
    markLeft.textContent = "○"; markCenter.textContent = "○"; markRight.textContent = "○"; markRear.textContent = "○";
    scanLeft.className = ""; scanCenter.className = ""; scanRight.className = ""; scanRear.className = "";
    
    scanInstruction.textContent = "Please turn slowly to your LEFT...";
    scanPauseBanner.classList.add("hidden");
    
    try { scanDialog.showModal(); } catch (e) {}
    
    // Set step sensor timeout
    setStepSensorTimeout();
}

function clearSensorTimeout() {
    if (scanState.sensorTimeout) {
        clearTimeout(scanState.sensorTimeout);
        scanState.sensorTimeout = null;
    }
}

function setStepSensorTimeout() {
    clearSensorTimeout();
    scanState.sensorTimeout = setTimeout(() => {
        if (scanState.active && scanState.subState === "ROTATING" && !scanState.isPaused) {
            speak(`I cannot detect rotation. Please turn to your ${scanState.currentStep.toLowerCase()} or tap I'm Here.`, 30);
        }
    }, 4000);
}

// Normalize the device orientation into a relative heading (T16.1)
window.addEventListener("deviceorientation", (event) => {
    if (!scanState.active || scanState.isPaused || scanState.subState !== "ROTATING") return;
    
    let alpha = event.alpha;
    if (alpha === null || alpha === undefined) return;
    
    if (scanState.startHeading === null) {
        scanState.startHeading = alpha;
        addDiagLog(`Gyro baseline reference set at ${alpha.toFixed(1)}°`);
    }
    
    // Calculate angular displacement
    let diff = alpha - scanState.startHeading;
    while (diff < -180) diff += 360;
    while (diff > 180) diff -= 360;
    
    scanState.currentHeading = diff;
    evaluateOrientationTarget(diff);
});

function evaluateOrientationTarget(diff) {
    if (!scanState.active || scanState.isPaused || scanState.subState !== "ROTATING") return;
    
    const step = scanState.currentStep;
    let targetReached = false;
    
    if (step === "LEFT") {
        if (diff <= -60 && diff >= -120) targetReached = true;
    } else if (step === "CENTER") {
        if (diff >= -20 && diff <= 20) targetReached = true;
    } else if (step === "RIGHT") {
        if (diff >= 60 && diff <= 120) targetReached = true;
    } else if (step === "REAR") {
        if (Math.abs(diff) >= 150) targetReached = true;
    }
    
    if (targetReached) {
        startStabilizeAndCapture();
    }
}

function startStabilizeAndCapture() {
    clearSensorTimeout();
    scanState.subState = "STABILIZING";
    
    const step = scanState.currentStep;
    speak(`${step} position reached. Hold camera steady.`, 30, true);
    scanInstruction.textContent = `${step} position reached. Scanning...`;
    addDiagLog(`Scan step ${step}: stabilizing...`);
    
    scanState.tempDetections = [];
    
    // Wait 500ms for camera motion stabilization (T16.6)
    setTimeout(() => {
        if (!scanState.active || scanState.isPaused) return;
        
        scanState.subState = "CAPTURING";
        addDiagLog(`Scan step ${step}: capturing...`);
        
        // 1500ms capture window (T16.7)
        setTimeout(() => {
            if (!scanState.active || scanState.isPaused) return;
            processStepCaptureResults();
        }, 1500);
    }, 500);
}

function processStepCaptureResults() {
    const step = scanState.currentStep;
    const allFrames = scanState.tempDetections;
    const totalFrames = allFrames.length;
    
    // Group occurrences by track_id + object_class (T16.2)
    const counts = {};
    const maxRiskMap = {};
    const maxConfidenceMap = {};
    const motionMap = {};
    
    allFrames.forEach(frame => {
        frame.forEach(det => {
            const trackId = det.id !== undefined ? det.id : det.object;
            const key = `${trackId}_${det.object}`;
            counts[key] = (counts[key] || 0) + 1;
            maxRiskMap[key] = Math.max(maxRiskMap[key] || 0, det.risk || 0);
            maxConfidenceMap[key] = Math.max(maxConfidenceMap[key] || 0, det.confidence || 0);
            if (det.motion && det.motion.toUpperCase() === "APPROACHING") {
                motionMap[key] = "approaching";
            }
        });
    });
    
    const finalObjects = [];
    Object.keys(counts).forEach(key => {
        const parts = key.split("_");
        const objectClass = parts[1];
        const count = counts[key];
        const persistence = count / Math.max(1, totalFrames);
        const maxRisk = maxRiskMap[key];
        const maxConfidence = maxConfidenceMap[key];
        const isApproaching = motionMap[key] === "approaching";
        
        // Class-sensitive persistence thresholds
        let keep = false;
        if (maxRisk >= 85 || isApproaching) {
            keep = true; // Retain moving/critical threats
        } else if (persistence >= 0.50) {
            keep = true; // Retain static/environmental obstacles
        }
        
        if (keep) {
            finalObjects.push({
                class: objectClass,
                risk: maxRisk,
                confidence: maxConfidence
            });
        }
    });
    
    scanState.collectedData[step] = finalObjects;
    addDiagLog(`Scan step ${step} complete. Captured: ${JSON.stringify(finalObjects)}`);
    
    markStepCompleteUI(step);
    advanceScanStep();
}

function markStepCompleteUI(step) {
    let markElem, scanElem;
    if (step === "LEFT") {
        markElem = markLeft; scanElem = scanLeft;
    } else if (step === "CENTER") {
        markElem = markCenter; scanElem = scanCenter;
    } else if (step === "RIGHT") {
        markElem = markRight; scanElem = scanRight;
    } else if (step === "REAR") {
        markElem = markRear; scanElem = scanRear;
    }
    if (markElem && scanElem) {
        markElem.textContent = "✓";
        scanElem.className = "text-green-400 font-bold";
    }
}

function advanceScanStep() {
    const step = scanState.currentStep;
    if (step === "LEFT") {
        scanState.currentStep = "CENTER";
        scanState.subState = "ROTATING";
        scanInstruction.textContent = "Rotate slowly back to the CENTER...";
        speak("Left complete. Return to center.", 30, true);
        setStepSensorTimeout();
    } else if (step === "CENTER") {
        scanState.currentStep = "RIGHT";
        scanState.subState = "ROTATING";
        scanInstruction.textContent = "Rotate slowly to the RIGHT...";
        speak("Center complete. Rotate right.", 30, true);
        setStepSensorTimeout();
    } else if (step === "RIGHT") {
        scanState.currentStep = "REAR";
        scanState.subState = "ROTATING";
        scanInstruction.textContent = "Turn around slowly to check the REAR...";
        speak("Right complete. Turn around slowly.", 30, true);
        setStepSensorTimeout();
    } else if (step === "REAR") {
        scanState.currentStep = "COMPILING";
        compileScanSummary();
    }
}

function compileScanSummary() {
    scanInstruction.textContent = "Compiling environmental scan results...";
    speak("Scan complete. Summarizing findings.", 30, true);
    
    // Group collected data into a friendly summary sentence (T17 preview)
    const summaryParts = [];
    const zones = ["LEFT", "CENTER", "RIGHT", "REAR"];
    
    zones.forEach(zone => {
        const items = scanState.collectedData[zone];
        if (items.length === 0) {
            summaryParts.push(`${zone.toLowerCase()} side is clear`);
        } else {
            const desc = items.map(it => it.class).join(" and ");
            summaryParts.push(`${zone.toLowerCase()}: ${desc} detected`);
        }
    });
    
    const summaryText = "Smart environmental scan complete. " + summaryParts.join(". ") + ".";
    
    setTimeout(() => {
        try { scanDialog.close(); } catch (e) {}
        speak(summaryText, 60, true);
        addDiagLog(`Smart Scan Complete: "${summaryText}"`);
        scanState.active = false;
        scanState.currentStep = "OFF";
    }, 1200);
}

// Event Listeners for Smart Scan Controls
scanBtn.addEventListener("click", triggerSmartScan);
scanManualBtn.addEventListener("click", () => {
    if (!scanState.active || scanState.isPaused || scanState.subState !== "ROTATING") return;
    addDiagLog(`Manual check-in triggered for step: ${scanState.currentStep}`);
    startStabilizeAndCapture();
});

closeScanBtn.addEventListener("click", () => {
    clearSensorTimeout();
    try { scanDialog.close(); } catch (e) {}
    scanState.active = false;
    scanState.currentStep = "OFF";
    speak("Scan cancelled.", true);
    addDiagLog("Smart Scan cancelled.");
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
            startWebcam().then(() => startAudio().then(initWebSocket));
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
            stopAudio();
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
