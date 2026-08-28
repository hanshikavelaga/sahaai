import logging
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

# Size classifications for size-aware proximity estimation
LARGE_HAZARDS = {"car", "truck", "bus", "motorcycle"}
MEDIUM_HAZARDS = {"person", "chair", "dining table", "dog", "bicycle"}
SMALL_HAZARDS = {"backpack", "suitcase", "handbag", "bottle", "traffic light", "stop sign", "fire hydrant"}

def calculate_hazard_priority(obj: Dict[str, Any]) -> Dict[str, Any]:
    """
    T08 & T09: Calculates size-aware proximity, multi-corridor direction,
    and priority risk score (0-100) for a tracked object.
    """
    class_name = obj.get("class", "obstacle")
    confidence = obj.get("confidence", 0.9)
    motion_state = obj.get("motion", "STATIC").upper() # 'APPROACHING', 'STATIC', 'RETREATING'
    
    # 1. Coordinate destructuring & box math
    bbox = obj.get("bbox", [160, 120, 480, 360])
    xmin, ymin, xmax, ymax = bbox
    box_h = ymax - ymin
    
    frame_width = 640.0
    frame_height = 480.0
    
    # 2. T08: Corridor Direction classification (using centroid first, then bounding box center)
    centroid = obj.get("centroid")
    if centroid and len(centroid) > 0:
        x_center = centroid[0]
    else:
        x_center = (xmin + xmax) / 2.0
        
    x_offset = (x_center - (frame_width / 2.0)) / (frame_width / 2.0)
    
    if -0.15 <= x_offset <= 0.15:
        direction = "center"
        direction_detail = "direct_center"
        direction_points = 15.0
    elif -0.40 <= x_offset < -0.15:
        direction = "left"
        direction_detail = "slight_left"
        direction_points = 10.0
    elif 0.15 < x_offset <= 0.40:
        direction = "right"
        direction_detail = "slight_right"
        direction_points = 10.0
    elif x_offset < -0.40:
        direction = "left"
        direction_detail = "far_left"
        direction_points = 5.0
    else:
        direction = "right"
        direction_detail = "far_right"
        direction_points = 5.0

    # 3. T09: Size-Aware Proximity Estimation based on object height ratio
    h_ratio = box_h / frame_height
    
    if class_name in LARGE_HAZARDS:
        # Cars/trucks: close at smaller screen heights due to physical scale
        if h_ratio > 0.30:
            proximity = "near"
            proximity_points = 35.0
        elif 0.12 <= h_ratio <= 0.30:
            proximity = "medium"
            proximity_points = 20.0
        else:
            proximity = "far"
            proximity_points = 5.0
            
    elif class_name in MEDIUM_HAZARDS:
        # People/chairs: medium scale
        if h_ratio > 0.40:
            proximity = "near"
            proximity_points = 35.0
        elif 0.18 <= h_ratio <= 0.40:
            proximity = "medium"
            proximity_points = 20.0
        else:
            proximity = "far"
            proximity_points = 5.0
            
    else:
        # Small items (backpacks/bottles)
        if h_ratio > 0.50:
            proximity = "near"
            proximity_points = 35.0
        elif 0.25 <= h_ratio <= 0.50:
            proximity = "medium"
            proximity_points = 20.0
        else:
            proximity = "far"
            proximity_points = 5.0

    # 4. T11: Risk Score Logic (Severity * Proximity * Motion * Position * Confidence)
    severity = obj.get("severity", 0.5)
    base_score = severity * 50.0
    
    # Motion modifiers
    if motion_state == "APPROACHING":
        motion_points = 25.0
    elif motion_state == "RETREATING":
        motion_points = -25.0
    else:
        motion_points = 0.0 # Static gets normal baseline

    # Add points and scale by confidence
    raw_score = base_score + proximity_points + direction_points + motion_points
    risk_score = int(min(100, max(0, raw_score * confidence)))

    # Map score to safety levels
    if risk_score >= 85:
        state = "CRITICAL"
    elif risk_score >= 65:
        state = "ALERT"
    elif risk_score >= 35:
        state = "CAUTION"
    else:
        state = "SAFE"

    # 5. Logical Explainability reasons
    reasons = []
    if severity >= 0.8:
        reasons.append(f"high-severity {class_name}")
    else:
        reasons.append(f"detected {class_name}")
        
    if proximity == "near":
        reasons.append("near proximity")
    elif proximity == "medium":
        reasons.append("medium proximity")
        
    if direction_detail == "direct_center":
        reasons.append("direct collision trajectory")
    elif direction_detail in ["slight_left", "slight_right"]:
        reasons.append("close side offset")
        
    if motion_state == "APPROACHING":
        reasons.append("approaching motion")
    elif motion_state == "RETREATING":
        reasons.append("retreating motion")

    # TTI frame estimator based on consecutive height history tracking
    height_history = obj.get("height_history", [])
    growth_rate = 0.0
    if len(height_history) >= 2:
        h_prev = height_history[-2]
        h_curr = height_history[-1]
        if h_prev > 0:
            growth_rate = (h_curr - h_prev) / h_prev
    else:
        growth_rate = obj.get("growth_rate", 0.0)

    if motion_state == "APPROACHING" and growth_rate > 0:
        tti = round(1.0 / growth_rate, 1)
    else:
        tti = "infinite"

    # Build warning speech message text
    message = ""
    if state != "SAFE":
        direction_prompt = "ahead" if direction == "center" else f"on your {direction}"
        if state == "CRITICAL":
            message = f"Warning! {class_name} approaching {direction_prompt}!"
        else:
            message = f"Caution. {class_name} {direction_prompt}."

    return {
        "object": class_name,
        "state": state,
        "risk": risk_score,
        "direction": direction,
        "direction_detail": direction_detail,
        "proximity": proximity,
        "motion": motion_state.lower(),
        "confidence": confidence,
        "bbox": bbox,
        "message": message,
        "reason": reasons,
        "tti": tti
    }
