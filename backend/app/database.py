import os
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# Initialize Supabase client
supabase_client = None

# Attempt to load credentials and initialize
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# Check if credentials are present, otherwise load from local .env
if not SUPABASE_URL or not SUPABASE_KEY:
    try:
        from dotenv import load_dotenv
        # Look for .env in project root
        load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", ".env"))
        SUPABASE_URL = os.environ.get("SUPABASE_URL")
        SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
    except Exception as e:
        logger.warning(f"Could not load python-dotenv: {e}")

if SUPABASE_URL and SUPABASE_KEY:
    try:
        from supabase import create_client, Client
        supabase_client: Optional[Client] = create_client(SUPABASE_URL, SUPABASE_KEY)
        logger.info("Supabase client initialized successfully.")
    except Exception as e:
        logger.error(f"Failed to initialize Supabase client: {e}")
else:
    logger.warning("SUPABASE_URL and SUPABASE_KEY environment variables not found. Running in offline mode.")

# -------------------------------------------------------------
# Database Ingestion Operations (Self-Healing Fallbacks)
# -------------------------------------------------------------

def insert_hazard_event(event_data: Dict[str, Any]) -> bool:
    """Inserts a processed hazard evaluation record into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping hazard event insert.")
        return True
        
    try:
        # Convert dictionary parameters to match schema keys
        db_payload = {
            "session_id": event_data.get("session_id", "default_session"),
            "user_id": event_data.get("user_id"), # None for anonymous visitor
            "object_type": event_data.get("object", "unknown"),
            "confidence": float(event_data.get("confidence", 0.90)),
            "direction": event_data.get("direction", "NONE").upper(),
            "proximity": event_data.get("proximity", "far").lower(),
            "motion_state": event_data.get("motion", "STATIC").upper(),
            "risk_score": int(event_data.get("risk", 0)),
            "risk_level": event_data.get("state", "SAFE").upper(),
            "reasons": event_data.get("reason", []),
            "tti": event_data.get("tti") if isinstance(event_data.get("tti"), (int, float)) else None
        }
        
        response = supabase_client.table("hazard_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (hazard_events): {e}")
        return False

def insert_audio_event(audio_data: Dict[str, Any]) -> bool:
    """Inserts an environmental sound event record into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping audio event insert.")
        return True
        
    try:
        db_payload = {
            "session_id": audio_data.get("session_id", "default_session"),
            "user_id": audio_data.get("user_id"),
            "sound_type": audio_data.get("sound_type", "siren").upper(),
            "confidence": float(audio_data.get("confidence", 0.90)),
            "amplitude_rms": float(audio_data.get("amplitude_rms", 0.10)),
            "peak_frequency_hz": float(audio_data.get("peak_frequency_hz", 800.0)),
            "safety_state": audio_data.get("safety_state", "CAUTION").upper()
        }
        
        response = supabase_client.table("audio_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (audio_events): {e}")
        return False

def insert_fusion_event(fusion_data: Dict[str, Any]) -> bool:
    """Inserts a combined multi-modal fused event record into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping fusion event insert.")
        return True
        
    try:
        db_payload = {
            "session_id": fusion_data.get("session_id", "default_session"),
            "user_id": fusion_data.get("user_id"),
            "vision_detected": bool(fusion_data.get("vision_detected", False)),
            "audio_detected": bool(fusion_data.get("audio_detected", False)),
            "motion_detected": bool(fusion_data.get("motion_detected", False)),
            "object_type": fusion_data.get("object_type"),
            "sound_type": fusion_data.get("sound_type"),
            "final_risk": int(fusion_data.get("final_risk", 0)),
            "final_level": fusion_data.get("final_level", "SAFE").upper()
        }
        
        response = supabase_client.table("fusion_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (fusion_events): {e}")
        return False

def insert_ocr_event(ocr_data: Dict[str, Any]) -> bool:
    """Inserts a signboard text recognition event record into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping OCR event insert.")
        return True
        
    try:
        db_payload = {
            "session_id": ocr_data.get("session_id", "default_session"),
            "user_id": ocr_data.get("user_id"),
            "extracted_text": ocr_data.get("extracted_text", ""),
            "confidence": float(ocr_data.get("confidence", 0.90)),
            "language": ocr_data.get("language", "English")
        }
        
        response = supabase_client.table("ocr_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (ocr_events): {e}")
        return False

