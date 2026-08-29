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

// Radar Canvas (T18 & T19)
const radarMapCanvas = document.getElementById("radarMapCanvas");
const radarCtx = radarMapCanvas ? radarMapCanvas.getContext("2d") : null;
let trackHistory = {}; // in-memory object track coordinates history for trailing (T18.5)
let trackLoggedState = {}; // T20 state cache to compute movement delta and handle escalations

// T21 Voice-Guided Contact Setup variables
let contactSetupState = "IDLE";
let tempContactName = "";
let tempContactPhone = "";

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

// Emergency & Contacts Setup Components (T21)
const contactsBtn = document.getElementById("contactsBtn");
const closeContactsBtn = document.getElementById("closeContactsBtn");
const contactsDialog = document.getElementById("contactsDialog");
const contactsList = document.getElementById("contactsList");
const addContactForm = document.getElementById("addContactForm");
const contactNameInput = document.getElementById("contactNameInput");
const contactPhoneInput = document.getElementById("contactPhoneInput");

const emergencyHeader = document.getElementById("emergencyHeader");
const sosCountdown = document.getElementById("sosCountdown");
const emergencyStatusMsg = document.getElementById("emergencyStatusMsg");
const emergencyDetailsCard = document.getElementById("emergencyDetailsCard");
const sosStatusText = document.getElementById("sosStatusText");
const sosContactsCount = document.getElementById("sosContactsCount");
const sosCoordsText = document.getElementById("sosCoordsText");
const dialEmergencyBtn = document.getElementById("dialEmergencyBtn");

const devModeToggleBtn = document.getElementById("devModeToggleBtn");
const explainabilityCard = document.getElementById("explainabilityCard");
let devModeActive = false; // T14 Developer Mode state

