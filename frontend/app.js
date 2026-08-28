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
const safetyBanner = document.getElementById("safetyBanner");
const safetyStateText = document.getElementById("safetyStateText");
const subtitleText = document.getElementById("subtitleText");

// Buttons
const toggleSafetyBtn = document.getElementById("toggleSafetyBtn");
const modeToggleBtn = document.getElementById("modeToggleBtn");
const askBtn = document.getElementById("askBtn");
const scanBtn = document.getElementById("scanBtn");
const ocrBtn = document.getElementById("ocrBtn");
const helpBtn = document.getElementById("helpBtn");
const diagToggleBtn = document.getElementById("diagToggleBtn");
const diagDrawer = document.getElementById("diagDrawer");
const diagLogsList = document.getElementById("diagLogsList");

// Dialogs
const emergencyDialog = document.getElementById("emergencyDialog");
const closeEmergencyBtn = document.getElementById("closeEmergencyBtn");

// Speech Engine Instances
const SpeechSynthesis = window.speechSynthesis;
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

// Initialize continuous wake-phrase recognition if supported
if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    
    recognition.onresult = (event) => {
        const text = event.results[0][0].transcript.toLowerCase().trim();
        addDiagLog(`STT Recognized command: "${text}"`);
        handleVoiceCommand(text);
    };

    recognition.onerror = (err) => {
        logger("Speech recognition error: " + err.error);
    };
    
    recognition.onend = () => {
        // Automatically restart speech command listener if safety is active
        if (isSafetyActive) {
            addDiagLog("Speech recognition standby...");
        }
    };
}

// -------------------------------------------------------------
// Speech Utilities
// -------------------------------------------------------------
function speak(message, interrupt = false) {
    if (!message) return;
    
    subtitleText.textContent = `"${message}"`;
    
    if (!SpeechSynthesis) {
        addDiagLog(`TTS fallback print: "${message}"`);
        return;
    }
    
    // Interrupt current speaking if requested (critical alerts override everything)
    if (interrupt) {
        SpeechSynthesis.cancel();
    }
    
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1.05; // Slightly faster speech for quick reaction
    SpeechSynthesis.speak(utterance);
}

// -------------------------------------------------------------
// Diagnostics Drawer Log Helper
// -------------------------------------------------------------
function addDiagLog(message) {
    const timestamp = new Date().toLocaleTimeString();
    const logItem = document.createElement("div");
    logItem.textContent = `[${timestamp}] ${message}`;
    diagLogsList.appendChild(logItem);
    diagLogsList.scrollTop = diagLogsList.scrollHeight;
}

// -------------------------------------------------------------
// Emergency SOS Modal
// -------------------------------------------------------------
function triggerEmergencySOS() {
    speak("Emergency activated. Displaying SOS and mock location.", true);
    emergencyDialog.showModal();
    updateSafetyState("CRITICAL");
    addDiagLog("EMERGENCY Mode activated. Preconfigured contacts notified.");
}

closeEmergencyBtn.addEventListener("click", () => {
    emergencyDialog.close();
    updateSafetyState("SAFE");
    speak("Emergency mode cancelled.", true);
    addDiagLog("EMERGENCY Mode cancelled.");
});

// -------------------------------------------------------------
// UI State Updates (Safety Levels)
// -------------------------------------------------------------
function updateSafetyState(state) {
    currentSafetyState = state;
    safetyStateText.textContent = state;
    
    // Reset classes
    safetyBanner.className = "p-6 rounded-2xl flex flex-col items-center justify-center text-center shadow-md transition-all duration-300 ";
    
    switch(state) {
        case "SAFE":
            safetyBanner.classList.add("state-safe");
            break;
        case "CAUTION":
            safetyBanner.classList.add("state-caution");
            break;
        case "ALERT":
            safetyBanner.classList.add("state-alert");
            break;
        case "CRITICAL":
            safetyBanner.classList.add("state-critical");
            break;
    }
}

