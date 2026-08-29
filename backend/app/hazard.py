import logging
import time
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

# Size classifications for size-aware proximity estimation
LARGE_HAZARDS = {"car", "truck", "bus", "motorcycle"}
MEDIUM_HAZARDS = {"person", "chair", "dining table", "dog", "bicycle"}
SMALL_HAZARDS = {"backpack", "suitcase", "handbag", "bottle", "traffic light", "stop sign", "fire hydrant"}

# Motor vehicles target class list for horn/siren audio fusion confirmation
MOTOR_VEHICLES = {"car", "truck", "bus", "motorcycle"}

def calculate_hazard_priority(
    obj: Dict[str, Any], 
    audio_event: Optional[Dict[str, Any]] = None, 
    vision_timestamp: Optional[int] = None,
    frame_width: float = 640.0,
    frame_height: float = 480.0
) -> Dict[str, Any]:
    """
    T11/T15: Context-Aware Multimodal Sensor Fusion and Risk Engine.
    Fuses vision tracking with FFT-extracted audio features based on temporal agreement,
    track ID routing, and confidence-weighted scaling factors.
    """
    class_name = obj.get("class", "obstacle")
    confidence = obj.get("confidence", 0.9)
    motion_state = obj.get("motion", "STATIC").upper()
    track_id = obj.get("id")
    
    # 1. Coordinate mapping
    bbox = obj.get("bbox", [160, 120, 480, 360])
    xmin, ymin, xmax, ymax = bbox
    box_h = ymax - ymin
    
    # 2. T08: Corridor Direction mapping
    centroid = obj.get("centroid")
    if centroid and len(centroid) > 0:
        x_center = centroid[0]
    else:
        x_center = (xmin + xmax) / 2.0
        
    x_offset = (x_center - (frame_width / 2.0)) / (frame_width / 2.0)
    
    if -0.15 <= x_offset <= 0.15:
        direction = "center"
        direction_detail = "direct_center"
        direction_points = 20.0
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

    # 3. T09: Size-Aware Proximity Estimation
    h_ratio = box_h / frame_height
    
    if class_name in LARGE_HAZARDS:
        if h_ratio > 0.30:
            proximity = "near"
            proximity_points = 25.0
        elif 0.12 <= h_ratio <= 0.30:
            proximity = "medium"
            proximity_points = 12.0
        else:
            proximity = "far"
            proximity_points = 5.0
    elif class_name in MEDIUM_HAZARDS:
        if h_ratio > 0.40:
            proximity = "near"
            proximity_points = 25.0
        elif 0.18 <= h_ratio <= 0.40:
            proximity = "medium"
            proximity_points = 12.0
        else:
            proximity = "far"
            proximity_points = 5.0
    else:
        if h_ratio > 0.50:
            proximity = "near"
            proximity_points = 25.0
        elif 0.25 <= h_ratio <= 0.50:
            proximity = "medium"
            proximity_points = 12.0
        else:
            proximity = "far"
            proximity_points = 5.0

    # 4. T10/T11: Velocity and Time-To-Threat approach calculations
    height_history = obj.get("height_history", [])
    growth_rate = 0.0
    if len(height_history) >= 2:
        h_prev = height_history[-2]
        h_curr = height_history[-1]
        if h_prev > 0:
            growth_rate = (h_curr - h_prev) / h_prev
    else:
        growth_rate = obj.get("growth_rate", 0.0)

    # 5. T11: Risk Score Math
    severity = obj.get("severity", 0.5)
    base_score = severity * 50.0
    
    # Motion & Velocity-scaled approach points
    velocity_boost = 0.0
    if motion_state == "APPROACHING":
        motion_points = 20.0
        if growth_rate > 0:
            velocity_boost = min(15.0, growth_rate * 50.0)
    elif motion_state == "RETREATING":
        motion_points = -15.0
    else:
        motion_points = 5.0

    # 6. T15 Context-Aware Multimodal Fusion Modifier
    audio_points = 0.0
    fusion_confidence = 0.0
    time_delta_ms = 0
    fusion_reason = []
    
    if audio_event and audio_event.get("sound") and vision_timestamp is not None:
        sound_type = audio_event["sound"]
        sound_confidence = audio_event.get("confidence", 0.0)
        audio_timestamp = audio_event.get("timestamp", 0)
        
        # Calculate temporal offset
        time_delta_ms = abs(int(vision_timestamp) - int(audio_timestamp))
        
        # Temporal matching gate (1 second window)
        if time_delta_ms <= 1000:
            # Agreement confidence calculation (T15.3)
            fusion_confidence = float(sound_confidence * max(0.0, 1.0 - (time_delta_ms / 1000.0)))
            
            # Minimum fusion confidence gate (T15.4)
            if fusion_confidence >= 0.20:
                if class_name in MOTOR_VEHICLES:
                    if sound_type == "HORN":
                        audio_points = 15.0 * sound_confidence
                        fusion_reason = [
                            "vehicle detected",
                            "horn detected",
                            "audio and vision temporally aligned",
                            "vehicle was highest-risk candidate"
                        ]
                    elif sound_type == "SIREN":
                        audio_points = 18.0 * sound_confidence
                        fusion_reason = [
                            "vehicle detected",
                            "siren detected",
                            "audio and vision temporally aligned",
                            "vehicle was highest-risk candidate"
                        ]

    # Compute raw hazard sum (T15.3: Base risk + audio modifier first)
    raw_score = base_score + proximity_points + direction_points + motion_points + velocity_boost + audio_points
    
    # Non-linear confidence scaling
    confidence_factor = confidence ** 1.5
    risk_score = int(min(100, max(0, raw_score * confidence_factor)))

    # Map to safety levels
    if risk_score >= 85:
        state = "CRITICAL"
    elif risk_score >= 65:
        state = "ALERT"
    elif risk_score >= 35:
        state = "CAUTION"
    else:
        state = "SAFE"

    # Time-To-Interaction (TTI) frame estimator
    if motion_state == "APPROACHING" and growth_rate > 0:
        tti = round(1.0 / growth_rate, 1)
    else:
        tti = "infinite"

    # Explainability list
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
        if velocity_boost > 8.0:
            reasons.append("rapid approaching trajectory")
        else:
            reasons.append("approaching motion")
    elif motion_state == "RETREATING":
        reasons.append("retreating motion")
        
    if len(fusion_reason) > 0:
        reasons.append(f"audio verified threat ({audio_event['sound'].lower()})")

    # Build warning speech message text (Pillar 1 Polish guidelines)
    message = ""
    if state != "SAFE":
        dir_suffix = "ahead" if direction == "center" else f"on your {direction}"
        dir_from = "ahead" if direction == "center" else f"from your {direction}"
        
        is_horn = any("horn" in r.lower() for r in fusion_reason)
        
        lbl = class_name
        if class_name in MOTOR_VEHICLES:
            lbl = "vehicle"
            
        if state == "CRITICAL":
            if is_horn:
                message = "Critical. Vehicle approaching. Horn detected."
            else:
                message = f"Critical. {lbl.capitalize()} approaching {dir_from}."
        elif state == "ALERT":
            if motion_state == "APPROACHING":
                message = f"{lbl.capitalize()} approaching {dir_from}."
            else:
                message = f"{lbl.capitalize()} {dir_suffix}."
        else:  # CAUTION
            if class_name == "person":
                message = f"Person {dir_suffix}."
            elif class_name == "chair" or class_name in SMALL_HAZARDS:
                message = f"Obstacle {dir_suffix}."
            else:
                message = f"{lbl.capitalize()} {dir_suffix}."

    return {
        "id": track_id,
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
        "tti": tti,
        "audio_modifier": float(round(audio_points, 2)),
        "fusion_confidence": float(round(fusion_confidence, 2)),
        "fusion_reason": fusion_reason,
        "time_delta_ms": time_delta_ms
    }
