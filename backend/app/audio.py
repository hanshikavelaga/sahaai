import io
import logging
import numpy as np
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

# Constants for audio DSP
SAMPLE_RATE = 16000  # Default expected recording sample rate
MIN_RMS_THRESHOLD = 0.03  # Minimum root-mean-square amplitude to ignore noise

class AdaptiveAudioDetector:
    """
    T14: Adaptive Temporal Audio Event Detector that processes 6 spectral features
    from the client, profiles ambient noise floors, and scans for structured
    frequency sweeps (sirens) and steady pitch durations (horns).
    """
    def __init__(self, sample_rate_hz: int = 16000):
        self.history: List[Dict[str, Any]] = []
        self.max_history_len = 10  # Track last 3 seconds of features at 3 FPS
        self.noise_floor = 0.01  # Default fallback noise floor
        self.noise_floor_samples: List[float] = []
        self.noise_floor_collected = False
        
    def process_features(self, features: Dict[str, Any]) -> Dict[str, Any]:
        """
        Processes a single feature packet and updates temporal classification state.
        """
        rms = features.get("rms", 0.0)
        peak_hz = features.get("peak_hz", 0.0)
        centroid_hz = features.get("centroid_hz", 0.0)
        bandwidth_hz = features.get("bandwidth_hz", 0.0)
        flatness = features.get("flatness", 0.0)
        peak_strength = features.get("peak_strength", 0.0)
        timestamp = features.get("timestamp", 0)
        
        # 1. Profile ambient noise floor in the first 6 frames (approx. 2 seconds)
        if not self.noise_floor_collected:
            self.noise_floor_samples.append(rms)
            if len(self.noise_floor_samples) >= 6:
                # Set noise floor to the mean plus 1.5 standard deviations (adaptive envelope)
                mean_rms = np.mean(self.noise_floor_samples)
                std_rms = np.std(self.noise_floor_samples)
                self.noise_floor = float(max(0.005, mean_rms + 1.5 * std_rms))
                self.noise_floor_collected = True
                logger.info(f"Audio calibration: Ambient noise floor set to {self.noise_floor:.4f}")
            # While calibrating, return no sound event
            return {"sound": None, "confidence": 0.0, "timestamp": timestamp}
            
        # 2. Append to temporal history buffer
        self.history.append({
            "rms": rms,
            "peak_hz": peak_hz,
            "centroid_hz": centroid_hz,
            "bandwidth_hz": bandwidth_hz,
            "flatness": flatness,
            "peak_strength": peak_strength,
            "timestamp": timestamp
        })
        if len(self.history) > self.max_history_len:
            self.history.pop(0)
            
        # 3. Check threshold filters relative to noise floor
        # Signal must be louder than noise floor threshold (3x)
        if rms < self.noise_floor * 3.0:
            return {"sound": None, "confidence": 0.0, "timestamp": timestamp}
            
        # 4. Run Car Horn Detector (Steady dominant frequency duration gating)
        # Conditions:
        # - Dominant frequency lies inside the Horn Band (400Hz to 750Hz)
        # - Flatness must be low (< 0.15), indicating non-noisy pure tone
        # - Peak strength must be high (> 0.65)
        # - Pitch must be steady (low standard deviation) for at least 3 consecutive frames
        if 400.0 <= peak_hz <= 750.0 and flatness < 0.15 and peak_strength > 0.65:
            # Check history for duration (min 3 frames of matching horn signature)
            horn_frames = 0
            recent_pitches = []
            for frame in reversed(self.history):
                f_rms = frame["rms"]
                f_peak = frame["peak_hz"]
                f_flatness = frame["flatness"]
                f_strength = frame["peak_strength"]
                
                if (f_rms > self.noise_floor * 2.0 and 
                    400.0 <= f_peak <= 750.0 and 
                    f_flatness < 0.20 and 
                    f_strength > 0.55):
                    horn_frames += 1
                    recent_pitches.append(f_peak)
                else:
                    break
            
            # Require at least 3 frames (approx. 1.0 second) of pitch stability
            if horn_frames >= 3:
                pitch_std = np.std(recent_pitches)
                if pitch_std < 30.0:  # Dominant frequency is steady
                    confidence = float(min(0.95, 0.4 + (rms / (self.noise_floor * 10.0)) + (peak_strength * 0.3)))
                    return {"sound": "HORN", "confidence": confidence, "timestamp": timestamp}

        # 5. Run Siren Detector (Structured frequency sweeps)
        # Conditions:
        # - Sweeping inside the Emergency band (600Hz to 1500Hz)
        # - Standard deviation of pitch is active (> 50Hz)
        # - Pitch sweeps (cycles of UP and DOWN slope changes) must exist in history
        # - Low average flatness (pure tones oscillating)
        siren_history = [f for f in self.history if 600.0 <= f["peak_hz"] <= 1500.0 and f["flatness"] < 0.25]
        if len(siren_history) >= 5:
            pitches = [f["peak_hz"] for f in siren_history]
            pitch_std = np.std(pitches)
            
            if pitch_std > 50.0:  # Significant active modulation
                # Count slope direction changes
                directions = []
                for i in range(1, len(pitches)):
                    diff = pitches[i] - pitches[i-1]
                    if abs(diff) > 20.0: # ignore minor jitter
                        directions.append(1 if diff > 0 else -1)
                        
                # Count direction changes (UP to DOWN / DOWN to UP transitions)
                dir_changes = 0
                for i in range(1, len(directions)):
                    if directions[i] != directions[i-1]:
                        dir_changes += 1
                        
                # A valid siren sweep over 10 frames will have at least 1 slope direction change
                if dir_changes >= 1:
                    avg_strength = np.mean([f["peak_strength"] for f in siren_history])
                    confidence = float(min(0.98, 0.5 + (avg_strength * 0.4)))
                    return {"sound": "SIREN", "confidence": confidence, "timestamp": timestamp}
                    
        return {"sound": None, "confidence": 0.0, "timestamp": timestamp}