let sosTimer = null;
let emergencyState = "IDLE"; // "IDLE", "COUNTDOWN", "LOCATION_REQUEST", "SOS_TRIGGERED", "SOS_ACTIVE"
let emergencyContacts = []; // local cache loaded from database (T21.5)
let startupWaitAnswer = false; // startup voice greeting state
let trackConfirmationFrames = {}; // T10/P0 temporal validation confirm frames map
let sosWaitDialChoice = false; // T21/P1 SOS emergency dialer choice state
let session_id = localStorage.getItem("sahaai_device_session_id");
if (!session_id) {
    session_id = "device_" + Math.random().toString(36).substring(2, 15);
    localStorage.setItem("sahaai_device_session_id", session_id);
}
let isFrontFacingCamera = false; // T18/P0 front camera mirroring indicator

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
        
        if (isSafetyActive || startupWaitAnswer || contactSetupState !== "IDLE" || sosWaitDialChoice) {
            setTimeout(() => {
                try { recognition.start(); } catch(e) {}
            }, 150);
        }
    };
    
    recognition.onend = () => {
        try { listenDialog.close(); } catch (e) {}
        
        if (isSafetyActive || startupWaitAnswer || contactSetupState !== "IDLE" || sosWaitDialChoice) {
            setTimeout(() => {
                try { recognition.start(); } catch(e) {}
            }, 150);
        }
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
let announcedAlertsHistory = {}; // T12/T13 multi-target alert spam prevention cache

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

class SpeechQueue {
    constructor() {
        this.queue = [];
        this.isSpeaking = false;
        this.watchdogTimer = null;
    }
    
    add(message, priority) {
        if (priority >= 100) {
            // Preempt immediately
            this.queue = [];
            if (typeof SpeechSynthesis !== "undefined" && SpeechSynthesis) {
                SpeechSynthesis.cancel();
            }
            this.isSpeaking = false;
            this.speakMessage(message, priority);
        } else {
            // If already speaking equal or higher priority, ignore CAUTION/ALERT updates to avoid spam
            if (this.isSpeaking && priority <= activeSpeechPriority) {
                return;
            }
            this.queue.push({ message, priority });
            this.processNext();
        }
    }
    
    processNext() {
        if (this.isSpeaking || this.queue.length === 0) return;
        
        const next = this.queue.shift();
        this.speakMessage(next.message, next.priority);
    }
    
    speakMessage(message, priority) {
        if (typeof SpeechSynthesis === "undefined" || !SpeechSynthesis) {
            addDiagLog(`TTS print fallback: "${message}"`);
            return;
        }
        
        // Pause Speech Recognition during active speak output to prevent feedback echo loops
        if (recognition) {
            try { recognition.abort(); } catch (e) {}
        }
        
        this.isSpeaking = true;
        activeSpeechPriority = priority;
        
        const utterance = new SpeechSynthesisUtterance(message);
        if (selectedVoice) utterance.voice = selectedVoice;
        
        // Dynamic rates matching priority rules
        if (priority >= 100) {
            utterance.rate = 1.20;
        } else if (priority >= 60) {
            utterance.rate = 1.15;
        } else {
            utterance.rate = 1.05;
        }
        
        utterance.onend = () => {
            this.isSpeaking = false;
            activeSpeechPriority = 0;
            if (this.watchdogTimer) {
                clearTimeout(this.watchdogTimer);
                this.watchdogTimer = null;
            }
            // Resume continuous listening when speech finishes
            if (isSafetyActive || startupWaitAnswer || contactSetupState !== "IDLE" || sosWaitDialChoice) {
                setTimeout(() => {
                    try { recognition.start(); } catch(e) {}
                }, 150);
            }
            this.processNext();
        };
        
        utterance.onerror = () => {
            this.isSpeaking = false;
            activeSpeechPriority = 0;
            if (this.watchdogTimer) {
                clearTimeout(this.watchdogTimer);
                this.watchdogTimer = null;
            }
            // Resume continuous listening when speech finishes
            if (isSafetyActive || startupWaitAnswer || contactSetupState !== "IDLE" || sosWaitDialChoice) {
                setTimeout(() => {
                    try { recognition.start(); } catch(e) {}
                }, 150);
            }
            this.processNext();
        };
        
        if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
        this.watchdogTimer = setTimeout(() => {
            if (SpeechSynthesis.speaking) {
                console.warn("Speech Synthesis watchdog timed out. Preempting.");
                SpeechSynthesis.cancel();
                this.isSpeaking = false;
                activeSpeechPriority = 0;
                this.processNext();
            }
        }, priority >= 100 ? 4000 : 6000);
        
        SpeechSynthesis.speak(utterance);
    }
}

const speechQueue = new SpeechQueue();

function speak(message, priorityOrInterrupt = 30, legacyInterrupt = false) {
    if (!message) return;
    
    subtitleText.textContent = `"${message}"`;
    
    let priority = 30;
    if (typeof priorityOrInterrupt === "boolean") {
        priority = priorityOrInterrupt ? 100 : 30;
    } else {
        priority = priorityOrInterrupt;
    }
    
    if (typeof SpeechSynthesis !== "undefined" && SpeechSynthesis && SpeechSynthesis.paused) {
        SpeechSynthesis.resume();
    }
    
    speechQueue.add(message, priority);
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
    
    if (alert.state === "SAFE") {
        announcedAlertsHistory = {};
        shouldSpeak = (lastAnnouncedAlert.state !== "SAFE");
        alertState = "NEW";
    } else {
        const cached = announcedAlertsHistory[trackId];
        if (cached) {
            const timeDiff = (currentTime - cached.timestamp) / 1000.0;
            const riskDiff = alert.risk - cached.risk;
            const stateChanged = alert.state !== cached.state;
            
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
    }
    
    if (shouldSpeak) {
        const alertRecord = {
            trackId: trackId,
            message: currentMsg,
            state: alert.state,
            risk: alert.risk,
            timestamp: currentTime
        };
        announcedAlertsHistory[trackId] = alertRecord;
        lastAnnouncedAlert = alertRecord;
        
        if (alert.state === "CRITICAL") {
            if (typeof SpeechSynthesis !== "undefined" && SpeechSynthesis) {
                SpeechSynthesis.cancel();
            }
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
        } else if (alert.state === "SAFE") {
            speak("Path ahead is clear.", 30, false);
            if (ariaLivePolite) {
                ariaLivePolite.textContent = "Path ahead is clear.";
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
        
        try {
            const videoTrack = localMediaStream.getVideoTracks()[0];
            const settings = videoTrack.getSettings();
            isFrontFacingCamera = settings.facingMode === "user";
            addDiagLog(`Active camera: ${settings.facingMode || "unknown"} (Front camera: ${isFrontFacingCamera})`);
        } catch (e) {
            isFrontFacingCamera = false;
        }
        
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
        const trackId = det.id !== undefined ? `[${det.id}] ` : "";
        const label = devModeActive ? 
            `${det.object.toUpperCase()} ${trackId}(${Math.round(det.confidence*100)}%) [RISK: ${det.risk || 0}%] - ${det.motion}` : 
            `${det.object.toUpperCase()} (${det.risk || 0}%)`;
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
        streamInterval = setInterval(sendFrameToBackend, 150);
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
    
    // Render 2D Top-Down Radar Proximity Map (T18 & T19)
    try {
        renderRadarMap(allDetections);
    } catch (e) {
        console.warn("Radar rendering failed:", e);
    }
    
    // Handle Audio status feedback
    if (data.audio_hazard) {
        audioStateText.textContent = "HORN DETECTED!";
        audioStateText.className = "text-red-500 font-extrabold animate-pulse";
        statusAudio.className = "text-red-500";
        
        if (!scanState.active && isSafetyActive) {
            speak("Vehicle-related sound detected. Scanning surroundings.", 100, true);
            setTimeout(() => {
                triggerSmartScan();
            }, 3000);
        }
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
    
    // Front-Facing Camera Mirror Inversion Correction (P0.3)
    if (isFrontFacingCamera && alert.direction) {
        let dir = alert.direction.toLowerCase();
        if (dir.includes("left")) {
            alert.direction = alert.direction.replace(/left/gi, "right");
        } else if (dir.includes("right")) {
            alert.direction = alert.direction.replace(/right/gi, "left");
        }
        
        if (alert.message) {
            let msg = alert.message.toLowerCase();
            if (msg.includes("left")) {
                alert.message = alert.message.replace(/left/gi, "right");
            } else if (msg.includes("right")) {
                alert.message = alert.message.replace(/right/gi, "left");
            }
        }
    }
    
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
    
    // Spoken alerts processed through T13 Speech Guard with P0 temporal rules
    if (alert.state === "SAFE") {
        processSafetyAlert(alert, false);
    } else {
        const trackId = alert.id !== undefined ? alert.id : alert.object;
        const trackStr = trackId.toString();
        
        trackConfirmationFrames[trackStr] = (trackConfirmationFrames[trackStr] || 0) + 1;
        
        // Critical alerts, person, computer or screen detections bypass 3-frame delay; Caution/Alert require 3 confirmations
        if (alert.state === "CRITICAL" || alert.object === "person" || alert.object === "computer" || alert.object === "computer screen" || trackConfirmationFrames[trackStr] >= 3) {
            processSafetyAlert(alert, false);
        } else {
            addDiagLog(`[GATING] Ignoring ${alert.object} (seen ${trackConfirmationFrames[trackStr]}/3 frames)`);
        }
    }
    
    // Automatic OCR detection trigger (P1.14)
    if (data.text_present) {
        triggerAutoOCR();
    }
}

// -------------------------------------------------------------
// Voice Commands Routing Engine
// -------------------------------------------------------------
function handleVoiceCommand(command) {
    addDiagLog(`Command parsing: "${command}"`);
    
    // 0. Startup voice response handler
    if (startupWaitAnswer) {
        if (command.includes("yes") || command.includes("start")) {
            startupWaitAnswer = false;
            const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
            fetch(`/api/emergency/contacts?session_id=${sess}`)
                .then(res => res.json())
                .then(data => {
                    emergencyContacts = data.contacts || [];
                    if (emergencyContacts.length === 0) {
                        speak("I notice you have not set up any emergency contacts. Let's add your first contact. Say enter number to provide a number.", true);
                        contactSetupState = "WAITING_FOR_SOURCE";
                    } else {
                        if (!isSafetyActive) toggleSafetyMode();
                        speak("Safety mode active. Beeper and haptics initialized.", true);
                    }
                })
                .catch(err => {
                    if (!isSafetyActive) toggleSafetyMode();
                    speak("Safety mode active. Beeper and haptics initialized.", true);
                });
        } else if (command.includes("no") || command.includes("stop")) {
            startupWaitAnswer = false;
            speak("Safety mode not started. SAHAAI is on standby.", true);
        } else {
            speak("Should I start safety mode? Say yes or no.", true);
        }
        return;
    }
    
    // 0.1 SOS Emergency Dialer Choice response handler (P1.7)
    if (sosWaitDialChoice) {
        if (command.includes("contact") || command.includes("call contact")) {
            sosWaitDialChoice = false;
            if (emergencyContacts.length > 0) {
                const c = emergencyContacts[0];
                speak(`Calling emergency contact: ${c.name}.`, true);
                setTimeout(() => { window.location.href = `tel:${c.phone_number}`; }, 1200);
            } else {
                speak("No emergency contact found.", true);
            }
        } else if (command.includes("112") || command.includes("one one two")) {
            sosWaitDialChoice = false;
            speak("Calling emergency services 112.", true);
            setTimeout(() => { window.location.href = "tel:112"; }, 1200);
        } else if (command.includes("108") || command.includes("one zero eight") || command.includes("one oh eight")) {
            sosWaitDialChoice = false;
            speak("Calling emergency services 108.", true);
            setTimeout(() => { window.location.href = "tel:108"; }, 1200);
        } else if (command.includes("cancel") || command.includes("stop")) {
            sosWaitDialChoice = false;
            speak("Calling cancelled.", true);
        } else {
            speak("Say CONTACT, 112, or 108.", true);
        }
        return;
    }
    
    // 1. Voice cancellation during countdown (T21.7)
    if (emergencyState === "COUNTDOWN" && command.includes("cancel")) {
        cancelEmergencySOS();
        return;
    }
    
    // 2. Voice-guided emergency contact configuration state machine (T21.2)
    if (contactSetupState === "WAITING_FOR_SOURCE") {
        if (command.includes("enter number")) {
            speak("Say the contact name.", true);
            contactSetupState = "WAITING_FOR_NAME";
            return;
        } else if (command.includes("choose contact")) {
            // Simulated Phone picker hook for accessibility
            speak("Mom chosen, ending in 4321. Should I save this contact? Say yes or no.", true);
            tempContactName = "Mom";
            tempContactPhone = "987654321";
            contactSetupState = "WAITING_FOR_CONFIRMATION";
            return;
        } else {
            speak("Say enter number, or choose contact.", true);
            return;
        }
    }
    
    if (contactSetupState === "WAITING_FOR_NAME") {
        tempContactName = command.replace("contact name is", "").replace("name is", "").trim();
        speak(`Say ${tempContactName}'s phone number.`, true);
        contactSetupState = "WAITING_FOR_NUMBER";
        return;
    }
    
    if (contactSetupState === "WAITING_FOR_NUMBER") {
        const numbersOnly = command.replace(/\D/g, "");
        if (numbersOnly.length >= 4) {
            tempContactPhone = numbersOnly;
            const lastFour = tempContactPhone.substring(tempContactPhone.length - 4);
            speak(`${tempContactName}, phone number ending in ${lastFour}. Should I save this contact? Say yes or no.`, true);
            contactSetupState = "WAITING_FOR_CONFIRMATION";
        } else {
            speak("Please say the phone number again.", true);
        }
        return;
    }
    
    if (contactSetupState === "WAITING_FOR_CONFIRMATION") {
        if (command.includes("yes")) {
            saveEmergencyContactVoice(tempContactName, tempContactPhone);
            contactSetupState = "IDLE";
        } else {
            speak("Setup cancelled.", true);
            contactSetupState = "IDLE";
        }
        return;
    }
    
    // 3. Normal voice commands (forgiving command parser T21)
    const isWhatAhead = command.includes("what is ahead") || command.includes("what's ahead") || command.includes("describe");
    const isScan = command.includes("scan around") || command.includes("start scan") || command.includes("scan");
    const isReadText = command.includes("read text") || command.includes("read sign") || command.includes("read this") || command.includes("ocr");
    const isHelp = command.includes("help") || command.includes("emergency") || command.includes("sos");
    const isStartSafety = command.includes("start safety") || command.includes("activate mode") || command === "start" || command === "safety mode";
    const isCancel = command.includes("cancel") || command === "stop";
    
    if (isWhatAhead) {
        speak("Analyzing what is ahead of you.", true);
        if (socket && socket.readyState === WebSocket.OPEN) {
            sendFrameToBackend();
        }
    } else if (isScan) {
        triggerSmartScan();
    } else if (isReadText) {
        triggerOCR();
    } else if (isHelp) {
        triggerEmergencySOS("voice");
    } else if (isCancel) {
        cancelEmergencySOS();
    } else if (command.includes("set up emergency contacts") || command.includes("setup contacts")) {
        speak("Emergency contact setup. You can add up to three contacts. Say enter number to provide a number.", true);
        contactSetupState = "WAITING_FOR_SOURCE";
    } else if (command.includes("list my emergency contacts") || command.includes("list emergency contacts")) {
        listEmergencyContactsVoice();
    } else if (command.startsWith("remove") || command.startsWith("delete")) {
        const nameToRemove = command.replace("remove", "").replace("delete", "").trim();
        removeEmergencyContactVoice(nameToRemove);
    } else if (command.includes("call emergency") || command.includes("call 112")) {
        speak("Opening emergency call to 112.", true);
        setTimeout(() => { window.location.href = "tel:112"; }, 1000);
    } else if (isStartSafety) {
        if (!isSafetyActive) toggleSafetyMode();
    } else {
        speak("Command not recognized.");
    }
}

// -------------------------------------------------------------
// Pillar C: Smart Scan Sequence State Machine
// -------------------------------------------------------------
// -------------------------------------------------------------
// Pillar C: Guided Smart Scan Sequence State Machine (T16 & T17)
// -------------------------------------------------------------
async function triggerSmartScan() {
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
    
    scanState.startTime = Date.now();
    scanState.scanUuid = "mock-scan-uuid";
    
    // Register scan session in the background (T17.10)
    try {
        const res = await fetch("/api/scan/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: "scan_session_" + Date.now() })
        });
        const data = await res.json();
        if (data.scan_uuid) {
            scanState.scanUuid = data.scan_uuid;
            addDiagLog(`Registered scan session with UUID: ${data.scan_uuid}`);
        }
    } catch (err) {
        console.warn("Failed to register scan session, using fallback:", err);
    }
    
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
    speak(`${step} position reached. Hold.`, 30, true);
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
    
    // Safety relevant classes to filter out noise (T17.5)
    const SAFETY_CLASSES = ["person", "car", "motorcycle", "bicycle", "bus", "truck", "dog", "backpack", "suitcase", "chair", "stop sign"];
    
    // Group occurrences by track_id + object_class (T16.2)
    const counts = {};
    const maxRiskMap = {};
    const maxConfidenceMap = {};
    const motionMap = {};
    
    allFrames.forEach(frame => {
        frame.forEach(det => {
            const className = det.object.toLowerCase();
            // Filter noise immediately
            if (!SAFETY_CLASSES.includes(className)) return;
            
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
    let highestRiskObj = "clear";
    let maxRiskScore = 0;
    
    Object.keys(counts).forEach(key => {
        const parts = key.split("_");
        const objectClass = parts[1];
        const count = counts[key];
        const persistence = count / Math.max(1, totalFrames);
        const maxRisk = maxRiskMap[key];
        const maxConfidence = maxConfidenceMap[key];
        const isApproaching = motionMap[key] === "approaching";
        
        // Class-sensitive persistence thresholds (T16.2 + T17.2)
        // Static require >= 50% (3/5 frames). Moving/Critical require risk >= 85 AND confidence >= 0.85
        let keep = false;
        if (maxRisk >= 85 && maxConfidence >= 0.85) {
            keep = true; // Retain critical threat
        } else if (isApproaching && maxConfidence >= 0.80) {
            keep = true; // Retain approaching vehicle/person
        } else if (persistence >= 0.50) {
            keep = true; // Retain stable environmental hazard
        }
        
        if (keep) {
            finalObjects.push({
                class: objectClass,
                risk: maxRisk,
                confidence: maxConfidence,
                motion: isApproaching ? "APPROACHING" : "STATIC"
            });
            
            if (maxRisk > maxRiskScore) {
                maxRiskScore = maxRisk;
                highestRiskObj = objectClass;
            }
        }
    });
    
    scanState.collectedData[step] = finalObjects;
    addDiagLog(`Scan step ${step} complete. Captured: ${JSON.stringify(finalObjects)}`);
    
    // Log result for this sector to the database in background (T17.10)
    if (scanState.scanUuid) {
        fetch("/api/scan/result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                scan_uuid: scanState.scanUuid,
                direction: step,
                hazard: highestRiskObj,
                risk_score: maxRiskScore
            })
        }).catch(err => console.warn("Failed to log scan result:", err));
    }
    
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
        speak("Right complete. Rotate behind you.", 30, true);
        setStepSensorTimeout();
    } else if (step === "REAR") {
        scanState.currentStep = "COMPILING";
        compileScanSummary();
    }
}

function compileScanSummary() {
    scanInstruction.textContent = "Compiling environmental scan results...";
    speak("Scan complete. Compiling results.", 30, true);
    
    const zones = ["LEFT", "CENTER", "RIGHT", "REAR"];
    let leadWarningText = "";
    const otherZonesParts = [];
    let criticalCount = 0;
    let highRiskCount = 0;
    
    zones.forEach(zone => {
        const items = scanState.collectedData[zone] || [];
        
        if (items.length === 0) {
            otherZonesParts.push(`${zone.toLowerCase()} side is clear`);
        } else {
            const classCounts = {};
            let zoneMaxRisk = 0;
            let targetObj = null;
            
            items.forEach(it => {
                classCounts[it.class] = (classCounts[it.class] || 0) + 1;
                if (it.risk > zoneMaxRisk) {
                    zoneMaxRisk = it.risk;
                    targetObj = it;
                }
                if (it.risk >= 85) {
                    criticalCount++;
                } else if (it.risk >= 65) {
                    highRiskCount++;
                }
            });
            
            // Format grouped item count text (T17.4)
            const itemDescs = Object.keys(classCounts).map(className => {
                const count = classCounts[className];
                const plural = count > 1 ? (className.endsWith("s") ? className : className + "s") : className;
                return `${count} ${plural}`;
            });
            
            // Apply summary length limit (T17.6)
            let formattedList = "";
            if (itemDescs.length > 2) {
                formattedList = "multiple obstacles";
            } else {
                formattedList = itemDescs.join(" and ");
            }
            
            // Build motion-aware actionability wording (T17.1 + T17.3)
            let zoneDesc = "";
            if (zoneMaxRisk >= 85 && targetObj) {
                // Critical
                const actionWord = targetObj.motion === "APPROACHING" ? "approaching" : "detected";
                zoneDesc = `Critical. ${targetObj.class} ${actionWord} on your ${zone.toLowerCase()}`;
                leadWarningText = zoneDesc;
            } else if (zoneMaxRisk >= 65 && targetObj) {
                // Warning
                const actionWord = targetObj.motion === "APPROACHING" ? "approaching" : "detected";
                zoneDesc = `Warning. ${targetObj.class} ${actionWord} on your ${zone.toLowerCase()}`;
                if (!leadWarningText) {
                    leadWarningText = zoneDesc;
                } else {
                    otherZonesParts.push(zoneDesc);
                }
            } else {
                // Standard info
                otherZonesParts.push(`on your ${zone.toLowerCase()}: ${formattedList}`);
            }
        }
    });
    
    // Assemble final output sentence structure (T17.7)
    let summaryText = "";
    if (leadWarningText) {
        summaryText = leadWarningText;
        if (otherZonesParts.length > 0) {
            summaryText += ". " + otherZonesParts.join(". ");
        }
    } else {
        const allClear = zones.every(z => (scanState.collectedData[z] || []).length === 0);
        if (allClear) {
            summaryText = "Smart scan complete. Environment clear.";
        } else {
            summaryText = "Scan complete. " + otherZonesParts.join(". ");
        }
    }
    
    // Clean string formats
    summaryText = summaryText.replace(/\.+/g, ".").trim();
    if (!summaryText.endsWith(".")) summaryText += ".";
    
    // Play with priority 60 (ALERT level) (T17.8)
    const alertObject = {
        state: criticalCount > 0 ? "CRITICAL" : (highRiskCount > 0 ? "ALERT" : "SAFE"),
        object: "scan_summary",
        risk: criticalCount > 0 ? 90 : (highRiskCount > 0 ? 70 : 0),
        message: summaryText,
        direction: "around",
        proximity: "none",
        motion: "static"
    };
    
    setTimeout(() => {
        try { scanDialog.close(); } catch (e) {}
        
        // Handoff to T13 Speech preemption and live regions (T17.2)
        processSafetyAlert(alertObject, true);
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

let lastOCRTime = 0;
let announcedTextCache = {};
let ocrInProgress = false;

async function triggerAutoOCR() {
    if (!isSafetyActive) return;
    
    const now = Date.now();
    if (ocrInProgress || (now - lastOCRTime < 3000)) return;
    
    if (activeSpeechPriority >= 100) return;
    
    ocrInProgress = true;
    lastOCRTime = now;
    
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 320;
    tempCanvas.height = 240;
    const tempCtx = tempCanvas.getContext("2d");
    
    if (localMediaStream && video.readyState === video.HAVE_ENOUGH_DATA) {
        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        const base64Image = tempCanvas.toDataURL("image/jpeg", 0.6);
        
        try {
            const res = await fetch("/api/ocr", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ image_base64: base64Image })
            });
            const data = await res.json();
            
            if (data.text && data.text.trim()) {
                const normText = data.text.toLowerCase().trim().replace(/[^a-z0-9 ]/g, "");
                
                if (normText) {
                    const cachedTime = announcedTextCache[normText];
                    if (!cachedTime || (now - cachedTime > 15000)) {
                        announcedTextCache[normText] = now;
                        speak(data.text, 30, false);
                        addDiagLog(`[AUTO OCR] Read: "${data.text}"`);
                    } else {
                        addDiagLog(`[AUTO OCR] Suppressed duplicate: "${data.text}"`);
                    }
                }
            }
        } catch (err) {
            console.warn("Auto OCR failed:", err);
        }
    }
    
    ocrInProgress = false;
}

// -------------------------------------------------------------
// Emergency SOS Modal
// -------------------------------------------------------------
function triggerEmergencySOS(source = "button") {
    const finalSource = (typeof source === "string") ? source : "button";
    if (emergencyState !== "IDLE") return;
    
    emergencyState = "COUNTDOWN";
    try { emergencyDialog.showModal(); } catch (e) {}
    
    // Reset UI Elements
    emergencyHeader.textContent = "SOS COUNTDOWN";
    emergencyHeader.className = "text-2xl font-black text-red-400 uppercase tracking-widest";
    sosCountdown.textContent = "5";
    sosCountdown.classList.remove("hidden");
    emergencyDetailsCard.classList.add("hidden");
    dialEmergencyBtn.classList.add("hidden");
    emergencyStatusMsg.textContent = "Say CANCEL or tap button to stop.";
    emergencyStatusMsg.classList.remove("hidden");
    
    speak("Emergency alert will be sent in five seconds. Say cancel to stop.", true);
    addDiagLog("SOS countdown started.");
    
    let secondsLeft = 5;
    playCountdownBeep();
    
    clearInterval(sosTimer);
    sosTimer = setInterval(() => {
        secondsLeft--;
        sosCountdown.textContent = secondsLeft;
        
        if (secondsLeft > 0) {
            speak(secondsLeft.toString(), true);
            playCountdownBeep();
        } else {
            clearInterval(sosTimer);
            executeEmergencySOS(finalSource);
        }
    }, 1000);
}

function cancelEmergencySOS() {
    if (emergencyState === "IDLE") return;
    
    clearInterval(sosTimer);
    
    // If cancelled during countdown, push log
    if (emergencyState === "COUNTDOWN") {
        const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
        fetch("/api/emergency/trigger", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: sess,
                trigger_source: "voice_cancel",
                status: "CANCELLED",
                location_available: false,
                contacts_notified: 0
            })
        }).catch(err => console.warn(err));
    }
    
    emergencyState = "IDLE";
    updateSafetyState("SAFE");
    try { emergencyDialog.close(); } catch (e) {}
    
    speak("Emergency alert cancelled.", true);
    addDiagLog("Emergency SOS cancelled.");
}

let currentLat = null;
let currentLon = null;
let currentAcc = null;
let currentLocAvailable = false;

function executeEmergencySOS(source) {
    emergencyState = "LOCATION_REQUEST";
    
    emergencyHeader.textContent = "SOS ACTIVE";
    emergencyHeader.className = "text-2xl font-black text-red-600 uppercase tracking-widest animate-pulse";
    sosCountdown.classList.add("hidden");
    emergencyStatusMsg.textContent = "Acquiring coordinates...";
    emergencyDetailsCard.classList.remove("hidden");
    sosStatusText.textContent = "LOCATION REQUEST";
    sosStatusText.className = "text-yellow-500 font-bold animate-pulse";
    
    updateSafetyState("CRITICAL"); // triggers continuous alarm T13
    
    // Reset background GPS cache
    currentLat = null;
    currentLon = null;
    currentAcc = null;
    currentLocAvailable = false;
    
    // Fetch Location in Parallel (P1.7)
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                currentLat = pos.coords.latitude;
                currentLon = pos.coords.longitude;
                currentAcc = pos.coords.accuracy;
                currentLocAvailable = true;
                addDiagLog("GPS location resolved in background.");
                sendSOSAlert(source, currentLat, currentLon, currentAcc, true);
            },
            (err) => {
                console.warn("GPS Background access failed:", err);
                sendSOSAlert(source, null, null, null, false);
            },
            { enableHighAccuracy: true, timeout: 5000 }
        );
    } else {
        sendSOSAlert(source, null, null, null, false);
    }
    
    // Set dialing choice listener
    sosWaitDialChoice = true;
    
    let contactPrompt = "";
    if (emergencyContacts.length > 0) {
        const primary = emergencyContacts[0].name;
        contactPrompt = `Your emergency contact is ${primary}. Say CONTACT, 112, or 108.`;
    } else {
        contactPrompt = "No emergency contact found. Say 112, or 108.";
    }
    
    speak(contactPrompt, 100, true);
    
    // Automatically trigger continuous listening for the choice
    setTimeout(() => {
        if (sosWaitDialChoice && recognition) {
            try { recognition.start(); } catch (e) {}
        }
    }, 4500);
}

