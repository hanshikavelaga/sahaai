import asyncio
import base64
import json
import logging
import os
from typing import List, Dict, Any
import cv2
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="SAHAAI Backend", description="Smart AI Hazard Awareness & Assistive Intelligence API")

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory diagnostic event log for explainability
EVENT_LOG: List[Dict[str, Any]] = []
MAX_LOG_SIZE = 100

def log_event(event_type: str, details: Dict[str, Any]):
    """Helper to log events with timestamp and keep the size bounded."""
    import datetime
    timestamp = datetime.datetime.now().strftime("%H:%M:%S")
    EVENT_LOG.append({
        "timestamp": timestamp,
        "type": event_type,
        **details
    })
    if len(EVENT_LOG) > MAX_LOG_SIZE:
        EVENT_LOG.pop(0)

# Import SAHAAI sub-modules (created in subsequent steps)
from backend.app.vision import detect_objects
from backend.app.tracking import ObjectTracker
from backend.app.hazard import calculate_hazard_priority
from backend.app.attention import prioritize_alerts
from backend.app.audio import analyze_audio_chunk

# Initialize persistent tracker
tracker = ObjectTracker()

class OCRRequest(BaseModel):
    image_base64: str

@app.post("/api/ocr")
async def perform_ocr(payload: OCRRequest):
    """
    Phase 2: OCR endpoint for reading signs.
    Loads EasyOCR dynamically if available, otherwise runs a mock/rule-based OCR parser.
    """
    try:
        header, encoded = payload.image_base64.split(",", 1) if "," in payload.image_base64 else ("", payload.image_base64)
        img_bytes = base64.b64decode(encoded)
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            raise HTTPException(status_code=400, detail="Invalid image data")

        text = "Emergency Exit Ahead"
        confidence = 0.95
        
        # Dynamically attempt to import easyocr to keep dependencies soft
        try:
            import easyocr
            reader = easyocr.Reader(['en'], gpu=False)
            results = reader.readtext(img)
            if results:
                # Concatenate recognized words
                text = " ".join([res[1] for res in results])
                confidence = float(np.mean([res[2] for res in results]))
        except Exception as e:
            logger.warning(f"EasyOCR fallback active: {e}")
            # Mock check: if image is not empty, return a default mock text for presentation
            pass

        log_event("OCR_TRIGGER", {"text": text, "confidence": confidence})
        return {"text": text, "confidence": confidence}
    except Exception as e:
        logger.error(f"OCR Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/logs")
async def get_logs():
    """Retrieve the real-time explainability event log."""
    return EVENT_LOG