def analyze_audio_chunk(raw_bytes: bytes) -> Dict[str, Any]:
    """
    LEGACY FALLBACK: Analyzes raw audio bytes using FFT to detect frequency peaks.
    Maintained for backwards compatibility with baseline APIs.
    """
    result = {
        "detected": False,
        "sound_type": None,
        "confidence": 0.0,
        "message": ""
    }

    if not raw_bytes or len(raw_bytes) < 256:
        return result

    try:
        # Check if WAV format (RIFF header)
        if raw_bytes[:4] == b"RIFF":
            try:
                from scipy.io import wavfile
                sample_rate, data = wavfile.read(io.BytesIO(raw_bytes))
                if len(data.shape) > 1:
                    data = data[:, 0]
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
            except Exception as e:
                logger.warning(f"Failed to parse WAV header: {e}. Falling back to raw PCM parsing.")
                data = np.frombuffer(raw_bytes[44:], dtype=np.int16).astype(np.float32) / 32768.0
                sample_rate = SAMPLE_RATE
        else:
            data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            sample_rate = SAMPLE_RATE

        if len(data) < 128:
            return result

        rms = float(np.sqrt(np.mean(data**2)))
        if rms < MIN_RMS_THRESHOLD:
            return result

        fft_data = np.abs(np.fft.rfft(data))
        frequencies = np.fft.rfftfreq(len(data), d=1.0/sample_rate)

        valid_indices = np.where(frequencies >= 100)[0]
        if len(valid_indices) == 0:
            return result
            
        valid_fft = fft_data[valid_indices]
        valid_freqs = frequencies[valid_indices]

        peak_idx = np.argmax(valid_fft)
        peak_freq = float(valid_freqs[peak_idx])
        peak_amp = float(valid_fft[peak_idx])
        
        mean_val = float(np.mean(valid_fft))
        peak_ratio = peak_amp / max(0.01, mean_val)

        if peak_ratio > 3.5:
            if 350.0 <= peak_freq <= 500.0:
                result["detected"] = True
                result["sound_type"] = "horn"
                result["confidence"] = float(min(0.95, 0.4 + (rms * 0.5) + (peak_ratio * 0.02)))
                result["message"] = "Possible vehicle sound detected nearby."
                result["amplitude_rms"] = rms
                result["peak_frequency_hz"] = peak_freq
            elif 600.0 <= peak_freq <= 1500.0:
                result["detected"] = True
                result["sound_type"] = "siren"
                result["confidence"] = float(min(0.98, 0.5 + (rms * 0.4) + (peak_ratio * 0.02)))
                result["message"] = "Warning. Emergency siren sound detected nearby."
                result["amplitude_rms"] = rms
                result["peak_frequency_hz"] = peak_freq

    except Exception as e:
        logger.error(f"Error in audio analysis: {e}")
        
    return result
