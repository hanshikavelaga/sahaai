import time
import numpy as np
import pytest
from backend.app.vision import SEVERITIES
from backend.app.tracking import ObjectTracker
from backend.app.hazard import calculate_hazard_priority
from backend.app.attention import prioritize_alerts, ANNOUNCEMENT_HISTORY
from backend.app.audio import analyze_audio_chunk

def test_scenario_a_static_person():
    """
    Scenario A: A static person at medium distance (height fraction 0.25)
    in the center. Expected safety state: CAUTION.
    """
    mock_tracked_obj = {
        "id": 1,
        "class": "person",
        "bbox": [100, 100, 200, 220], # height = 120 pixels (120/480 = 0.25 height fraction)
        "centroid": [160, 320],        # center horizontal coordinate (160/640 = 0.25 -> left, wait, center is 0.35 - 0.65)
        # Let's place it in center
        "centroid": [300, 160],        # 300/640 = 0.468 (center)
        "motion": "STATIC",
        "severity": SEVERITIES["person"],
        "height_history": [120, 120]
    }
    
    result = calculate_hazard_priority(mock_tracked_obj)
    
    assert result["object"] == "person"
    assert result["state"] == "CAUTION"
    assert "person" in result["message"]
    assert "center" in result["direction"]

def test_scenario_b_near_chair():
    """
    Scenario B: A static chair in near distance (height fraction 0.45)
    directly in the path (center). Expected safety state: ALERT.
    """
    mock_tracked_obj = {
        "id": 2,
        "class": "chair",
        "bbox": [200, 100, 350, 316], # height = 216 pixels (216/480 = 0.45 height fraction -> NEAR)
        "centroid": [275, 208],        # 275/640 = 0.43 (center)
        "motion": "STATIC",
        "severity": SEVERITIES["chair"],
        "height_history": [216, 216]
    }
    
    result = calculate_hazard_priority(mock_tracked_obj)
    
    assert result["object"] == "chair"
    assert result["state"] == "ALERT"
    assert "obstacle" in result["message"] or "chair" in result["message"]

def test_scenario_c_approaching_car_tracking():
    """
    Scenario C: A car detected over consecutive frames getting larger.
    Verify tracking detects APPROACHING state, TTI registers, elevating state to CRITICAL.
    """
    tracker = ObjectTracker()
    
    # Frame 1: Car detected (medium proximity)
    det1 = [{"class": "car", "bbox": [100, 100, 200, 180], "severity": SEVERITIES["car"]}] # height = 80px
    res1 = tracker.update(det1, 640, 480)
    
    # Frame 2: Car getting larger
    det2 = [{"class": "car", "bbox": [90, 90, 210, 198], "severity": SEVERITIES["car"]}] # height = 108px (ratio 108/80 = 1.35 approaching)
    res2 = tracker.update(det2, 640, 480)
    
    assert len(res2) == 1
    assert res2[0]["motion"] == "APPROACHING"
    
    # Run hazard calculations on Frame 2 tracked output
    hazard_res = calculate_hazard_priority(res2[0])
    
    assert hazard_res["state"] == "CRITICAL"
    assert "Critical" in hazard_res["message"]
    assert float(hazard_res["tti"]) < float("inf")

def test_scenario_d_audio_siren():
    """
    Scenario D: Periodic oscillation frequency peak (900Hz) in audio buffer representing a siren.
    Expected: "Warning. Emergency siren sound detected nearby." alert.
    """
    sample_rate = 16000
    duration = 0.5  # half second buffer
    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    
    # Generate 900 Hz sine wave tone
    tone = np.sin(2 * np.pi * 900 * t)
    
    # Normalize to mock int16 audio buffer
    tone_int16 = (tone * 16384).astype(np.int16)
    audio_bytes = tone_int16.tobytes()
    
    result = analyze_audio_chunk(audio_bytes)
    
    assert result["detected"] == True
    assert result["sound_type"] == "siren"
    assert "siren" in result["message"].lower()