def insert_emergency_event(sos_data: Dict[str, Any]) -> bool:
    """Inserts an emergency SOS alarm record into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping emergency event insert.")
        return True
        
    try:
        db_payload = {
            "session_id": sos_data.get("session_id", "default_session"),
            "user_id": sos_data.get("user_id"),
            "trigger": sos_data.get("trigger", "BUTTON").upper(),
            "status": sos_data.get("status", "ACTIVATED").upper(),
            "latitude": sos_data.get("latitude"),
            "longitude": sos_data.get("longitude")
        }
        
        response = supabase_client.table("emergency_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (emergency_events): {e}")
        return False

def insert_scan_session(session_id: str, user_id: Optional[str] = None) -> Optional[str]:
    """Registers a new Smart Scan session in Supabase and returns its UUID."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping scan session registration.")
        return "mock-scan-uuid"
        
    try:
        db_payload = {
            "session_id": session_id,
            "user_id": user_id,
            "status": "IN_PROGRESS"
        }
        response = supabase_client.table("scan_sessions").insert(db_payload).execute()
        if response.data:
            return response.data[0]["id"]
    except Exception as e:
        logger.error(f"Supabase insert error (scan_sessions): {e}")
    return None

def insert_scan_result(scan_uuid: str, result_data: Dict[str, Any]) -> bool:
    """Inserts a sector result for an active Smart Scan session."""
    if not supabase_client or scan_uuid == "mock-scan-uuid":
        logger.debug("Supabase offline: Skipping scan result insert.")
        return True
        
    try:
        db_payload = {
            "scan_id": scan_uuid,
            "direction": result_data.get("direction", "CENTER").upper(),
            "hazard": result_data.get("hazard", "clear"),
            "risk_score": int(result_data.get("risk_score", 0))
        }
        response = supabase_client.table("scan_results").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (scan_results): {e}")
        return False

def insert_spatial_event(spatial_data: Dict[str, Any]) -> bool:
    """T20: Inserts a spatial/radar trajectory event into Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping spatial event insert.")
        return True
        
    try:
        db_payload = {
            "session_id": spatial_data.get("session_id", "default_session"),
            "track_id": str(spatial_data.get("track_id", "unknown")),
            "object_type": spatial_data.get("object_type", "unknown"),
            "x_norm": float(spatial_data.get("x_norm", 0.0)),
            "depth_norm": float(spatial_data.get("depth_norm", 0.0)),
            "risk_score": int(spatial_data.get("risk", 0)),
            "motion_state": spatial_data.get("motion_state", "STATIC").upper(),
            "zone": spatial_data.get("zone", "CENTER").upper(),
            "event_type": spatial_data.get("event_type", "NEW_HAZARD").upper()
        }
        response = supabase_client.table("spatial_events").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (spatial_events): {e}")
        return False

def insert_emergency_contact(contact_data: Dict[str, Any]) -> bool:
    """T21: Inserts or updates an emergency contact in Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping contact insert.")
        return True
    try:
        db_payload = {
            "session_id": contact_data.get("session_id", "default_session"),
            "name": contact_data.get("name", "unknown"),
            "phone_number": contact_data.get("phone_number", ""),
            "priority": int(contact_data.get("priority", 1)),
            "verified": bool(contact_data.get("verified", True))
        }
        response = supabase_client.table("emergency_contacts").insert(db_payload).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (emergency_contacts): {e}")
        return False

def get_emergency_contacts(session_id: str) -> list:
    """T21: Retrieves emergency contacts for the session from Supabase."""
    if not supabase_client:
        logger.debug("Supabase offline: Returning empty emergency contacts.")
        return []
    try:
        response = supabase_client.table("emergency_contacts").select("*").eq("session_id", session_id).execute()
        return response.data if response.data else []
    except Exception as e:
        logger.error(f"Supabase select error (emergency_contacts): {e}")
        return []

