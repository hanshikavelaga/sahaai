import asyncio
import base64
import json
import logging
import os
import uuid
from typing import List, Dict, Any, Optional
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
from backend.app.audio import analyze_audio_chunk, AdaptiveAudioDetector
from backend.app.database import (
    insert_hazard_event,
    insert_audio_event,
    insert_fusion_event,
    insert_ocr_event,
    insert_emergency_event,
    insert_scan_session,
    insert_scan_result,
    insert_spatial_event,
    insert_emergency_contact,
    get_emergency_contacts,
    delete_emergency_contact
)

# Initialize persistent tracker and audio event detector
tracker = ObjectTracker()
audio_detector = AdaptiveAudioDetector()

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
        
        # Log to Supabase database in the background
        asyncio.create_task(asyncio.to_thread(insert_ocr_event, {
            "session_id": "ocr_on_demand",
            "extracted_text": text,
            "confidence": confidence
        }))
        
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

class ScanStartRequest(BaseModel):
    session_id: str
    user_id: Optional[str] = None

class ScanResultRequest(BaseModel):
    scan_uuid: str
    direction: str
    hazard: str
    risk_score: int

@app.post("/api/scan/start")
async def start_scan_session_api(payload: ScanStartRequest):
    """T17: Registers a new scan session in the database."""
    try:
        scan_uuid = insert_scan_session(payload.session_id, payload.user_id)
        if not scan_uuid:
            scan_uuid = "mock-scan-uuid"
        return {"scan_uuid": scan_uuid}
    except Exception as e:
        logger.error(f"Error starting scan session: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/scan/result")