def test_scenario_e_multi_object_prioritization():
    """
    Scenario E: Multiple objects passed to attention engine (a near car and a far chair).
    Verify that the attention engine prioritizes the vehicle and suppresses the chair.
    """
    car_hazard = {
        "id": 1,
        "object": "car",
        "confidence": 0.92,
        "direction": "right",
        "proximity": "near",
        "motion": "approaching",
        "risk": 95,
        "state": "CRITICAL",
        "message": "Warning! Car approaching on your right!",
        "reason": ["approaching vehicle"]
    }
    
    chair_hazard = {
        "id": 2,
        "object": "chair",
        "confidence": 0.85,
        "direction": "center",
        "proximity": "far",
        "motion": "STATIC",
        "risk": 20,
        "state": "SAFE",
        "message": "",
        "reason": ["static obstacle far away"]
    }
    
    # Reset announcement history
    ANNOUNCEMENT_HISTORY.clear()
    
    result = prioritize_alerts([car_hazard, chair_hazard])
    
    # Vehicle should be prioritized
    assert result["object"] == "car"
    assert result["state"] == "CRITICAL"
    assert "Warning!" in result["message"]

def test_scenario_f_cooldown_suppression():
    """
    Scenario F: Enforcing alert cooldowns on static objects (e.g. Chair).
    Verify that if the same chair is reported twice consecutively within cooldown, 
    the voice alert message is cleared.
    """
    chair_hazard = {
        "id": 3,
        "object": "chair",
        "confidence": 0.88,
        "direction": "center",
        "proximity": "near",
        "motion": "STATIC",
        "risk": 70,
        "state": "ALERT",
        "message": "Caution. Obstacle ahead.",
        "reason": ["near chair"]
    }
    
    ANNOUNCEMENT_HISTORY.clear()
    
    # First announcement: Should speak
    res1 = prioritize_alerts([chair_hazard])
    assert res1["message"] == "Caution. Obstacle ahead."
    
    # Second announcement (within 10s cooldown): Message should be empty (silent speech trigger)
    res2 = prioritize_alerts([chair_hazard])
    assert res2["message"] == ""
    assert any("cooldown" in r for r in res2["reason"])

def test_scenario_g_audio_vision_fusion():
    """
    Scenario G: Vision detects a static car, and microphone registers a synchronized horn event.
    Verify that the risk engine adds a +15.0 * confidence audio risk modifier to the vehicle.
    """
    from backend.app.vision import SEVERITIES
    
    now_ms = int(time.time() * 1000)
    mock_car = {
        "id": 4,
        "class": "car",
        "bbox": [100, 100, 200, 180], # height = 80px
        "centroid": [300, 160],
        "motion": "STATIC",
        "severity": SEVERITIES["car"],
        "height_history": [80, 80],
        "confidence": 0.90
    }
    
    # Baseline run (no audio)
    res_no_audio = calculate_hazard_priority(mock_car, vision_timestamp=now_ms)
    
    # Audio-fused run
    mock_audio_event = {"sound": "HORN", "confidence": 0.90, "timestamp": now_ms - 200} # 200ms delta (synchronized)
    res_with_audio = calculate_hazard_priority(mock_car, audio_event=mock_audio_event, vision_timestamp=now_ms)
    
    assert res_with_audio["risk"] > res_no_audio["risk"]
    assert res_with_audio["audio_modifier"] == 15.0 * 0.90
    assert any("audio verified threat (horn)" in r for r in res_with_audio["reason"])

