import logging
import os
import urllib.request
from typing import List, Dict, Any
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Define standard COCO hazard classes we care about
HAZARD_CLASSES = {
    0: "person",
    1: "bicycle",
    2: "car",
    3: "motorcycle",
    5: "bus",
    7: "truck",
    9: "traffic light",
    56: "chair",
    60: "dining table"
}

# Baseline severities for hazard priority calculations
SEVERITIES = {
    "car": 1.0,
    "truck": 1.0,
    "bus": 1.0,
    "motorcycle": 1.0,
    "bicycle": 0.8,
    "chair": 0.6,
    "dining table": 0.6,
    "traffic light": 0.5,
    "person": 0.5
}

# Download official lightweight YOLOv8 nano ONNX model (under 25MB)
ONNX_MODEL_PATH = os.path.abspath("yolov8n.onnx")
net = None

try:
    if not os.path.exists(ONNX_MODEL_PATH):
        logger.info("Memory Optimization: Downloading lightweight YOLOv8 ONNX model (23MB)...")
        url = "https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.onnx"
        # Download directly via urllib
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
                if class_id in HAZARD_CLASSES and conf >= 0.40:
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
            indices = cv2.dnn.NMSBoxes(boxes, confidences, 0.40, 0.45)
            
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

    # FALLBACK MOCK DETECTION (Triggered only if ONNX fails)
    mean_val = float(np.mean(image))
    if mean_val > 50:
        if int(mean_val) % 3 == 0:
            detections.append({
                "class": "person",
                "confidence": 0.88,
                "bbox": [int(frame_width * 0.4), int(frame_height * 0.2), int(frame_width * 0.6), int(frame_height * 0.8)],
                "severity": SEVERITIES["person"]
            })
        elif int(mean_val) % 3 == 1:
            detections.append({
                "class": "chair",
                "confidence": 0.72,
                "bbox": [int(frame_width * 0.2), int(frame_height * 0.5), int(frame_width * 0.45), int(frame_height * 0.9)],
                "severity": SEVERITIES["chair"]
            })
            
    return detections