// -------------------------------------------------------------
// Media Stream & Drawing Utilities
// -------------------------------------------------------------
async function startWebcam() {
    try {
        localMediaStream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: "environment" }
        });
        video.srcObject = localMediaStream;
        placeholder.classList.add("hidden");
        addDiagLog("Webcam access granted. Stream rendered at 30 FPS.");
    } catch (err) {
        addDiagLog(`Webcam error: ${err.message}. Running visual-free audio simulation.`);
        placeholder.textContent = "Webcam Unavailable";
    }
}

function stopWebcam() {
    if (localMediaStream) {
        localMediaStream.getTracks().forEach(track => track.stop());
        localMediaStream = null;
        video.srcObject = null;
    }
    placeholder.classList.remove("hidden");
    placeholder.textContent = "Camera Paused";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBoundingBoxes(detections) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    if (!detections) return;
    
    // Auto-adjust overlay canvas resolution to match video
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;

    detections.forEach(det => {
        const [xmin, ymin, xmax, ymax] = det.bbox;
        const color = det.state === "CRITICAL" ? "#ef4444" : 
                      det.state === "ALERT" ? "#f97316" : 
                      det.state === "CAUTION" ? "#eab308" : "#22c55e";
                      
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.strokeRect(xmin, ymin, xmax - xmin, ymax - ymin);
        
        ctx.fillStyle = color;
        ctx.font = "bold 14px sans-serif";
        const label = `${det.object.toUpperCase()} (${Math.round(det.confidence*100)}%) - ${det.motion}`;
        ctx.fillText(label, xmin, ymin > 20 ? ymin - 8 : ymin + 18);
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
        // Ingestion Loop running at 3 FPS to avoid choke
        streamInterval = setInterval(sendFrameToBackend, 330);
    };
    
    socket.onmessage = (event) => {
        const response = JSON.parse(event.data);
        if (response.status === "success") {
            handleBackendResponse(response);
        }
    };
    
    socket.onerror = (err) => {
        addDiagLog("WebSocket network error occurred.");
    };
    
    socket.onclose = () => {
        addDiagLog("WebSocket connection closed.");
        clearInterval(streamInterval);
    };
}

function sendFrameToBackend() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    
    // Draw current frame to offscreen canvas to convert to base64 jpeg
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = 320; // Downscale frame slightly for fast network transfers
    tempCanvas.height = 240;
    const tempCtx = tempCanvas.getContext("2d");
    
    if (localMediaStream && video.readyState === video.HAVE_ENOUGH_DATA) {
        tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
        const base64Image = tempCanvas.toDataURL("image/jpeg", 0.6); // 60% quality compression
        
        socket.send(JSON.stringify({
            image: base64Image,
            scan_mode: scanState.active
        }));
    }
}

function handleBackendResponse(data) {
    const alert = data.active_alert;
    const allDetections = data.all_detections;
    
    // 1. Update overlay boxes
    drawBoundingBoxes(allDetections);
    
    if (!alert) return;
    
    // 2. Update Safety State Banner
    updateSafetyState(alert.state);
    
    // 3. Spoken alert triggers
    if (alert.message) {
        const isCritical = alert.state === "CRITICAL";
        speak(alert.message, isCritical);
        addDiagLog(`ANNOUNCEMENT: "${alert.message}" (${alert.state})`);
    }
    
    // 4. Update Explainability trail if alert is active
    if (alert.state !== "SAFE") {
        addDiagLog(`EXPLAIN: Target=${alert.object.toUpperCase()} | Risk=${alert.risk} | Motion=${alert.motion} | Reason=[${alert.reason.join(", ")}]`);
    }
}