function sendSOSAlert(source, lat, lon, acc, locationAvailable) {
    emergencyState = "SOS_ACTIVE";
    
    sosStatusText.textContent = "SOS BROADCAST ACTIVE";
    sosStatusText.className = "text-red-500 font-bold animate-pulse";
    sosContactsCount.textContent = `${emergencyContacts.length} contacts notified`;
    
    if (locationAvailable && lat !== null) {
        sosCoordsText.textContent = `LAT: ${lat.toFixed(4)} | LON: ${lon.toFixed(4)} (±${acc.toFixed(0)}m)`;
        speak("Emergency alert sent to emergency contacts. Location shared.", 100, true);
    } else {
        sosCoordsText.textContent = "LOCATION UNAVAILABLE";
        speak("Emergency alert sent, but your location is unavailable.", 100, true);
    }
    
    dialEmergencyBtn.classList.remove("hidden");
    emergencyStatusMsg.classList.add("hidden");
    
    const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
    
    fetch("/api/emergency/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            session_id: sess,
            trigger_source: source,
            status: "ACTIVE",
            latitude: lat,
            longitude: lon,
            accuracy_m: acc,
            location_available: locationAvailable,
            contacts_notified: emergencyContacts.length,
            contacts: emergencyContacts
        })
    }).then(res => {
        addDiagLog("SOS Active logged to Supabase.");
    }).catch(err => {
        console.warn("Supabase emergency insert failed:", err);
    });
}

