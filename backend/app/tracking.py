import math
import logging
from typing import List, Dict, Any, Tuple

logger = logging.getLogger(__name__)

class ObjectTracker:
    """
    Lightweight, dependency-free centroid tracker that tracks objects
    across consecutive video frames and estimates their relative motion
    (approaching, static, retreating) based on size changes.
    """
    def __init__(self, max_unseen_frames: int = 4):
        self.next_object_id = 0
        # self.tracked_objects[id] = {
        #     "id": int,
        #     "class": str,
        #     "centroid": (x, y),
        #     "bbox": [xmin, ymin, xmax, ymax],
        #     "history": [[xmin, ymin, xmax, ymax], ...],
        #     "unseen_count": int,
        #     "motion": str # "APPROACHING", "RETREATING", "STATIC"
        # }
        self.tracked_objects: Dict[int, Dict[str, Any]] = {}
        self.max_unseen_frames = max_unseen_frames

    def _calculate_centroid(self, bbox: List[float]) -> Tuple[float, float]:
        xmin, ymin, xmax, ymax = bbox
        return ((xmin + xmax) / 2.0, (ymin + ymax) / 2.0)

    def _calculate_height(self, bbox: List[float]) -> float:
        return bbox[3] - bbox[1]

    def update(self, detections: List[Dict[str, Any]], frame_width: int, frame_height: int) -> List[Dict[str, Any]]:
        """
        Updates the tracker with the current frame's detections.
        Returns a list of tracked objects with coordinates, ids, and motion states.
        """
        # If no detections, increment unseen count for all tracked objects
        if not detections:
            expired_ids = []
            for obj_id, obj in self.tracked_objects.items():
                obj["unseen_count"] += 1
                if obj["unseen_count"] > self.max_unseen_frames:
                    expired_ids.append(obj_id)
            for obj_id in expired_ids:
                del self.tracked_objects[obj_id]
            return []

        new_centroids = [self._calculate_centroid(d["bbox"]) for d in detections]
        
        # If no objects are currently tracked, register all detections as new
        if not self.tracked_objects:
            for i, det in enumerate(detections):
                self._register_object(det, new_centroids[i])
        else:
            # Match existing tracked objects with new detections using Euclidean distance
            object_ids = list(self.tracked_objects.keys())
            object_centroids = [obj["centroid"] for obj in self.tracked_objects.values()]
            
            # Distance matrix
            distances = []
            for obj_c in object_centroids:
                row = []
                for new_c in new_centroids:
                    dist = math.sqrt((obj_c[0] - new_c[0])**2 + (obj_c[1] - new_c[1])**2)
                    row.append(dist)
                distances.append(row)
            
            # Greedy matching: find the minimum distance pairs
            used_objects = set()
            used_detections = set()
            
            # Max matching distance threshold (e.g., 25% of frame width)
            max_match_dist = frame_width * 0.25
            
            # Find pairings
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
                
                # Update tracked object
                self._update_object(obj_id, det, new_centroids[d_idx])
                
                used_objects.add(o_idx)
                used_detections.add(d_idx)
            
            # Unmatched existing objects: mark as unseen
            for o_idx, obj_id in enumerate(object_ids):
                if o_idx not in used_objects:
                    self.tracked_objects[obj_id]["unseen_count"] += 1
            
            # Delete expired tracked objects
            expired_ids = [oid for oid, obj in self.tracked_objects.items() if obj["unseen_count"] > self.max_unseen_frames]
            for oid in expired_ids:
                del self.tracked_objects[oid]
                
            # Register unmatched new detections as new objects
            for d_idx, det in enumerate(detections):
                if d_idx not in used_detections:
                    self._register_object(det, new_centroids[d_idx])
        
        # Format the return data
        result = []
        for obj_id, obj in self.tracked_objects.items():
            if obj["unseen_count"] == 0: # only return active objects in the current frame
                result.append({
                    "id": obj_id,
                    "class": obj["class"],
                    "bbox": obj["bbox"],
                    "centroid": obj["centroid"],
                    "motion": obj["motion"],
                    "severity": obj["severity"],
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
            "severity": detection["severity"]
        }
        self.next_object_id += 1

    def _update_object(self, object_id: int, detection: Dict[str, Any], centroid: Tuple[float, float]):
        obj = self.tracked_objects[object_id]
        
        # Calculate motion state based on height history (prior to adding the new box)
        h_current = self._calculate_height(detection["bbox"])
        h_history = [self._calculate_height(b) for b in obj["history"]]
        
        motion = "STATIC"
        if len(h_history) >= 1:
            h_prev = h_history[-1]
            ratio = h_current / h_prev if h_prev > 0 else 1.0
            
            # Size increases by more than 8% -> Approaching
            # Size decreases by more than 8% -> Retreating
            if ratio > 1.08:
                motion = "APPROACHING"
            elif ratio < 0.92:
                motion = "RETREATING"
            else:
                motion = obj["motion"] # Maintain previous motion state if within threshold noise
        
        obj["centroid"] = centroid
        obj["bbox"] = detection["bbox"]
        obj["history"].append(detection["bbox"])
        if len(obj["history"]) > 6:
            obj["history"].pop(0)
        obj["unseen_count"] = 0
        obj["motion"] = motion
        obj["severity"] = detection["severity"]