def test_scenario_h_audio_only_caution():
    """
    Scenario H: Test the client-side feature parser and noise floor classifier.
    Verify that consecutive steady horn features trigger a HORN classification.
    """
    from backend.app.audio import AdaptiveAudioDetector
    detector = AdaptiveAudioDetector()
    
    # 1. Calibrate noise floor with 6 quiet frames
    for i in range(6):
        res = detector.process_features({
            "rms": 0.005,
            "peak_hz": 200.0,
            "centroid_hz": 200.0,
            "bandwidth_hz": 30.0,
            "flatness": 0.5,
            "peak_strength": 0.1,
            "timestamp": i * 330
        })
        assert res["sound"] is None
        
    # 2. Feed sustained car horn tone (4 frames)
    # Pitch is steady at 500Hz, flatness is very low, strength is high, RMS is loud (0.15)
    horn_res = None
    for i in range(4):
        horn_res = detector.process_features({
            "rms": 0.15,
            "peak_hz": 500.0,
            "centroid_hz": 500.0,
            "bandwidth_hz": 20.0,
            "flatness": 0.05,
            "peak_strength": 0.8,
            "timestamp": (6 + i) * 330
        })
        
    assert horn_res["sound"] == "HORN"
    assert horn_res["confidence"] > 0.60

def test_scenario_i_adaptive_audio_vocal_filter():
    """
    Scenario I: Play vocal sweep noise.
    Verify that voice jitter and high flatness ratios are ignored.
    """
    from backend.app.audio import AdaptiveAudioDetector
    detector = AdaptiveAudioDetector()
    
    # Calibrate noise floor
    for i in range(6):
        detector.process_features({
            "rms": 0.005,
            "peak_hz": 200.0,
            "centroid_hz": 200.0,
            "bandwidth_hz": 30.0,
            "flatness": 0.5,
            "peak_strength": 0.1,
            "timestamp": i * 330
        })
        
    # Erratic human voice features (frequency sweeps but high flatness and low strength)
    vocal_res = None
    for i in range(4):
        vocal_res = detector.process_features({
            "rms": 0.08,
            "peak_hz": 600.0 + (i * 200.0), # sweeping rapidly (600, 800, 1000, 1200)
            "centroid_hz": 800.0,
            "bandwidth_hz": 400.0, # wide speech bandwidth
            "flatness": 0.40,      # noisy flatness
            "peak_strength": 0.30, # weak peak dominance
            "timestamp": (6 + i) * 330
        })
        
    assert vocal_res["sound"] is None

def test_scenario_j_fusion_multi_target_resolution():
    """
    Scenario J: Multi-target resolution rule.
    Verify that motor vehicles are prioritized correctly for fusion.
    """
    from backend.app.vision import SEVERITIES
    now_ms = int(time.time() * 1000)
    
    # Motorcycle (Highest base risk candidate)
    mock_car_c = {
        "id": 10,
        "class": "motorcycle",
        "bbox": [100, 100, 200, 300],
        "centroid": [300, 160],
        "motion": "APPROACHING",
        "severity": SEVERITIES["motorcycle"],
        "height_history": [150, 200],
        "confidence": 0.95
    }
    
    mock_audio_event = {"sound": "HORN", "confidence": 0.90, "timestamp": now_ms}
    res_fused = calculate_hazard_priority(mock_car_c, audio_event=mock_audio_event, vision_timestamp=now_ms)
    
    assert res_fused["audio_modifier"] > 0.0
    assert res_fused["risk"] >= 85

def test_scenario_k_low_fusion_confidence():
    """
    Scenario K: Low fusion confidence threshold gate.
    Sound confidence = 0.40, time delta = 900ms.
    Expected: fusion_confidence < 0.20, so NO fusion modifier is applied.
    """
    from backend.app.vision import SEVERITIES
    now_ms = int(time.time() * 1000)
    
    mock_car = {
        "id": 11,
        "class": "car",
        "bbox": [100, 100, 200, 180],
        "centroid": [300, 160],
        "motion": "STATIC",
        "severity": SEVERITIES["car"],
        "height_history": [80, 80],
        "confidence": 0.90
    }
    
    mock_audio_event = {"sound": "HORN", "confidence": 0.40, "timestamp": now_ms - 900} # 900ms difference
    res = calculate_hazard_priority(mock_car, audio_event=mock_audio_event, vision_timestamp=now_ms)
    
    assert res["audio_modifier"] == 0.0
    assert res["fusion_confidence"] < 0.20

