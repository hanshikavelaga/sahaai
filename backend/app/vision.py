import logging
import os
import urllib.request
from typing import List, Dict, Any
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Expanded standard COCO hazard classes for real-world assistive navigation
HAZARD_CLASSES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
    9: "traffic light",
    10: "fire hydrant",
    11: "stop sign",
    15: "cat",
    16: "dog",
    24: "backpack",     # Tripping hazard
    26: "handbag",      # Floor obstruction
    28: "suitcase",     # Tripping hazard
    39: "bottle",       # Slipping/tripping hazard
    56: "chair",
    60: "dining table",
    62: "computer screen",
    63: "computer",
    65: "keyboard"
}

# Baseline severities for hazard priority calculations (0.0 to 1.0 scale)
SEVERITIES = {
    "car": 1.0,
    "truck": 1.0,
    "bus": 1.0,
    "motorcycle": 1.0,
    "stop sign": 0.8,
    "fire hydrant": 0.8,
    "bicycle": 0.8,
    "dog": 0.8,
    "backpack": 0.7,
    "suitcase": 0.7,
    "chair": 0.6,
    "dining table": 0.6,
    "person": 0.6,
    "computer": 0.5,
    "computer screen": 0.5,
    "keyboard": 0.5,
    "traffic light": 0.5,
    "cat": 0.5,
    "handbag": 0.5,
    "bottle": 0.4
}

# Download official lightweight YOLOv8 nano ONNX model (under 25MB)
ONNX_MODEL_PATH = os.path.abspath("yolov8n.onnx")
net = None

try:
    # Self-healing: if file exists but is incomplete (less than 10MB), delete and redownload
    if os.path.exists(ONNX_MODEL_PATH):
        file_size = os.path.getsize(ONNX_MODEL_PATH)
        if file_size < 10000000:  # 10MB threshold (actual unquantized ONNX is ~12.2MB)
            logger.warning(f"YOLOv8 ONNX model is incomplete ({file_size} bytes). Deleting to force redownload.")
            try:
                os.remove(ONNX_MODEL_PATH)
            except Exception as remove_err:
                logger.error(f"Failed to remove corrupt ONNX file: {remove_err}")

    if not os.path.exists(ONNX_MODEL_PATH):
        logger.info("Memory Optimization: Downloading lightweight YOLOv8 ONNX model (12MB)...")
        # Direct download from Kalray community weights on Hugging Face (known good and accessible)
        url = "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx"
        urllib.request.urlretrieve(url, ONNX_MODEL_PATH)
        logger.info("ONNX download complete.")
        
    if os.path.exists(ONNX_MODEL_PATH):
        # Read model using OpenCV's DNN module (bypasses PyTorch entirely, saving ~600MB RAM)
        net = cv2.dnn.readNetFromONNX(ONNX_MODEL_PATH)
        net.setPreferableBackend(cv2.dnn.DNN_BACKEND_OPENCV)
        net.setPreferableTarget(cv2.dnn.DNN_TARGET_CPU)
        logger.info("YOLOv8 ONNX loaded successfully using OpenCV DNN (Low-memory mode).")
except Exception as e:
    logger.error(f"Could not load YOLOv8 ONNX model ({e}). Using mock object detection fallback.")
    net = None

def detect_text_regions(image: np.ndarray) -> bool:
    """
    Very lightweight text region detector using Sobel horizontal gradients
    and contour geometry checks. Prevents running expensive OCR on every frame.
    """
    if image is None:
        return False
    try:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if len(image.shape) == 3 else image
        
        # Sobel horizontal gradients
        grad_x = cv2.Sobel(gray, cv2.CV_8U, 1, 0, ksize=3)
        _, thresh = cv2.threshold(grad_x, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Morphological rect kernel to group characters horizontally
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
        closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        
        # Find contour areas
        contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        
        for c in contours:
            x, y, w, h = cv2.boundingRect(c)
            aspect_ratio = w / float(h)
            # Text lines are typically wider than they are tall
            if w > 30 and h > 8 and 2.0 < aspect_ratio < 10.0:
                return True
    except Exception as e:
        logger.warning(f"Lightweight text detection failed: {e}")
    return False

def detect_objects(image: np.ndarray) -> List[Dict[str, Any]]:
    """
    Runs YOLOv8 ONNX inference via OpenCV DNN.
    Returns filtered object detections containing bounding boxes, classes, and confidence.
    """
    detections = []
    
    if image is None:
        return detections
        
    frame_height, frame_width = image.shape[:2]

    # Run inference using OpenCV DNN if loaded
    if net is not None:
        try:
            # YOLOv8 expects 640x640, values scaled to [0,1], swap blue/red channels
            blob = cv2.dnn.blobFromImage(image, 1/255.0, (640, 640), swapRB=True, crop=False)
            net.setInput(blob)
            preds = net.forward() # shape: (1, 84, 8400)
            
            # Transpose to shape (8400, 84) where 84 = [x_center, y_center, w, h, class0_score, ...]
            preds = preds[0].T
            
            boxes = []
            confidences = []
            class_ids = []
            
            for pred in preds:
                scores = pred[4:]
                class_id = int(np.argmax(scores))
                conf = float(scores[class_id])
                
                # Check confidence threshold
                if class_id in HAZARD_CLASSES and conf >= 0.25:
                    x_center, y_center, width, height = pred[0:4]
                    
                    # Map coordinates back to original frame dimensions
                    x_factor = frame_width / 640.0
                    y_factor = frame_height / 640.0
                    
                    xmin = int((x_center - width / 2) * x_factor)
                    ymin = int((y_center - height / 2) * y_factor)
                    xmax = int((x_center + width / 2) * x_factor)
                    ymax = int((y_center + height / 2) * y_factor)
                    
                    # Bind boxes inside frame limits
                    xmin = max(0, xmin)
                    ymin = max(0, ymin)
                    xmax = min(frame_width, xmax)
                    ymax = min(frame_height, ymax)
                    
                    boxes.append([xmin, ymin, xmax, ymax])
                    confidences.append(conf)
                    class_ids.append(class_id)
            
            # Apply Non-Maximum Suppression (NMS) to eliminate duplicate overlapping boxes
            indices = cv2.dnn.NMSBoxes(boxes, confidences, 0.25, 0.45)
            
            if len(indices) > 0:
                # Handle OpenCV output flat array differences
                flat_indices = indices.flatten() if hasattr(indices, 'flatten') else [i[0] for i in indices]
                for idx in flat_indices:
                    class_name = HAZARD_CLASSES[class_ids[idx]]
                    detections.append({
                        "class": class_name,
                        "confidence": confidences[idx],
                        "bbox": boxes[idx], # [xmin, ymin, xmax, ymax]
                        "severity": SEVERITIES.get(class_name, 0.4)
                    })
            return detections
        except Exception as e:
            logger.error(f"ONNX inference error: {e}. Falling back to mock detection.")

    # Fallback to empty list instead of generating false detections when model is loading/fails
    return detections
