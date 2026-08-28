import time
import logging
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

# Track announced hazards to enforce cooldowns and risk escalation overrides
# Key: object_id (or class name for sound events), Value: {"timestamp": float, "risk": int}
ANNOUNCEMENT_HISTORY: Dict[Any, Dict[str, Any]] = {}

# Cooldown thresholds (seconds)
CRITICAL_COOLDOWN = 0.0
APPROACHING_COOLDOWN = 3.0
STATIC_HAZARD_COOLDOWN = 15.0 # Mute stationary tables/chairs for longer
DEFAULT_STATIC_COOLDOWN = 8.0

def calculate_iou(bbox1: List[int], bbox2: List[int]) -> float:
    """Calculates Intersection over Union (IoU) of two bounding boxes."""
    xi1 = max(bbox1[0], bbox2[0])
    yi1 = max(bbox1[1], bbox2[1])
    xi2 = min(bbox1[2], bbox2[2])
    yi2 = min(bbox1[3], bbox2[3])
    
    inter_area = max(0, xi2 - xi1) * max(0, yi2 - yi1)
    area1 = (bbox1[2] - bbox1[0]) * (bbox1[3] - bbox1[1])
    area2 = (bbox2[2] - bbox2[0]) * (bbox2[3] - bbox2[1])
    union_area = area1 + area2 - inter_area
    
    return inter_area / union_area if union_area > 0 else 0.0

def deduplicate_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    T12: Deduplicates multiple overlapping track candidates representing
    the same physical object, keeping the one with higher risk.
    """
    deduped = []
    for cand in candidates:
        bbox1 = cand.get("bbox")
        if not bbox1:
            deduped.append(cand)
            continue
            
        duplicate = False
        for existing in deduped:
            if existing["object"] == cand["object"]:
                bbox2 = existing.get("bbox")
                if bbox2:
                    iou = calculate_iou(bbox1, bbox2)
                    if iou > 0.40:
                        duplicate = True
                        # Preserve higher risk candidate
                        if cand["risk"] > existing["risk"]:
                            existing.update(cand)
                        break
        if not duplicate:
            deduped.append(cand)
    return deduped

def prioritize_alerts(
    candidates: List[Dict[str, Any]], 
    scan_mode: bool = False, 
    orientation: Optional[Dict[str, Any]] = None
) -> Optional[Dict[str, Any]]:
    """
    T12: Attention Engine. Filters noise, deduplicates tracks, prioritizes hazards,
    enforces dynamic cooldowns, and allows critical alert preemption and risk escalation overrides.
    """
    if not candidates:
        return {
            "object": "clear",
            "confidence": 1.0,
            "direction": "ahead",
            "proximity": "far",
            "motion": "static",
            "risk": 0,
            "state": "SAFE",
            "message": "",
            "reason": ["no hazards detected"]
        }

    valid_candidates = []
    
    for cand in candidates:
        conf = cand.get("confidence", 1.0)
        
        # 1. Filter out low confidence noise
        if conf < 0.50:
            continue
            
        # 2. Uncertainty Layer: Adjust message for medium confidence
        adjusted_cand = dict(cand)
        if 0.50 <= conf <= 0.75:
            msg = adjusted_cand.get("message", "")
            if msg:
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
            "motion": "static",
            "risk": 0,
            "state": "SAFE",
            "message": "",
            "reason": ["no high-confidence hazards detected"]
        }

    # Deduplicate overlapping objects (T12)
    deduped_candidates = deduplicate_candidates(valid_candidates)

    # 3. Sort candidates by risk score descending
    deduped_candidates.sort(key=lambda x: x["risk"], reverse=True)
    
    # In Smart Scan mode, disable cooldowns to capture all sectors
    if scan_mode:
        return deduped_candidates[0]

    current_time = time.time()
    
    # 4. Process the primary (highest risk) candidate
    primary = deduped_candidates[0]
    primary_state = primary["state"]
    primary_risk = primary["risk"]
    primary_id = primary.get("id", primary["object"]) # fallback to class if no tracked ID
    
    # Determine dynamic cooldown threshold based on motion state and class type
    is_approaching = primary.get("motion") == "approaching"
    class_name = primary["object"]
    
    if primary_state == "CRITICAL":
        cooldown_threshold = CRITICAL_COOLDOWN
    elif is_approaching:
        cooldown_threshold = APPROACHING_COOLDOWN
    elif class_name in ["chair", "dining table", "diningtable"]:
        cooldown_threshold = STATIC_HAZARD_COOLDOWN
    else:
        cooldown_threshold = DEFAULT_STATIC_COOLDOWN

    # Enforce risk escalation override (jump of > 15 points bypasses cooldown)
    last_record = ANNOUNCEMENT_HISTORY.get(primary_id)
    escalated = False
    
    if last_record:
        last_announced_time = last_record["timestamp"]
        last_announced_risk = last_record["risk"]
        elapsed = current_time - last_announced_time
        
        # Risk escalation override check
        if primary_risk - last_announced_risk > 15:
            escalated = True
            primary["reason"].append(f"risk escalated from {last_announced_risk} to {primary_risk} (bypassed cooldown)")
    else:
        elapsed = 999.0 # First announcement
        
    # CRITICAL alerts always preempt other speech immediately
    if primary_state == "CRITICAL":
        primary["preempt"] = True
        ANNOUNCEMENT_HISTORY[primary_id] = {"timestamp": current_time, "risk": primary_risk}
        return primary

    # Suppress alert speech if cooling down and not escalated
    if elapsed < cooldown_threshold and not escalated:
        silent_copy = dict(primary)
        silent_copy["message"] = "" # Tells client not to trigger voice
        silent_copy["reason"].append(f"audio alert suppressed due to cooldown ({round(cooldown_threshold - elapsed, 1)}s remaining)")
        return silent_copy
        
    # Reset/schedule announcement
    ANNOUNCEMENT_HISTORY[primary_id] = {"timestamp": current_time, "risk": primary_risk}
    return primary