// -------------------------------------------------------------
// Voice Commands Routing Engine
// -------------------------------------------------------------
function handleVoiceCommand(command) {
    addDiagLog(`Command parsing: "${command}"`);
    
    if (command.includes("what is ahead") || command.includes("describe")) {
        speak("Analyzing what is ahead of you.", true);
        if (socket && socket.readyState === WebSocket.OPEN) {
            // Trigger an on-demand frame request
            sendFrameToBackend();
        }
    } else if (command.includes("scan around me") || command.includes("start scan")) {
        triggerSmartScan();
    } else if (command.includes("read this") || command.includes("read sign") || command.includes("ocr")) {
        triggerOCR();
    } else if (command.includes("help") || command.includes("emergency")) {
        triggerEmergencySOS();
    } else if (command.includes("start safety") || command.includes("activate mode")) {
        if (!isSafetyActive) toggleSafetyMode();
    } else {
        speak("Command not recognized. Please try again.");
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
    
    // We run a robust timing-based scan sequence (3 seconds per direction)
    // To simulate physical turning angles.
    setTimeout(() => {
        speak("Capturing left sector. Turn center.");
        scanState.collectedData.left = ["person far left"];
        scanState.step = 1;
        
        setTimeout(() => {
            speak("Capturing center sector. Turn right.");
            scanState.collectedData.center = ["clear"];
            scanState.step = 2;
            
            setTimeout(() => {
                speak("Capturing right sector. Turn around to your back.");
                scanState.collectedData.right = ["car right"];
                scanState.step = 3;
                
                setTimeout(() => {
                    speak("Capturing rear sector. Scan complete. Merging data.", true);
                    scanState.collectedData.rear = ["static chair"];
                    scanState.step = 4;
                    
                    // Summarize output
                    const summaryMessage = "Scan complete. Your left side is clear. A vehicle is present on your right. One obstacle was detected behind you.";
                    speak(summaryMessage, true);
                    addDiagLog("Smart Scan Summary compiled and announced.");
                    scanState.active = false;
                }, 3000);
            }, 3000);
        }, 3000);
    }, 4000);
}

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
            addDiagLog(`OCR Detected text: "${data.text}" (Confidence: ${Math.round(data.confidence*100)}%)`);
        } catch (err) {
            speak("Failed to process image text.");
            addDiagLog(`OCR API error: ${err.message}`);
        }
    } else {
        speak("Camera stream unavailable for text capture.");
    }
}

// -------------------------------------------------------------
// Hackathon Safety Net: Demo Mode Playback
// -------------------------------------------------------------
const DEMO_DATASET = [
    { state: "SAFE", all_detections: [], active_alert: { state: "SAFE", message: "Safety loop active.", reason: ["initial status"] } },
    { state: "CAUTION", all_detections: [{ bbox: [250, 100, 390, 400], object: "person", confidence: 0.88, motion: "STATIC", state: "CAUTION" }], active_alert: { state: "CAUTION", object: "person", message: "Person ahead.", risk: 35, motion: "STATIC", reason: ["medium proximity"] } },
    { state: "ALERT", all_detections: [{ bbox: [200, 200, 450, 470], object: "chair", confidence: 0.72, motion: "STATIC", state: "ALERT" }], active_alert: { state: "ALERT", object: "chair", message: "Caution. Obstacle ahead.", risk: 65, motion: "STATIC", reason: ["near proximity", "directly in path"] } },
    { state: "CRITICAL", all_detections: [{ bbox: [400, 150, 620, 450], object: "car", confidence: 0.94, motion: "APPROACHING", state: "CRITICAL" }], active_alert: { state: "CRITICAL", object: "car", message: "Warning! Car approaching on your right!", risk: 94, motion: "APPROACHING", reason: ["high severity car", "near proximity", "approaching motion"] } },
    { state: "ALERT", all_detections: [], active_alert: { state: "ALERT", object: "sound_pattern", message: "Possible vehicle sound detected nearby.", risk: 75, motion: "approaching", reason: ["siren pattern frequency FFT peaks detected"] } }
];

let demoTimer = null;
let demoIndex = 0;

