import math
import logging
from typing import List, Dict, Any, Tuple

logger = logging.getLogger(__name__)

class ObjectTracker:
    """
    T10: Centroid tracker with EMA smoothing, hysteresis motion states,
    and linear velocity projection (track memory) for missed frames.
    """
    def __init__(self, max_unseen_frames: int = 8):
        self.next_object_id = 0
        self.tracked_objects: Dict[int, Dict[str, Any]] = {}
        self.max_unseen_frames = max_unseen_frames # Keep tracks alive up to 8 frames internally

    def _calculate_centroid(self, bbox: List[float]) -> Tuple[float, float]:
        xmin, ymin, xmax, ymax = bbox
        return ((xmin + xmax) / 2.0, (ymin + ymax) / 2.0)

    def _calculate_height(self, bbox: List[float]) -> float:
        return bbox[3] - bbox[1]

    def _predict_unseen_object(self, object_id: int):
        """
        Projects coordinates of temporarily lost tracks using velocity estimates.
        """
        obj = self.tracked_objects[object_id]
        obj["unseen_count"] += 1
        
        # Project state if within internal memory limit
        if obj["unseen_count"] <= self.max_unseen_frames:
            xmin, ymin, xmax, ymax = obj["bbox"]
            vx = obj.get("vx", 0.0)
            vy = obj.get("vy", 0.0)
            vh = obj.get("vh", 0.0)
            
            # Apply velocity projections (clamped coordinate drift)
            xmin_new = xmin + vx
            ymin_new = ymin + vy
            xmax_new = xmax + vx
            ymax_new = ymax + vy + vh
            
            # Ensure projected box remains geometrically sound
            if xmin_new < xmax_new and ymin_new < ymax_new:
                projected_bbox = [xmin_new, ymin_new, xmax_new, ymax_new]
                obj["bbox"] = projected_bbox
                obj["centroid"] = ((xmin_new + xmax_new) / 2.0, (ymin_new + ymax_new) / 2.0)
                obj["history"].append(projected_bbox)
                if len(obj["history"]) > 8:
                    obj["history"].pop(0)

    def update(self, detections: List[Dict[str, Any]], frame_width: int, frame_height: int) -> List[Dict[str, Any]]:
        """
        Updates the tracker with the current frame's detections.
        Returns a list of active tracks with coordinate projections and motion states.
        """
        # If no detections, project all active tracks and clean up expired ones
        if not detections:
            expired_ids = []
            for obj_id in list(self.tracked_objects.keys()):
                self._predict_unseen_object(obj_id)
                if self.tracked_objects[obj_id]["unseen_count"] > self.max_unseen_frames:
                    expired_ids.append(obj_id)
            for obj_id in expired_ids:
                del self.tracked_objects[obj_id]
            return []

        new_centroids = [self._calculate_centroid(d["bbox"]) for d in detections]
        
        # Register new objects if none are tracked yet
        if not self.tracked_objects:
            for i, det in enumerate(detections):
                self._register_object(det, new_centroids[i])
        else:
            object_ids = list(self.tracked_objects.keys())
            object_centroids = [obj["centroid"] for obj in self.tracked_objects.values()]
            
            # Euclidean distance matrix
            distances = []
            for obj_c in object_centroids:
                row = []
                for new_c in new_centroids:
                    dist = math.sqrt((obj_c[0] - new_c[0])**2 + (obj_c[1] - new_c[1])**2)
                    row.append(dist)
                distances.append(row)
            
            # Greedy pairing
            used_objects = set()
            used_detections = set()
            max_match_dist = frame_width * 0.25 # Match corridor threshold
            
            pairings = []
            for o_idx in range(len(object_ids)):
                for d_idx in range(len(detections)):
                    pairings.append((distances[o_idx][d_idx], o_idx, d_idx))
            
            pairings.sort(key=lambda x: x[0])
            
            for dist, o_idx, d_idx in pairings:
                if o_idx in used_objects or d_idx in used_detections:
                    continue
                if dist > max_match_dist:
                    continue
                    
                obj_id = object_ids[o_idx]
                det = detections[d_idx]
                
                # Match found: update existing tracker state
                self._update_object(obj_id, det, new_centroids[d_idx])
                used_objects.add(o_idx)
                used_detections.add(d_idx)
            
            # Unmatched existing objects: mark missed and project next position
            for o_idx, obj_id in enumerate(object_ids):
                if o_idx not in used_objects:
                    self._predict_unseen_object(obj_id)
            
            # Prune long-lost tracks
            expired_ids = [oid for oid, obj in self.tracked_objects.items() if obj["unseen_count"] > self.max_unseen_frames]
            for oid in expired_ids:
                del self.tracked_objects[oid]
                
            # Register brand new detections
            for d_idx, det in enumerate(detections):
                if d_idx not in used_detections:
                    self._register_object(det, new_centroids[d_idx])
        
        # Format the active return data
        result = []
        for obj_id, obj in self.tracked_objects.items():
            # Return tracks that are seen, or recently missed (up to 3 frames) to keep UI smooth
            if obj["unseen_count"] <= 3:
                result.append({
                    "id": obj_id,
                    "class": obj["class"],
                    "bbox": obj["bbox"],
                    "centroid": obj["centroid"],
                    "motion": obj["motion"],
                    "severity": obj["severity"],
                    "vx": obj.get("vx", 0.0),
                    "vy": obj.get("vy", 0.0),
                    "growth_rate": obj.get("smoothed_growth", 0.0),
                    "unseen_count": obj["unseen_count"],
                    "height_history": [self._calculate_height(b) for b in obj["history"]]
                })
        return result

    def _register_object(self, detection: Dict[str, Any], centroid: Tuple[float, float]):
        self.tracked_objects[self.next_object_id] = {
            "class": detection["class"],
            "centroid": centroid,
            "bbox": detection["bbox"],
            "history": [detection["bbox"]],
            "unseen_count": 0,
            "motion": "STATIC",
            "severity": detection["severity"],
            "vx": 0.0,
            "vy": 0.0,
            "vh": 0.0,
            "smoothed_growth": 0.0
        }
        self.next_object_id += 1

    def _update_object(self, object_id: int, detection: Dict[str, Any], centroid: Tuple[float, float]):
        obj = self.tracked_objects[object_id]
        
        # Previous parameters
        bbox_prev = obj["bbox"]
        h_prev = self._calculate_height(bbox_prev)
        x_c_prev, y_c_prev = obj["centroid"]
        
        # Current parameters
        bbox_curr = detection["bbox"]
        h_curr = self._calculate_height(bbox_curr)
        x_c_curr, y_c_curr = centroid
        
        # Calculate instant change velocities
        inst_vx = x_c_curr - x_c_prev
        inst_vy = y_c_curr - y_c_prev
        inst_vh = h_curr - h_prev
        
        # EMA smoothing filters (alpha = 0.35)
        alpha = 0.35
        obj["vx"] = alpha * inst_vx + (1.0 - alpha) * obj.get("vx", 0.0)
        obj["vy"] = alpha * inst_vy + (1.0 - alpha) * obj.get("vy", 0.0)
        obj["vh"] = alpha * inst_vh + (1.0 - alpha) * obj.get("vh", 0.0)
        
        # Compute growth rate and smooth it
        current_growth = (h_curr - h_prev) / h_prev if h_prev > 0 else 0.0
        obj["smoothed_growth"] = alpha * current_growth + (1.0 - alpha) * obj.get("smoothed_growth", 0.0)
        
        # Hysteresis state transition machine
        smoothed_growth = obj["smoothed_growth"]
        prev_motion = obj["motion"]
        
        if prev_motion == "APPROACHING":
            if smoothed_growth < 0.02: # Threshold to leave approaching
                if smoothed_growth < -0.05:
                    motion = "RETREATING"
                else:
                    motion = "STATIC"
            else:
                motion = "APPROACHING"
        elif prev_motion == "RETREATING":
            if smoothed_growth > -0.02: # Threshold to leave retreating
                if smoothed_growth > 0.05:
                    motion = "APPROACHING"
                else:
                    motion = "STATIC"
            else:
                motion = "RETREATING"
        else: # STATIC
            if smoothed_growth > 0.05: # Threshold to enter approaching
                motion = "APPROACHING"
            elif smoothed_growth < -0.05: # Threshold to enter retreating
                motion = "RETREATING"
            else:
                motion = "STATIC"
        
        obj["centroid"] = centroid
        obj["bbox"] = bbox_curr
        obj["history"].append(bbox_curr)
        if len(obj["history"]) > 8:
            obj["history"].pop(0)
        obj["unseen_count"] = 0
        obj["motion"] = motion
        obj["severity"] = detection["severity"]