function playCountdownBeep() {
    if (typeof audioCtx === "undefined" || !audioCtx) return;
    try {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz alert tone
        gainNode.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);
    } catch (e) {
        console.warn(e);
    }
}

closeEmergencyBtn.addEventListener("click", cancelEmergencySOS);

// Contacts Dialog & Management Listeners (T21)
if (contactsBtn) {
    contactsBtn.addEventListener("click", () => {
        loadContactsList();
        try { contactsDialog.showModal(); } catch (e) {}
    });
}

if (closeContactsBtn) {
    closeContactsBtn.addEventListener("click", () => {
        try { contactsDialog.close(); } catch (e) {}
    });
}

async function loadContactsList() {
    if (!contactsList) return;
    try {
        const localData = localStorage.getItem("sahaai_contacts");
        emergencyContacts = localData ? JSON.parse(localData) : [];
        
        if (emergencyContacts.length === 0) {
            contactsList.innerHTML = "<div class='text-slate-500 italic'>No emergency contacts saved. Add one below or use voice setup.</div>";
            return;
        }
        
        contactsList.innerHTML = "";
        emergencyContacts.forEach(c => {
            const div = document.createElement("div");
            div.className = "flex justify-between items-center bg-slate-950 border border-slate-800 p-2.5 rounded-xl";
            div.innerHTML = `
                <div class="flex flex-col">
                    <span class="font-bold text-slate-300 text-xs">${c.name}</span>
                    <span class="text-[10px] text-slate-500">${c.phone_number.substring(0, Math.max(0, c.phone_number.length - 4))}****</span>
                </div>
                <button onclick="deleteContactInline('${c.name}')" class="text-red-500 font-bold hover:text-red-400 text-xs uppercase px-2 py-1">Remove</button>
            `;
            contactsList.appendChild(div);
        });
    } catch (e) {
        contactsList.innerHTML = "<div class='text-red-500'>Failed to load contacts.</div>";
    }
}