def test_scenario_l_state_escalation_alert_to_critical():
    """
    Scenario L: Escalation state transitions.
    Base risk = 78 (ALERT). Horn increases risk above 85 (CRITICAL).
    """
    from backend.app.vision import SEVERITIES
    now_ms = int(time.time() * 1000)
    
    mock_car = {
        "id": 12,
        "class": "car",
        "bbox": [100, 100, 200, 200],
        "centroid": [300, 160],
        "motion": "STATIC",
        "severity": SEVERITIES["car"],
        "height_history": [150, 160],
        "confidence": 0.90
    }
    
    base_res = calculate_hazard_priority(mock_car, audio_event=None, vision_timestamp=None)
    assert base_res["state"] == "ALERT"
    
    mock_audio_event = {"sound": "HORN", "confidence": 0.95, "timestamp": now_ms}
    fused_res = calculate_hazard_priority(mock_car, audio_event=mock_audio_event, vision_timestamp=now_ms)
    
    assert fused_res["state"] == "CRITICAL"
    assert "Critical" in fused_res["message"]

def test_scenario_m_smart_scan_critical_preemption():
    """
    Scenario M: A critical safety warning must always preempt Smart Scan.
    Verify that the Attention Engine prioritizes a critical Approaching Car (risk 95)
    over a static scan candidate (risk 40).
    """
    scan_hazard = {
        "id": 1,
        "object": "chair",
        "confidence": 0.85,
        "direction": "left",
        "proximity": "near",
        "motion": "static",
        "risk": 40,
        "state": "CAUTION",
        "message": "Caution. Obstacle on your left."
    }
    
    critical_hazard = {
        "id": 2,
        "object": "car",
        "confidence": 0.95,
        "direction": "right",
        "proximity": "near",
        "motion": "approaching",
        "risk": 95,
        "state": "CRITICAL",
        "message": "Critical. car approaching on your right!"
    }
    
    # Priority check
    result = prioritize_alerts([scan_hazard, critical_hazard])
    
    # The critical hazard must be selected
    assert result["object"] == "car"
    assert result["state"] == "CRITICAL"
    assert "Critical" in result["message"]

def test_scenario_n_scan_persistence_filtering():
    """
    Scenario N: Persistence filtering logic (python simulation).
    Static objects require >= 50% persistence, moving critical threats are retained.
    """
    # 5 captured frames
    frame_1 = [
        {"id": 10, "object": "car", "risk": 45, "motion": "static", "confidence": 0.80},
        {"id": 12, "object": "dog", "risk": 30, "motion": "static", "confidence": 0.70}
    ]
    frame_2 = [
        {"id": 10, "object": "car", "risk": 45, "motion": "static", "confidence": 0.80},
        {"id": 15, "object": "car", "risk": 88, "motion": "approaching", "confidence": 0.90} # critical motorcycle
    ]
    frame_3 = [
        {"id": 10, "object": "car", "risk": 45, "motion": "static", "confidence": 0.85}
    ]
    frame_4 = [
        {"id": 10, "object": "car", "risk": 45, "motion": "static", "confidence": 0.85}
    ]
    frame_5 = []
    
    all_frames = [frame_1, frame_2, frame_3, frame_4, frame_5]
    total_frames = len(all_frames)
    
    # Run persistence logic
    counts = {}
    max_risk = {}
    motion_states = {}
    
    for frame in all_frames:
        for det in frame:
            key = f"{det['id']}_{det['object']}"
            counts[key] = counts.get(key, 0) + 1
            max_risk[key] = max(max_risk[key] if key in max_risk else 0, det["risk"])
            if det["motion"] == "approaching":
                motion_states[key] = "approaching"
                
    final_retained = []
    for key, count in counts.items():
        persistence = count / total_frames
        risk = max_risk[key]
        is_approaching = motion_states.get(key) == "approaching"
        
        # Filter
        keep = False
        if risk >= 85 or is_approaching:
            keep = True # Retain moving threat
        elif persistence >= 0.50:
            keep = True # Retain static obstacle
            
        if keep:
            final_retained.append(key)
            
    # Track 10 (car) had 4/5 = 80% persistence -> Retained
    # Track 15 (car approaching) had 1/5 = 20% persistence but is critical -> Retained
    # Track 12 (dog) had 1/5 = 20% persistence -> Discarded
    assert "10_car" in final_retained
    assert "15_car" in final_retained
    assert "12_dog" not in final_retained