def delete_emergency_contact(session_id: str, name: str) -> bool:
    """T21: Deletes a contact by name for the active session."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping contact deletion.")
        return True
    try:
        response = supabase_client.table("emergency_contacts").delete().eq("session_id", session_id).eq("name", name).execute()
        return True
    except Exception as e:
        logger.error(f"Supabase delete error (emergency_contacts): {e}")
        return False

def insert_emergency_event(event_data: Dict[str, Any]) -> bool:
    """T21: Inserts a triggered emergency SOS event into Supabase and dispatches real SMS via Twilio."""
    if not supabase_client:
        logger.debug("Supabase offline: Skipping emergency event insert.")
        return True
    try:
        db_payload = {
            "session_id": event_data.get("session_id", "default_session"),
            "trigger_source": event_data.get("trigger_source", "voice").lower(),
            "status": event_data.get("status", "ACTIVE").upper(),
            "latitude": event_data.get("latitude"),
            "longitude": event_data.get("longitude"),
            "accuracy_m": event_data.get("accuracy_m"),
            "location_available": bool(event_data.get("location_available", False)),
            "contacts_notified": int(event_data.get("contacts_notified", 0))
        }
        
        # 1. Log event to Supabase database (non-blocking with schema mismatch fallback)
        try:
            response = supabase_client.table("emergency_events").insert(db_payload).execute()
            logger.info("Emergency event logged to Supabase successfully.")
        except Exception as db_err:
            logger.warning(f"Supabase logging failed: {db_err}")
            try:
                # Fallback to core fields if custom columns are missing in user database schema
                db_payload_fallback = {
                    "session_id": db_payload["session_id"],
                    "trigger_source": db_payload["trigger_source"],
                    "status": db_payload["status"],
                    "latitude": db_payload["latitude"],
                    "longitude": db_payload["longitude"],
                    "location_available": db_payload["location_available"]
                }
                response = supabase_client.table("emergency_events").insert(db_payload_fallback).execute()
                logger.info("Emergency event logged to Supabase successfully using core fields fallback.")
            except Exception as db_err_fallback:
                logger.warning(f"Supabase logging fallback also failed (proceeding to Twilio SMS): {db_err_fallback}")
        
        # 2. Twilio SMS Dispatch
        account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
        auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
        from_number = os.environ.get("TWILIO_PHONE_NUMBER")
        
        if db_payload["status"] == "ACTIVE" and account_sid and auth_token and from_number:
            import requests
            from requests.auth import HTTPBasicAuth
            
            logger.info("Twilio configuration detected. Initiating SMS dispatch...")
            
            lat = db_payload.get("latitude")
            lon = db_payload.get("longitude")
            
            if db_payload.get("location_available") and lat is not None and lon is not None:
                map_url = f"https://maps.google.com/?q={lat},{lon}"
                message_body = f"SAHAAI Emergency SOS! Shared Location: {map_url}"
            else:
                message_body = "SAHAAI Emergency SOS! (Location coordinates unavailable)"
                
            contacts = event_data.get("contacts") or []
            for c in contacts:
                to_number = c.get("phone_number", "").strip()
                if to_number:
                    # Clean & format country code (+91 for 10-digit Indian numbers)
                    clean_number = to_number.replace(" ", "").replace("-", "")
                    if not clean_number.startswith("+"):
                        if len(clean_number) == 10:
                            clean_number = "+91" + clean_number
                        else:
                            clean_number = "+" + clean_number
                            
                    try:
                        logger.info(f"Sending Twilio SMS alert to {clean_number}...")
                        twilio_url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
                        res = requests.post(
                            twilio_url,
                            data={
                                "From": from_number,
                                "To": clean_number,
                                "Body": message_body
                            },
                            auth=HTTPBasicAuth(account_sid, auth_token),
                            timeout=6
                        )
                        if res.status_code in [200, 201]:
                            logger.info(f"Twilio SMS successfully sent to {clean_number}.")
                        else:
                            logger.error(f"Twilio API rejected message: {res.text}")
                    except Exception as twilio_err:
                        logger.error(f"Twilio API request failed: {twilio_err}")
                        
        return True
    except Exception as e:
        logger.error(f"Supabase insert error (emergency_events): {e}")
        return False