window.deleteContactInline = async function(name) {
    try {
        const localData = localStorage.getItem("sahaai_contacts");
        let list = localData ? JSON.parse(localData) : [];
        list = list.filter(c => c.name !== name);
        localStorage.setItem("sahaai_contacts", JSON.stringify(list));
        emergencyContacts = list;
        addDiagLog(`Removed contact: ${name}`);
        speak(`${name} has been removed.`, true);
        loadContactsList();
    } catch (e) {
        console.error(e);
    }
};

if (addContactForm) {
    addContactForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = contactNameInput.value.trim();
        const phone = contactPhoneInput.value.trim();
        
        if (emergencyContacts.length >= 3) {
            speak("Maximum of three emergency contacts reached.", true);
            return;
        }
        
        try {
            const localData = localStorage.getItem("sahaai_contacts");
            const list = localData ? JSON.parse(localData) : [];
            list.push({
                session_id: session_id,
                name: name,
                phone_number: phone,
                priority: list.length + 1,
                verified: true
            });
            localStorage.setItem("sahaai_contacts", JSON.stringify(list));
            emergencyContacts = list;
            
            contactNameInput.value = "";
            contactPhoneInput.value = "";
            addDiagLog(`Saved contact: ${name}`);
            speak(`${name} has been saved as your emergency contact.`, true);
            loadContactsList();
        } catch (err) {
            console.error(err);
        }
    });
}