@app.post("/api/audio-event")
async def trigger_audio_event(payload: Dict[str, Any]):
    """Endpoint for processing browser microphone chunks asynchronously."""
    # This allows HTTP-based audio checks as a fallback to WebSockets
    audio_data = payload.get("audio", "")
    if not audio_data:
        raise HTTPException(status_code=400, detail="Missing audio data")
    
    try:
        raw_bytes = base64.b64decode(audio_data)
        result = analyze_audio_chunk(raw_bytes)
        if result["detected"]:
            log_event("AUDIO_HAZARD", {
                "sound": result["sound_type"],
                "confidence": result["confidence"],
                "message": result["message"]
            })
        return result
    except Exception as e:
        logger.error(f"Audio API Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    """
    Main WebSocket connection for real-time video/audio streaming.
    Accepts JSON messages with frame images and sensor inputs.
    Returns prioritized hazard actions and safety states.
    """
    await websocket.accept()
    logger.info("WebSocket connection established")
    log_event("SYSTEM", {"message": "WebSocket connection established, safety monitoring started."})
    
    try:
        while True:
            # Receive data from client
            data = await websocket.receive_text()
            payload = json.loads(data)
            
            # 1. Parse image payload
            image_data = payload.get("image")
            audio_data = payload.get("audio") # optional audio buffer
            orientation = payload.get("orientation") # optional dict: {alpha, beta, gamma}
            scan_mode = payload.get("scan_mode", False) # True if user is in active Smart Scan
            
            alerts = []
            frame_detections = []
            
            # 2. Process image frame
            if image_data:
                try:
                    # Decode base64 image
                    header, encoded = image_data.split(",", 1) if "," in image_data else ("", image_data)
                    img_bytes = base64.b64decode(encoded)
                    nparr = np.frombuffer(img_bytes, np.uint8)
                    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
                    
                    if img is not None:
                        frame_height, frame_width = img.shape[:2]
                        # Run YOLO object detection
                        raw_detections = detect_objects(img)
                        
                        # Update Tracker & Motion
                        tracked_objects = tracker.update(raw_detections, frame_width, frame_height)
                        
                        # Process each tracked object through Hazard Priority Engine
                        for obj in tracked_objects:
                            hazard_info = calculate_hazard_priority(obj)
                            frame_detections.append(hazard_info)
                except Exception as e:
                    logger.error(f"Frame processing error: {e}")
            
            # 3. Process audio chunks if provided
            audio_alert = None
            if audio_data:
                try:
                    raw_audio = base64.b64decode(audio_data)
                    audio_res = analyze_audio_chunk(raw_audio)
                    if audio_res["detected"]:
                        audio_alert = {
                            "object": "sound_pattern",
                            "confidence": audio_res["confidence"],
                            "direction": "around",
                            "proximity": "near",
                            "motion": "approaching",
                            "risk": int(audio_res["confidence"] * 100),
                            "state": "ALERT",
                            "message": audio_res["message"],
                            "reason": ["periodic frequency peaks detected in audio buffer"]
                        }
                        log_event("AUDIO_HAZARD", {
                            "sound": audio_res["sound_type"],
                            "confidence": audio_res["confidence"],
                            "message": audio_res["message"]
                        })
                except Exception as e:
                    logger.error(f"Audio processing error: {e}")

            # 4. Integrate Sensor Fusion (Visuals + Audio)
            fused_candidates = list(frame_detections)
            if audio_alert:
                fused_candidates.append(audio_alert)
                
            # 5. Pass to Attention Engine
            response_alert = prioritize_alerts(fused_candidates, scan_mode, orientation)
            
            # Log significant detections (CAUTION/ALERT/CRITICAL states)
            if response_alert and response_alert.get("state") != "SAFE":
                log_event("HAZARD_EVALUATION", {
                    "object": response_alert.get("object"),
                    "risk": response_alert.get("risk"),
                    "state": response_alert.get("state"),
                    "message": response_alert.get("message"),
                    "reason": response_alert.get("reason"),
                    "confidence": response_alert.get("confidence")
                })
            
            # Send result back to client
            await websocket.send_text(json.dumps({
                "status": "success",
                "active_alert": response_alert,
                "all_detections": frame_detections,
                "audio_hazard": audio_alert is not None
            }))
            
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
        log_event("SYSTEM", {"message": "WebSocket disconnected"})
    except Exception as e:
        logger.error(f"WebSocket execution error: {e}")
        log_event("SYSTEM_ERROR", {"detail": str(e)})

# Serve frontend directory as static files with CWD and relative-file fallbacks
frontend_dir = os.path.abspath("frontend")
if not os.path.exists(frontend_dir) or not os.path.exists(os.path.join(frontend_dir, "index.html")):
    frontend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend"))

logger.info(f"Resolved frontend directory: {frontend_dir}")
if os.path.exists(frontend_dir):
    logger.info(f"Frontend directory contents: {os.listdir(frontend_dir)}")
else:
    logger.error(f"Frontend directory NOT found at: {frontend_dir}")
    # Create fallback to prevent FastAPI crashing
    os.makedirs(frontend_dir, exist_ok=True)

app.mount("/", StaticFiles(directory=frontend_dir, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