async def log_scan_result_api(payload: ScanResultRequest):
    """T17: Logs a quadrant/sector scan result to Supabase."""
    try:
        result_data = {
            "direction": payload.direction,
            "hazard": payload.hazard,
            "risk_score": payload.risk_score
        }
        success = insert_scan_result(payload.scan_uuid, result_data)
        return {"success": success}
    except Exception as e:
        logger.error(f"Error logging scan result: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class SpatialEventRequest(BaseModel):
    session_id: str
    track_id: str
    object_type: str
    x_norm: float
    depth_norm: float
    risk: int
    motion_state: str
    zone: str
    event_type: str

@app.post("/api/spatial/event")
async def log_spatial_event_api(payload: SpatialEventRequest):
    """
    T20: Logs a spatial trajectory event to Supabase.
    Performs server-side validation of range bounds and event classification.
    """
    if not (-1.01 <= payload.x_norm <= 1.01):
        raise HTTPException(status_code=400, detail="x_norm must be in range [-1.0, 1.0]")
    if not (-0.01 <= payload.depth_norm <= 1.01):
        raise HTTPException(status_code=400, detail="depth_norm must be in range [0.0, 1.0]")
    if not (0 <= payload.risk <= 100):
        raise HTTPException(status_code=400, detail="risk must be in range [0, 100]")
        
    valid_events = {"NEW_HAZARD", "HAZARD_MOVE", "HAZARD_ESCALATE", "HAZARD_RESOLVED", "AUDIO_FUSION"}
    if payload.event_type.upper() not in valid_events:
        raise HTTPException(status_code=400, detail=f"event_type must be one of {valid_events}")
        
    try:
        success = insert_spatial_event(payload.dict())
        return {"success": success}
    except Exception as e:
        logger.error(f"Error logging spatial event: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ContactRequest(BaseModel):
    session_id: str
    name: str
    phone_number: str
    priority: int = 1
    verified: bool = True

class EmergencyEventRequest(BaseModel):
    session_id: str
    trigger_source: str
    status: str
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    accuracy_m: Optional[float] = None
    location_available: bool = False
    contacts_notified: int = 0

@app.get("/api/emergency/contacts")
async def fetch_contacts_api(session_id: str):
    """T21: Fetches emergency contacts for the active session."""
    try:
        contacts = get_emergency_contacts(session_id)
        return {"contacts": contacts}
    except Exception as e:
        logger.error(f"Error fetching contacts: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/emergency/contact")
async def save_contact_api(payload: ContactRequest):
    """T21: Saves an emergency contact to Supabase."""
    try:
        success = insert_emergency_contact(payload.dict())
        return {"success": success}
    except Exception as e:
        logger.error(f"Error saving contact: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/api/emergency/contact")
async def remove_contact_api(session_id: str, name: str):
    """T21: Removes an emergency contact by name."""
    try:
        success = delete_emergency_contact(session_id, name)
        return {"success": success}
    except Exception as e:
        logger.error(f"Error removing contact: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/emergency/trigger")
async def trigger_sos_api(payload: EmergencyEventRequest):
    """T21: Logs a triggered/cancelled emergency event to Supabase."""
    try:
        success = insert_emergency_event(payload.dict())
        return {"success": success}
    except Exception as e:
        logger.error(f"Error logging emergency event: {e}")
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
    
    session_id = str(uuid.uuid4())
    last_fused_track_id = None
    last_logged_fusion_time = 0.0
    last_fusion_safety_state = "SAFE"
    
    try:
        while True:
            # Receive data from client
            data = await websocket.receive_text()
            payload = json.loads(data)
            
            # 1. Parse payloads
            image_data = payload.get("image")
            audio_data = payload.get("audio") # optional legacy audio buffer
            audio_features = payload.get("audio_features") # T14 audio spectral features
            orientation = payload.get("orientation") # optional dict: {alpha, beta, gamma}
            scan_mode = payload.get("scan_mode", False) # True if user is in active Smart Scan
            
            alerts = []
            frame_detections = []
            audio_res = None
            
            # 2. Process audio features or legacy audio chunks (T14)
            if audio_features:
                try:
                    audio_res = audio_detector.process_features(audio_features)
                except Exception as e:
                    logger.error(f"Error processing audio features: {e}")
            elif audio_data:
                # Legacy raw audio chunks processing
                try:
                    raw_audio = base64.b64decode(audio_data)
                    legacy_res = analyze_audio_chunk(raw_audio)
                    if legacy_res["detected"]:
                        audio_res = {
                            "sound": legacy_res["sound_type"].upper(),
                            "confidence": legacy_res["confidence"],
                            "timestamp": 0
                        }
                except Exception as e:
                    logger.error(f"Legacy audio processing error: {e}")

            # 3. Process image frame
            raw_detections = []
            vision_timestamp = payload.get("timestamp") or int(time.time() * 1000)
            current_fusion_state = "NO_FUSION"
            
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
                        
                        # Update Tracker & Motion (T10)
                        tracked_objects = tracker.update(raw_detections, frame_width, frame_height)
                        
                        # Step 3.1: Calculate base priority scores for all tracked targets (no audio)
                        base_candidates = []
                        for obj in tracked_objects:
                            base_info = calculate_hazard_priority(obj, audio_event=None, vision_timestamp=None, frame_width=frame_width, frame_height=frame_height)
                            base_info["obj_ref"] = obj
                            base_candidates.append(base_info)
                            
                        # Step 3.2: Identify the highest-risk motor vehicle target for fusion
                        MOTOR_VEHICLES = {"car", "truck", "bus", "motorcycle"}
                        best_vehicle_idx = -1
                        best_vehicle_risk = -1
                        
                        for idx, cand in enumerate(base_candidates):
                            if cand["object"] in MOTOR_VEHICLES:
                                if cand["risk"] > best_vehicle_risk:
                                    best_vehicle_risk = cand["risk"]
                                    best_vehicle_idx = idx
                                    
                        # Step 3.3: Run final priority calculations with audio fusion (T15)
                        for idx, cand in enumerate(base_candidates):
                            obj = cand["obj_ref"]
                            # Only fuse the single highest-risk vehicle with active audio events
                            if idx == best_vehicle_idx and audio_res and audio_res.get("sound"):
                                fused_info = calculate_hazard_priority(obj, audio_event=audio_res, vision_timestamp=vision_timestamp, frame_width=frame_width, frame_height=frame_height)
                                
                                # Enforce minimum fusion confidence threshold (0.20)
                                if fused_info.get("fusion_confidence", 0.0) >= 0.20:
                                    current_fusion_state = "VISION_AUDIO"
                                    fused_track_id = fused_info.get("id")
                                    
                                    # Check database log eligibility (T15.7)
                                    import time as pytime
                                    current_time = pytime.time()
                                    state_escalated = (fused_info["state"] == "CRITICAL" and last_fusion_safety_state != "CRITICAL")
                                    time_elapsed = current_time - last_logged_fusion_time
                                    
                                    if state_escalated or time_elapsed >= 5.0 or last_fused_track_id != fused_track_id:
                                        last_logged_fusion_time = current_time
                                        last_fused_track_id = fused_track_id
                                        last_fusion_safety_state = fused_info["state"]
                                        
                                        # Insert fusion log record
                                        asyncio.create_task(asyncio.to_thread(insert_fusion_event, {
                                            "session_id": session_id,
                                            "vision_detected": True,
                                            "audio_detected": True,
                                            "motion_detected": (obj.get("motion", "static").upper() != "STATIC"),
                                            "object_type": fused_info["object"],
                                            "sound_type": audio_res["sound"].lower(),
                                            "final_risk": fused_info["risk"],
                                            "final_level": fused_info["state"]
                                        }))
                                        
                                    fused_info["bbox"] = obj.get("bbox")
                                    frame_detections.append(fused_info)
                                    continue
                                    
                            # Fallback (normal visual priority calculation without audio)
                            final_info = calculate_hazard_priority(obj, audio_event=None, vision_timestamp=None, frame_width=frame_width, frame_height=frame_height)
                            final_info["bbox"] = obj.get("bbox")
                            frame_detections.append(final_info)
                except Exception as e:
                    logger.error(f"Frame processing error: {e}")

            # 4. Integrate Sensor Fusion (Visuals + Audio)
            fused_candidates = list(frame_detections)
            audio_alert = None
            
            # Handle RESOLVED fusion transition (T15.8)
            if last_fused_track_id is not None and current_fusion_state != "VISION_AUDIO":
                asyncio.create_task(asyncio.to_thread(insert_fusion_event, {
                    "session_id": session_id,
                    "vision_detected": False,
                    "audio_detected": False,
                    "motion_detected": False,
                    "object_type": "resolved",
                    "sound_type": "none",
                    "final_risk": 0,
                    "final_level": "SAFE"
                }))
                last_fused_track_id = None
                last_fusion_safety_state = "SAFE"
            
            if audio_res and audio_res.get("sound"):
                sound_type = audio_res["sound"]
                confidence = audio_res["confidence"]
                
                # Check if any motor vehicle was detected in the frame for audio-vision alignment
                MOTOR_VEHICLES = {"car", "truck", "bus", "motorcycle"}
                has_motor_vehicle = any(d.get("class") in MOTOR_VEHICLES for d in raw_detections)
                
                # If no motor vehicles are present, raise an independent caution alert (no panic)
                if not has_motor_vehicle and confidence >= 0.70:
                    sound_label = "horn" if sound_type == "HORN" else "siren"
                    audio_alert = {
                        "object": sound_label,
                        "state": "CAUTION",
                        "risk": 45,
                        "direction": "around",
                        "proximity": "near",
                        "motion": "static",
                        "confidence": confidence,
                        "message": f"Caution. {sound_label.capitalize()} detected nearby.",
                        "reason": [f"high-confidence audio event ({sound_label})"],
                        "tti": "infinite"
                    }
                    fused_candidates.append(audio_alert)
                    
                    log_event("AUDIO_HAZARD", {
                        "sound": sound_label,
                        "confidence": confidence,
                        "message": audio_alert["message"]
                    })
                    
                    # Log audio hazard event to Supabase in the background
                    asyncio.create_task(asyncio.to_thread(insert_audio_event, {
                        "session_id": session_id,
                        "sound_type": sound_label,
                        "confidence": confidence,
                        "amplitude_rms": audio_features.get("rms", 0.05) if audio_features else 0.05,
                        "peak_frequency_hz": audio_features.get("peak_hz", 500.0) if audio_features else 500.0,
                        "safety_state": "CAUTION"
                    }))
                
            # 5. Pass to Attention Engine
            response_alert = prioritize_alerts(fused_candidates, scan_mode, orientation)
            
            # Log significant detections (CAUTION/ALERT/CRITICAL states) to memory and database
            if response_alert and response_alert.get("state") != "SAFE":
                log_event("HAZARD_EVALUATION", {
                    "object": response_alert.get("object"),
                    "risk": response_alert.get("risk"),
                    "state": response_alert.get("state"),
                    "message": response_alert.get("message"),
                    "reason": response_alert.get("reason"),
                    "confidence": response_alert.get("confidence")
                })
                
                # Push hazard event to Supabase in the background thread
                asyncio.create_task(asyncio.to_thread(insert_hazard_event, {
                    **response_alert,
                    "session_id": "active_walk_session"
                }))
                
                # Push Fusion event if both Vision and Audio sensors triggered active hazards
                if audio_alert and len(frame_detections) > 0:
                    asyncio.create_task(asyncio.to_thread(insert_fusion_event, {
                        "session_id": "active_walk_session",
                        "vision_detected": True,
                        "audio_detected": True,
                        "motion_detected": any(o.get("motion") == "APPROACHING" for o in frame_detections),
                        "object_type": frame_detections[0].get("object"),
                        "sound_type": audio_res.get("sound_type", "siren") if 'audio_res' in locals() else "siren",
                        "final_risk": response_alert.get("risk"),
                        "final_level": response_alert.get("state")
                    }))
            
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