async function saveEmergencyContactVoice(name, phone) {
    const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
    if (emergencyContacts.length >= 3) {
        speak("Maximum of three emergency contacts reached.", true);
        return;
    }
    
    try {
        const localData = localStorage.getItem("sahaai_contacts");
        const list = localData ? JSON.parse(localData) : [];
        list.push({
            session_id: session_id,
            name: name,
            phone_number: phone,
            priority: list.length + 1,
            verified: true
        });
        localStorage.setItem("sahaai_contacts", JSON.stringify(list));
        emergencyContacts = list;
        
        addDiagLog(`Saved contact voice: ${name}`);
        speak(`${name} has been saved as your emergency contact.`, true);
    } catch (e) {
        speak("Failed to save contact.", true);
    }
}

async function listEmergencyContactsVoice() {
    try {
        const localData = localStorage.getItem("sahaai_contacts");
        emergencyContacts = localData ? JSON.parse(localData) : [];
        
        if (emergencyContacts.length === 0) {
            speak("You have no saved emergency contacts.", true);
        } else {
            const names = emergencyContacts.map(c => c.name).join(", ");
            speak(`Your emergency contacts are: ${names}.`, true);
        }
    } catch (e) {
        speak("Failed to load contacts list.", true);
    }
}

async function removeEmergencyContactVoice(name) {
    const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
    try {
        const res = await fetch(`/api/emergency/contact?session_id=${sess}&name=${encodeURIComponent(name)}`, {
            method: "DELETE"
        });
        const data = await res.json();
        if (data.success) {
            speak(`${name} has been removed.`, true);
            const contactsRes = await fetch(`/api/emergency/contacts?session_id=${sess}`);
            const contactsData = await contactsRes.json();
            emergencyContacts = contactsData.contacts || [];
        } else {
            speak("Contact not found.", true);
        }
    } catch (e) {
        speak("Failed to delete contact.", true);
    }
}

