import io
import logging
import numpy as np
from typing import Dict, Any

logger = logging.getLogger(__name__)

# Constants for audio DSP
SAMPLE_RATE = 16000  # Default expected recording sample rate
MIN_RMS_THRESHOLD = 0.03  # Minimum root-mean-square amplitude to ignore noise

def analyze_audio_chunk(raw_bytes: bytes) -> Dict[str, Any]:
    """
    Analyzes raw audio bytes using FFT to detect frequency peaks corresponding
    to horn and siren patterns.
    Supports WAV format and raw 16-bit PCM.
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
                # Convert to mono if stereo
                if len(data.shape) > 1:
                    data = data[:, 0]
                # Normalize integer arrays to floats between -1.0 and 1.0
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
            except Exception as e:
                logger.warning(f"Failed to parse WAV header: {e}. Falling back to raw PCM parsing.")
                # Fallback: strip header bytes and treat remainder as raw PCM
                data = np.frombuffer(raw_bytes[44:], dtype=np.int16).astype(np.float32) / 32768.0
                sample_rate = SAMPLE_RATE
        else:
            # Assume raw 16-bit PCM mono audio
            data = np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0
            sample_rate = SAMPLE_RATE

        if len(data) < 128:
            return result

        # Compute signal amplitude (RMS)
        rms = float(np.sqrt(np.mean(data**2)))
        
        # Log amplitude for diagnostic debugging
        logger.debug(f"Audio chunk processed: RMS={rms:.4f}")
        
        # If signal is too quiet, skip FFT checks to prevent false positives from noise
        if rms < MIN_RMS_THRESHOLD:
            return result

        # Compute Real Fast Fourier Transform (rfft)
        fft_data = np.abs(np.fft.rfft(data))
        frequencies = np.fft.rfftfreq(len(data), d=1.0/sample_rate)

        # Ignore very low frequency rumble (< 100Hz) to filter DC offset and handling noise
        valid_indices = np.where(frequencies >= 100)[0]
        if len(valid_indices) == 0:
            return result
            
        valid_fft = fft_data[valid_indices]
        valid_freqs = frequencies[valid_indices]

        # Find the dominant peak frequency
        peak_idx = np.argmax(valid_fft)
        peak_freq = float(valid_freqs[peak_idx])
        peak_amp = float(valid_fft[peak_idx])
        
        # Calculate spectral peak ratio (how dominant is this frequency over background)
        mean_val = float(np.mean(valid_fft))
        peak_ratio = peak_amp / max(0.01, mean_val)

        # SIREN range: 600 Hz - 1500 Hz (often oscillating)
        # HORN range: 350 Hz - 500 Hz (dense, loud peak)
        # Peak ratio threshold checks if the sound is a pure/periodic tone
        if peak_ratio > 3.5:
            if 350.0 <= peak_freq <= 500.0:
                result["detected"] = True
                result["sound_type"] = "horn"
                # Scale confidence on amplitude and peak ratio
                result["confidence"] = float(min(0.95, 0.4 + (rms * 0.5) + (peak_ratio * 0.02)))
                result["message"] = "Possible vehicle sound detected nearby."
                logger.info(f"Audio detector: HORN matched. Freq={peak_freq:.1f}Hz, Peak Ratio={peak_ratio:.1f}")
            elif 600.0 <= peak_freq <= 1500.0:
                result["detected"] = True
                result["sound_type"] = "siren"
                result["confidence"] = float(min(0.98, 0.5 + (rms * 0.4) + (peak_ratio * 0.02)))
                result["message"] = "Warning. Emergency siren sound detected nearby."
                logger.info(f"Audio detector: SIREN matched. Freq={peak_freq:.1f}Hz, Peak Ratio={peak_ratio:.1f}")

    except Exception as e:
        logger.error(f"Error in audio analysis: {e}")
        
    return result