def test_scenario_o_smart_scan_summary_linguistic_compiler():
    """
    Scenario O: Validate the Task 17 Natural-Language Scan Summary Compiler rules.
    Verifies priority-first alerts, class counts grouping, and clearance reports.
    """
    def compile_summary_v2(collected_data):
        zones = ["LEFT", "CENTER", "RIGHT", "REAR"]
        lead_warning = ""
        other_zones = []
        for zone in zones:
            items = collected_data.get(zone, [])
            if len(items) == 0:
                other_zones.append(f"{zone.lower()} side is clear")
            else:
                class_counts = {}
                max_risk = 0
                target_obj = None
                for it in items:
                    c = it["class"]
                    class_counts[c] = class_counts.get(c, 0) + 1
                    if it["risk"] > max_risk:
                        max_risk = it["risk"]
                        target_obj = it
                item_descs = [f"{count} {cls + 's' if count > 1 else cls}" for cls, count in class_counts.items()]
                if len(item_descs) > 2:
                    formatted_list = "multiple obstacles"
                else:
                    formatted_list = " and ".join(item_descs)
                if max_risk >= 85 and target_obj:
                    action = "approaching" if target_obj["motion"] == "APPROACHING" else "detected"
                    zone_desc = f"Critical. {target_obj['class']} {action} on your {zone.lower()}"
                    lead_warning = zone_desc
                elif max_risk >= 65 and target_obj:
                    action = "approaching" if target_obj["motion"] == "APPROACHING" else "detected"
                    zone_desc = f"Warning. {target_obj['class']} {action} on your {zone.lower()}"
                    if not lead_warning:
                        lead_warning = zone_desc
                    else:
                        other_zones.append(zone_desc)
                else:
                    other_zones.append(f"on your {zone.lower()}: {formatted_list}")
        if lead_warning:
            summary = lead_warning
            if other_zones:
                summary += ". " + ". ".join(other_zones)
        else:
            all_clear = all(len(collected_data.get(z, [])) == 0 for z in zones)
            if all_clear:
                summary = "Smart scan complete. Environment clear."
            else:
                summary = "Scan complete. " + ". ".join(other_zones)
        return summary

    # Scenario O.A: Critical lead warning
    collected_a = {
        "LEFT": [{"class": "person", "risk": 40, "motion": "STATIC"}],
        "CENTER": [],
        "RIGHT": [{"class": "car", "risk": 90, "motion": "APPROACHING"}],
        "REAR": []
    }
    summary_a = compile_summary_v2(collected_a)
    assert "Critical. car approaching on your right" in summary_a
    assert "on your left: 1 person" in summary_a
    
    # Scenario O.B: Quantities grouping
    collected_b = {
        "LEFT": [
            {"class": "chair", "risk": 30, "motion": "STATIC"},
            {"class": "chair", "risk": 30, "motion": "STATIC"}
        ],
        "CENTER": [],
        "RIGHT": [],
        "REAR": []
    }
    summary_b = compile_summary_v2(collected_b)
    assert "on your left: 2 chairs" in summary_b
    
    # Scenario O.C: Environment clear
    collected_c = {"LEFT": [], "CENTER": [], "RIGHT": [], "REAR": []}
    summary_c = compile_summary_v2(collected_c)
    assert summary_c == "Smart scan complete. Environment clear."