// -------------------------------------------------------------
// Pillar D: 2D Sonar Radar Proximity Map & Spatial Log Engine (T18-T20)
// -------------------------------------------------------------
function renderRadarMap(detections) {
    if (!radarCtx || !radarMapCanvas) return;
    
    // Clear canvas
    radarCtx.clearRect(0, 0, radarMapCanvas.width, radarMapCanvas.height);
    
    const userX = 100;
    const userY = 180;
    
    // Draw radar background grids (Sonar circles)
    radarCtx.strokeStyle = "#1e293b";
    radarCtx.lineWidth = 1;
    
    // Draw grid rings
    const ringRadii = [40, 90, 140, 170];
    ringRadii.forEach(r => {
        radarCtx.beginPath();
        radarCtx.arc(userX, userY, r, Math.PI, 2 * Math.PI); // top half circles
        radarCtx.stroke();
    });
    
    // Draw angular guidelines (30 degree lines)
    radarCtx.strokeStyle = "#1e293b";
    [-30, 30].forEach(deg => {
        const rad = deg * Math.PI / 180;
        radarCtx.beginPath();
        radarCtx.moveTo(userX, userY);
        radarCtx.lineTo(userX + 170 * Math.sin(rad), userY - 170 * Math.cos(rad));
        radarCtx.stroke();
    });
    
    // Pulse animation logic for dynamic threat rings (T19)
    const pulseOpacity = 0.3 + 0.2 * Math.sin(Date.now() / 150);
    
    // Check threat states
    let maxState = "SAFE";
    if (detections && detections.length > 0) {
        detections.forEach(det => {
            if (det.state === "CRITICAL") maxState = "CRITICAL";
            else if (det.state === "ALERT" && maxState !== "CRITICAL") maxState = "ALERT";
            else if (det.state === "CAUTION" && maxState !== "CRITICAL" && maxState !== "ALERT") maxState = "CAUTION";
        });
    }
    
    // Draw active dynamic ring fills (T19)
    if (maxState === "CRITICAL") {
        radarCtx.strokeStyle = `rgba(239, 68, 68, ${pulseOpacity})`; // red
        radarCtx.lineWidth = 4;
        radarCtx.beginPath();
        radarCtx.arc(userX, userY, 40, Math.PI, 2 * Math.PI);
        radarCtx.stroke();
    } else if (maxState === "ALERT") {
        radarCtx.strokeStyle = `rgba(249, 115, 22, ${pulseOpacity})`; // orange
        radarCtx.lineWidth = 3;
        radarCtx.beginPath();
        radarCtx.arc(userX, userY, 90, Math.PI, 2 * Math.PI);
        radarCtx.stroke();
    } else if (maxState === "CAUTION") {
        radarCtx.strokeStyle = `rgba(234, 179, 8, ${pulseOpacity})`; // yellow
        radarCtx.lineWidth = 2;
        radarCtx.beginPath();
        radarCtx.arc(userX, userY, 140, Math.PI, 2 * Math.PI);
        radarCtx.stroke();
    }
    
    // Draw user icon at bottom center
    radarCtx.fillStyle = "#3b82f6"; // blue
    radarCtx.beginPath();
    radarCtx.arc(userX, userY, 8, 0, 2 * Math.PI);
    radarCtx.fill();
    radarCtx.fillStyle = "#ffffff";
    radarCtx.font = "bold 8px sans-serif";
    radarCtx.fillText("YOU", userX - 8, userY + 14);
    
    const frameWidth = video.videoWidth || 640;
    const frameHeight = video.videoHeight || 480;
    const centerX = frameWidth / 2;
    const currentTrackIds = new Set();
    
    if (detections && detections.length > 0) {
        detections.forEach(det => {
            const trackId = det.id !== undefined ? det.id : det.object;
            const trackStr = trackId.toString();
            currentTrackIds.add(trackStr);
            
            // Bounding box dimensions
            const [xmin, ymin, xmax, ymax] = det.bbox;
            const centroidX = xmin + (xmax - xmin) / 2;
            const bboxHeight = ymax - ymin;
            
            // 1. Resolution-independent relative angle (T18.1)
            const rawNormX = (centroidX - centerX) / centerX;
            const normalizedX = isFrontFacingCamera ? -rawNormX : rawNormX;
            const theta = normalizedX * 30 * (Math.PI / 180); // FOV edge +/-30 degrees
            
            // 2. Resolution-independent relative proximity depth (T18.1)
            const depthNorm = Math.min(1.0, (bboxHeight / frameHeight) * 2.2);
            
            // 3. Cartesian normalized positions (X is left/right, Y is distance forward)
            const xNorm = depthNorm * Math.sin(theta);
            const yNorm = depthNorm * Math.cos(theta);
            
            // Map to canvas pixels relative to user coordinates (T18.3)
            const canvasX = userX + xNorm * 170;
            const canvasY = userY - yNorm * 170;
            
            // Trajectory Trail Updates (T18.5)
            if (!trackHistory[trackStr]) {
                trackHistory[trackStr] = [];
            }
            trackHistory[trackStr].push({ x: canvasX, y: canvasY, time: Date.now() });
            if (trackHistory[trackStr].length > 5) {
                trackHistory[trackStr].shift();
            }
            trackHistory[trackStr].missingCount = 0; // reset missing counter
            
            // Render Trails (connecting lines & dots)
            const trail = trackHistory[trackStr];
            if (trail.length > 1) {
                radarCtx.beginPath();
                radarCtx.strokeStyle = "rgba(148, 163, 184, 0.4)";
                radarCtx.lineWidth = 1;
                radarCtx.moveTo(trail[0].x, trail[0].y);
                for (let i = 1; i < trail.length; i++) {
                    radarCtx.lineTo(trail[i].x, trail[i].y);
                }
                radarCtx.stroke();
                
                trail.forEach((pt, i) => {
                    const alpha = (i + 1) / trail.length * 0.4;
                    radarCtx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
                    radarCtx.beginPath();
                    radarCtx.arc(pt.x, pt.y, 2, 0, 2 * Math.PI);
                    radarCtx.fill();
                });
            }
            
            // Threat coloring
            const color = det.state === "CRITICAL" ? "#ef4444" : 
                          det.state === "ALERT" ? "#f97316" : 
                          det.state === "CAUTION" ? "#eab308" : "#22c55e";
                          
            // Draw main obstacle dot
            radarCtx.fillStyle = color;
            radarCtx.beginPath();
            radarCtx.arc(canvasX, canvasY, 6, 0, 2 * Math.PI);
            radarCtx.fill();
            
            // Label
            radarCtx.fillStyle = "#ffffff";
            radarCtx.font = "bold 8px monospace";
            const label = devModeActive ? `[${trackStr}] ${det.object.substring(0, 5)}` : `${det.object.substring(0, 5)}`;
            radarCtx.fillText(label, canvasX + 8, canvasY + 3);
            
            // T20: Event-Based DB Logging logic (Gating filters)
            const cached = trackLoggedState[trackStr];
            const stateKey = det.state || "SAFE";
            
            // Audio Fusion indicator check
            const hasFusion = det.reason && det.reason.some(r => r.includes("audio verified"));
            const eventType = hasFusion ? "AUDIO_FUSION" : "NEW_HAZARD";
            
            if (!cached) {
                const newObj = { x_norm: xNorm, depth_norm: yNorm, risk: det.risk || 0, state: stateKey, object: det.object, motion: det.motion };
                trackLoggedState[trackStr] = newObj;
                logSpatialEvent(trackStr, eventType, newObj);
            } else {
                const isEscalated = stateKey !== cached.state || (hasFusion && cached.state !== "FUSED");
                
                // Euclidean distance delta displacement (T20.7)
                const dx = xNorm - cached.x_norm;
                const dy = yNorm - cached.depth_norm;
                const delta = Math.sqrt(dx * dx + dy * dy);
                
                if (isEscalated) {
                    cached.state = hasFusion ? "FUSED" : stateKey;
                    cached.risk = det.risk || 0;
                    logSpatialEvent(trackStr, hasFusion ? "AUDIO_FUSION" : "HAZARD_ESCALATE", cached);
                } else if (delta > 0.15) {
                    cached.x_norm = xNorm;
                    cached.depth_norm = yNorm;
                    logSpatialEvent(trackStr, "HAZARD_MOVE", cached);
                }
            }
        });
    }
    
    // T10 track memory fade for lost targets: Fades and retains for 3 frames before resolve
    Object.keys(trackLoggedState).forEach(trackId => {
        if (!currentTrackIds.has(trackId)) {
            const hist = trackHistory[trackId];
            if (hist) {
                hist.missingCount = (hist.missingCount || 0) + 1;
                
                if (hist.missingCount < 4) {
                    // Render faded tracking dot
                    const lastPt = hist[hist.length - 1];
                    const alpha = 0.4 / hist.missingCount;
                    radarCtx.fillStyle = `rgba(148, 163, 184, ${alpha})`;
                    radarCtx.beginPath();
                    radarCtx.arc(lastPt.x, lastPt.y, 5, 0, 2 * Math.PI);
                    radarCtx.fill();
                    
                    radarCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
                    radarCtx.font = "bold 8px monospace";
                    const lostLabel = devModeActive ? `[${trackId}] lost` : "lost";
                    radarCtx.fillText(lostLabel, lastPt.x + 8, lastPt.y + 3);
                } else {
                    // Log resolve & delete
                    logSpatialEvent(trackId, "HAZARD_RESOLVED", trackLoggedState[trackId]);
                    delete trackConfirmationFrames[trackId];
                    delete trackLoggedState[trackId];
                    delete trackHistory[trackId];
                }
            } else {
                delete trackLoggedState[trackId];
            }
        }
    });
}

