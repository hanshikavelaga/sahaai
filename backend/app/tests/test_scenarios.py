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
    Verify that the risk engine adds a +15.0 audio risk modifier to the vehicle.
    """
    from backend.app.vision import SEVERITIES
    
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
    res_no_audio = calculate_hazard_priority(mock_car)
    
    # Audio-fused run
    mock_audio_event = {"sound": "HORN", "confidence": 0.85, "timestamp": int(time.time() * 1000)}
    res_with_audio = calculate_hazard_priority(mock_car, audio_event=mock_audio_event)
    
    assert res_with_audio["risk"] > res_no_audio["risk"]
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