def test_scenario_p_spatial_event_logging():
    """
    Scenario P: Event-Based Spatial Logging Gating.
    1. Verify displacement thresholds (delta > 0.15) for HAZARD_MOVE.
    2. Verify risk level changes (state shift) for HAZARD_ESCALATE.
    3. Verify track isolation across multiple items.
    """
    class TrackStateCache:
        def __init__(self):
            self.logged_states = {}
            self.log_history = []
            
        def process_detection(self, track_id, x_norm, depth_norm, risk, state, object_type, motion_state, has_fusion=False):
            track_str = str(track_id)
            cached = self.logged_states.get(track_str)
            state_key = state
            event_type = "AUDIO_FUSION" if has_fusion else "NEW_HAZARD"
            
            if not cached:
                new_obj = {"x_norm": x_norm, "depth_norm": depth_norm, "risk": risk, "state": state_key}
                self.logged_states[track_str] = new_obj
                self.log_history.append((track_str, event_type, risk, (x_norm, depth_norm)))
            else:
                is_escalated = state_key != cached["state"] or (has_fusion and cached["state"] != "FUSED")
                dx = x_norm - cached["x_norm"]
                dy = depth_norm - cached["depth_norm"]
                delta = (dx*dx + dy*dy)**0.5
                
                if is_escalated:
                    cached["state"] = "FUSED" if has_fusion else state_key
                    cached["risk"] = risk
                    self.log_history.append((track_str, "AUDIO_FUSION" if has_fusion else "HAZARD_ESCALATE", risk, (x_norm, depth_norm)))
                elif delta > 0.15:
                    cached["x_norm"] = x_norm
                    cached["depth_norm"] = depth_norm
                    self.log_history.append((track_str, "HAZARD_MOVE", risk, (x_norm, depth_norm)))
                    
        def resolve_track(self, track_id):
            track_str = str(track_id)
            if track_str in self.logged_states:
                self.log_history.append((track_str, "HAZARD_RESOLVED", 0, (0.0, 0.0)))
                del self.logged_states[track_str]
                
    cache = TrackStateCache()
    
    # Frame 1: New hazard (Track 17)
    cache.process_detection(17, x_norm=0.10, depth_norm=0.20, risk=30, state="CAUTION", object_type="car", motion_state="STATIC")
    assert len(cache.log_history) == 1
    assert cache.log_history[-1][1] == "NEW_HAZARD"
    
    # Frame 2: Tiny movement (delta = 0.05) -> Gated / No log
    cache.process_detection(17, x_norm=0.13, depth_norm=0.24, risk=30, state="CAUTION", object_type="car", motion_state="STATIC")
    assert len(cache.log_history) == 1
    
    # Frame 3: Significant movement (delta = 0.18) -> HAZARD_MOVE logged
    cache.process_detection(17, x_norm=0.25, depth_norm=0.33, risk=30, state="CAUTION", object_type="car", motion_state="STATIC")
    assert len(cache.log_history) == 2
    assert cache.log_history[-1][1] == "HAZARD_MOVE"
    
    # Frame 4: Risk escalation (Caution -> Critical) -> HAZARD_ESCALATE logged
    cache.process_detection(17, x_norm=0.27, depth_norm=0.35, risk=90, state="CRITICAL", object_type="car", motion_state="APPROACHING")
    assert len(cache.log_history) == 3
    assert cache.log_history[-1][1] == "HAZARD_ESCALATE"
    
    # Frame 5: New independent Track 20 -> Gating isolation check
    cache.process_detection(20, x_norm=-0.50, depth_norm=0.40, risk=25, state="CAUTION", object_type="person", motion_state="STATIC")
    assert len(cache.log_history) == 4
    assert cache.log_history[-1][0] == "20"
    assert cache.log_history[-1][1] == "NEW_HAZARD"
    
    # Frame 6: Track 17 disappears -> HAZARD_RESOLVED logged
    cache.resolve_track(17)
    assert len(cache.log_history) == 5
    assert cache.log_history[-1][0] == "17"
    assert cache.log_history[-1][1] == "HAZARD_RESOLVED"
    assert "17" not in cache.logged_states
    assert "20" in cache.logged_states