function logSpatialEvent(trackId, eventType, data) {
    let zone = "CENTER";
    if (data.x_norm < -0.3) zone = "LEFT";
    else if (data.x_norm > 0.3) zone = "RIGHT";
    
    const sess = (typeof session_id !== "undefined" && session_id) ? session_id : "default_session";
    
    // Log spatial telemetry in the background via fetch (T20)
    fetch("/api/spatial/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            session_id: sess,
            track_id: trackId.toString(),
            object_type: data.object || "unknown",
            x_norm: parseFloat(data.x_norm.toFixed(3)),
            depth_norm: parseFloat(data.depth_norm.toFixed(3)),
            risk: parseInt(data.risk || 0),
            motion_state: data.motion || "STATIC",
            zone: zone,
            event_type: eventType
        })
    }).then(res => {
        addDiagLog(`Spatial Log: ${eventType} (track ${trackId})`);
    }).catch(err => {
        console.warn("Failed to log spatial event:", err);
    });
}

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
        ctx.fillText(`${det.object.toUpperCase()} (${det.motion}) - RISK: ${det.risk || 0}%`, xmin, ymin - 10);
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
        toggleSafetyBtn.textContent = "STOP SAFETY MODE";
        toggleSafetyBtn.className = "w-full bg-red-600 hover:bg-red-500 font-black p-4 rounded-xl text-lg tracking-wider transition shadow-lg border-b-4 border-red-800 active:border-b-0 active:mt-1 active:mb-[-1px]";
        
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

if (devModeToggleBtn) {
    devModeToggleBtn.addEventListener("click", () => {
        devModeActive = !devModeActive;
        if (devModeActive) {
            devModeToggleBtn.textContent = "DEV MODE: ON";
            devModeToggleBtn.className = "bg-green-900/60 border border-green-700/60 hover:bg-green-900/80 text-[10px] px-2.5 py-1 rounded-lg font-black tracking-wide text-green-300 uppercase transition-all";
            explainabilityCard.classList.remove("hidden");
            const riskContainer = document.getElementById("hazardRiskContainer");
            if (riskContainer) riskContainer.classList.remove("hidden");
            addDiagLog("Developer Mode activated.");
        } else {
            devModeToggleBtn.textContent = "DEV MODE: OFF";
            devModeToggleBtn.className = "bg-slate-900/65 border border-slate-800 hover:bg-slate-800 text-[10px] px-2.5 py-1 rounded-lg font-black tracking-wide text-slate-400 uppercase transition-all";
            explainabilityCard.classList.add("hidden");
            const riskContainer = document.getElementById("hazardRiskContainer");
            if (riskContainer) riskContainer.classList.add("hidden");
            addDiagLog("Developer Mode deactivated.");
        }
    });
}

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

const startupModal = document.getElementById("startupModal");
if (startupModal) {
    startupModal.addEventListener("click", () => {
        startupModal.classList.add("hidden");
        
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (AudioContext) {
                audioCtx = new AudioContext();
            }
        } catch (e) {
            console.warn(e);
        }
        
        try {
            const localData = localStorage.getItem("sahaai_contacts");
            emergencyContacts = localData ? JSON.parse(localData) : [];
            if (emergencyContacts.length === 0) {
                speak("Welcome to SAHAAI. I don't have an emergency contact. Say enter number to provide a number.", 100, true);
                contactSetupState = "WAITING_FOR_SOURCE";
                setTimeout(() => {
                    if (recognition) { try { recognition.start(); } catch(e) {} }
                }, 6500);
            } else {
                if (!isSafetyActive) toggleSafetyMode();
                speak("Welcome to SAHAAI. Safety companion is active. I am listening.", 100, true);
                setTimeout(() => {
                    if (recognition) { try { recognition.start(); } catch(e) {} }
                }, 4000);
            }
        } catch (e) {
            if (!isSafetyActive) toggleSafetyMode();
            speak("Welcome to SAHAAI. Safety companion is active. I am listening.", 100, true);
            setTimeout(() => {
                if (recognition) { try { recognition.start(); } catch(e) {} }
            }, 4000);
        }
    });
}

let lastOrientationWarningTime = 0;
window.addEventListener("deviceorientation", (event) => {
    if (!isSafetyActive) return;
    
    // beta represents the front-to-back tilt in degrees.
    // 90 is vertical, 0 is flat. Less than 45 indicates pointing down at floor.
    const beta = event.beta;
    const orientWarning = document.getElementById("orientationWarning");
    
    if (beta !== null && beta !== undefined) {
        if (beta < 45 && beta > -45) {
            if (orientWarning) orientWarning.classList.remove("hidden");
            
            const now = Date.now();
            if (now - lastOrientationWarningTime > 10000) { // 10s cooldown
                lastOrientationWarningTime = now;
                speak("Point camera ahead. Hold your phone upright.", 70, true);
                addDiagLog("Orientation warning: phone pointed downwards.");
            }
        } else {
            if (orientWarning) orientWarning.classList.add("hidden");
        }
    }
});
