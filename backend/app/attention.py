import time
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# Track announced hazards to enforce cooldown
# Key: object_id (or class name for sound events), Value: timestamp (float)
ANNOUNCEMENT_HISTORY: Dict[Any, float] = {}

# Cooldown thresholds (seconds)
STATIC_COOLDOWN = 10.0  # limit repeating warnings for stationary objects
DYNAMIC_COOLDOWN = 4.0   # limit warnings for moving objects (unless critical)

def prioritize_alerts(
    candidates: List[Dict[str, Any]], 
    scan_mode: bool = False, 
    orientation: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    """
    Applies the SAHAAI Attention Engine rules:
    1. Filter out low-confidence detections (< 0.50).
    2. Apply Uncertainty Layer: prepend 'Possible' for confidence 0.50 - 0.75.
    3. Sort candidates by Hazard Priority Score.
    4. Suppress lower risks if a CRITICAL/ALERT hazard is present.
    5. Enforce alert cooldown to prevent audio spam (unless CRITICAL).
    """
    if not candidates:
        return {
            "object": "clear",
            "confidence": 1.0,
            "direction": "ahead",
            "proximity": "far",
            "motion": "STATIC",
            "risk": 0,
            "state": "SAFE",
            "message": "",
            "reason": ["no hazards detected"]
        }

    valid_candidates = []
    
    for cand in candidates:
        conf = cand.get("confidence", 1.0)
        
        # 1. Filter out low confidence detections
        if conf < 0.50:
            continue
            
        # 2. Uncertainty Layer: Adjust message for medium confidence
        adjusted_cand = dict(cand)
        if 0.50 <= conf <= 0.75:
            msg = adjusted_cand.get("message", "")
            if msg:
                # Prepend 'Possible' to caution messages
                # E.g. "person ahead." -> "Possible person ahead."
                if msg.lower().startswith("warning!"):
                    adjusted_cand["message"] = "Warning! Possible " + msg[9:]
                elif msg.lower().startswith("caution."):
                    adjusted_cand["message"] = "Caution. Possible " + msg[8:]
                else:
                    adjusted_cand["message"] = "Possible " + msg
                
                adjusted_cand["reason"].append("uncertainty fallback (confidence 50-75%)")
                
        valid_candidates.append(adjusted_cand)

    if not valid_candidates:
        return {
            "object": "clear",
            "confidence": 1.0,
            "direction": "ahead",
            "proximity": "far",
            "motion": "STATIC",
            "risk": 0,
            "state": "SAFE",
            "message": "",
            "reason": ["no high-confidence hazards detected"]
        }

    # 3. Sort candidates by risk score descending
    valid_candidates.sort(key=lambda x: x["risk"], reverse=True)
    
    # In Smart Scan mode, we disable normal suppression and cooldown 
    # to let the client capture every sector's highest candidate
    if scan_mode:
        return valid_candidates[0]

    current_time = time.time()
    
    # 4. Process the primary (highest risk) candidate
    primary = valid_candidates[0]
    primary_state = primary["state"]
    primary_risk = primary["risk"]
    primary_id = primary.get("id", primary["object"]) # fallback to class if no tracked ID
    
    # CRITICAL alerts always bypass cooldown and trigger immediate interrupt
    if primary_state == "CRITICAL":
        ANNOUNCEMENT_HISTORY[primary_id] = current_time
        return primary

    # Enforce Cooldown for ALERT and CAUTION alerts
    last_announced = ANNOUNCEMENT_HISTORY.get(primary_id, 0.0)
    elapsed = current_time - last_announced
    
    is_approaching = primary.get("motion") == "APPROACHING"
    cooldown_threshold = DYNAMIC_COOLDOWN if is_approaching else STATIC_COOLDOWN
    
    # If the alert is still cooling down, check if we should suppress speech output
    if elapsed < cooldown_threshold:
        # Suppress message to avoid audio spam
        silent_copy = dict(primary)
        silent_copy["message"] = "" # Empty message tells client not to speak
        silent_copy["reason"].append(f"audio alert suppressed due to cooldown ({round(cooldown_threshold - elapsed, 1)}s remaining)")
        return silent_copy
        
    # Out of cooldown: schedule announcement and record timestamp
    ANNOUNCEMENT_HISTORY[primary_id] = current_time
    return primary
