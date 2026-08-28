import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

def calculate_hazard_priority(tracked_obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    Computes the Prototype Hazard Priority Score, Time-to-Interaction (TTI),
    and maps the result to a formal safety state (SAFE, CAUTION, ALERT, CRITICAL).
    """
    obj_class = tracked_obj["class"]
    bbox = tracked_obj["bbox"]
    centroid = tracked_obj["centroid"]
    motion = tracked_obj["motion"]
    severity = tracked_obj["severity"]
    height_history = tracked_obj["height_history"]

    # We assume frame dimensions are standard (scaled coordinates sent by client or vision module)
    # If the bounding box is a fraction [0-1] or absolute pixels, let's normalize heights.
    # We will compute relative dimensions assuming bounding box coordinates are relative [0-1] or absolute.
    # Let's inspect coordinates format: YOLO box coordinates are usually pixels, but let's normalize to a standard height range.
    # To be extremely safe, we'll assume relative scaling if values are <= 1.0, otherwise divide by an assumed standard frame size.
    # A standard camera frame width/height is usually 640x480.
    
    # Calculate box height and horizontal position fraction
    # Let's check coordinates.
    y_min, x_min, y_max, x_max = bbox[1], bbox[0], bbox[3], bbox[2]
    box_height = y_max - y_min
    box_width = x_max - x_min
    
    # Heuristically normalize height fraction to estimate proximity
    # If values look like absolute pixels (e.g., > 1.0), normalize using typical webcam 480px height
    is_absolute = box_height > 1.0
    height_norm = box_height / 480.0 if is_absolute else box_height
    cx_norm = centroid[0] / 640.0 if is_absolute else centroid[0]
    
    # 1. Proximity Factor
    # NEAR: > 35% height, MEDIUM: 15% - 35% height, FAR: < 15% height
    if height_norm > 0.35:
        proximity_factor = 1.0
        proximity_state = "near"
    elif height_norm >= 0.15:
        proximity_factor = 0.6
        proximity_state = "medium"
    else:
        proximity_factor = 0.2
        proximity_state = "far"
        
    # 2. Position Factor
    # CENTER: 0.35 to 0.65 horizontal coordinate
    if 0.35 <= cx_norm <= 0.65:
        position_factor = 1.2
        direction = "center"
    elif cx_norm < 0.35:
        position_factor = 1.0
        direction = "left"
    else:
        position_factor = 1.0
        direction = "right"
        
    # 3. Motion Factor
    if motion == "APPROACHING":
        motion_factor = 1.5
    elif motion == "RETREATING":
        motion_factor = 0.5
    else: # STATIC
        motion_factor = 1.0
        
    # 4. Time-to-Interaction (TTI)
    # Estimate rate of approach from height history change
    tti = float("inf")
    rate_of_approach = 0.0
    
    if len(height_history) >= 2:
        h_curr = height_history[-1]
        h_prev = height_history[-2]
        # Normalize history scale
        if is_absolute:
            h_curr /= 480.0
            h_prev /= 480.0
            
        dh = h_curr - h_prev
        if dh > 0: # object is getting larger (approaching)
            rate_of_approach = dh # rate of height change per frame chunk
            # TTI in terms of frames = distance proxy / rate
            # We proxy distance as (1.0 - height_norm) since height approaches 1.0 as it gets extremely close
            distance_proxy = max(0.01, 1.0 - height_norm)
            tti = distance_proxy / max(0.005, rate_of_approach)
            
    # Calculate Raw Priority Score
    priority_raw = severity * proximity_factor * motion_factor * position_factor
    
    # Normalize score out of 100 by scaling by 100
    normalized_score = int(priority_raw * 100)
    
    # Apply TTI Urgency Bonus (Predictive adjustment)
    # If the object is approaching fast (low TTI), boost the hazard score
    reasons = []
    if severity >= 0.8:
        reasons.append("high object severity")
    if proximity_state == "near":
        reasons.append("near proximity")
    if motion == "APPROACHING":
        reasons.append("approaching motion")
    if direction == "center":
        reasons.append("directly in path")

    if tti != float("inf") and tti < 5.0: # Less than 5 frames to contact at current rate
        boost = int((5.0 - tti) * 6) # up to +30 points boost
        normalized_score = min(100, normalized_score + boost)
        reasons.append(f"fast approach rate (TTI ~ {round(tti, 1)} frames)")
        
    normalized_score = max(0, min(100, normalized_score))
    
    # Map to safety state
    if normalized_score >= 81:
        state = "CRITICAL"
    elif normalized_score >= 61:
        state = "ALERT"
    elif normalized_score >= 31:
        state = "CAUTION"
    else:
        state = "SAFE"
        
    # Generate verbal alert warning text
    direction_phrasing = "ahead" if direction == "center" else f"on your {direction}"
    
    if state == "CRITICAL":
        message = f"Warning! {obj_class.upper()} approaching {direction_phrasing}!"
    elif state == "ALERT":
        message = f"Caution. {obj_class} detected {direction_phrasing}."
    elif state == "CAUTION":
        message = f"{obj_class} {direction_phrasing}."
    else:
        message = "" # No alert for safe state
        
    if not reasons:
        reasons.append("normal tracking")
        
    return {
        "id": tracked_obj["id"],
        "object": obj_class,
        "confidence": float(tracked_obj.get("confidence", 0.90)),
        "direction": direction,
        "proximity": proximity_state,
        "motion": motion,
        "risk": normalized_score,
        "state": state,
        "message": message,
        "reason": reasons,
        "tti": "infinite" if tti == float("inf") else round(tti, 2)
    }