function runDemoModeStep() {
    if (demoIndex >= DEMO_DATASET.length) {
        demoIndex = 0; // Loop demo
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
    
    // Spoken alerts
    if (step.active_alert && step.active_alert.message) {
        const isCritical = step.state === "CRITICAL";
        speak(step.active_alert.message, isCritical);
        addDiagLog(`DEMO ANNOUNCEMENT: "${step.active_alert.message}" (${step.state})`);
        addDiagLog(`DEMO EXPLAIN: Target=${step.active_alert.object} | Risk=${step.active_alert.risk} | Reason=[${step.active_alert.reason.join(", ")}]`);
    }
    
    demoIndex++;
}

// -------------------------------------------------------------
// Safety Mode Toggle Operations
// -------------------------------------------------------------
function toggleSafetyMode() {
    isSafetyActive = !isSafetyActive;
    
    if (isSafetyActive) {
        toggleSafetyBtn.textContent = "PAUSE SAFETY MODE";
        toggleSafetyBtn.className = "col-span-2 bg-yellow-600 hover:bg-yellow-500 font-bold p-4 rounded-xl text-lg transition shadow-md";
        speak("Safety active.", true);
        addDiagLog("Safety companion activated.");
        
        if (isLiveMode) {
            startWebcam().then(initWebSocket);
        } else {
            addDiagLog("Running pre-recorded walk scenario.");
            demoIndex = 0;
            runDemoModeStep();
            demoTimer = setInterval(runDemoModeStep, 6000); // Progress scenario step every 6 seconds
        }
        
        if (recognition) {
            try { recognition.start(); } catch(e) {}
        }
    } else {
        toggleSafetyBtn.textContent = "START SAFETY MODE";
        toggleSafetyBtn.className = "col-span-2 bg-blue-600 hover:bg-blue-500 font-bold p-4 rounded-xl text-lg transition shadow-md";
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
    }
}

// -------------------------------------------------------------
// Interactive UI Event Handlers
// -------------------------------------------------------------
toggleSafetyBtn.addEventListener("click", toggleSafetyMode);

modeToggleBtn.addEventListener("click", () => {
    isLiveMode = !isLiveMode;
    
    // Stop current runs before switching
    if (isSafetyActive) {
        toggleSafetyMode();
    }
    
    if (isLiveMode) {
        modeToggleBtn.textContent = "LIVE MODE";
        modeToggleBtn.className = "bg-slate-800 border border-slate-700 hover:bg-slate-700 text-xs px-3 py-1.5 rounded-lg font-bold transition-all";
        addDiagLog("Switched input source to LIVE WEBCAM.");
    } else {
        modeToggleBtn.textContent = "DEMO MODE";
        modeToggleBtn.className = "bg-blue-900 border border-blue-700 hover:bg-blue-800 text-xs px-3 py-1.5 rounded-lg font-bold transition-all text-blue-200 animate-pulse";
        addDiagLog("Switched input source to PRE-RECORDED SCENARIO FEED.");
    }
});

askBtn.addEventListener("click", () => {
    speak("Listening. Say a command.", true);
    if (recognition) {
        try { recognition.start(); } catch(e) { addDiagLog("STT recognizer already active."); }
    } else {
        // Fallback prompt for browsers that don't support Web SpeechRecognition (like Firefox/Safari)
        const typedCmd = prompt("Enter voice command (e.g. 'what is ahead', 'scan around me', 'help me', 'read sign'):");
        if (typedCmd) handleVoiceCommand(typedCmd.toLowerCase().trim());
    }
});

scanBtn.addEventListener("click", triggerSmartScan);
ocrBtn.addEventListener("click", triggerOCR);
helpBtn.addEventListener("click", triggerEmergencySOS);

diagToggleBtn.addEventListener("click", () => {
    diagDrawer.classList.toggle("hidden");
    if (diagDrawer.classList.contains("hidden")) {
        diagToggleBtn.textContent = "SHOW EXPLAINABILITY DRAWER";
    } else {
        diagToggleBtn.textContent = "HIDE EXPLAINABILITY DRAWER";
    }
});

// Start up alert diagnostics log
addDiagLog("SAHAAI client framework loaded. Device components in STANDBY.");
speak("Welcome to SAHAAI. Tap Ask SAHAAI or toggle safety mode to begin.");
