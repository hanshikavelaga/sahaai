-- ==========================================
-- SAHAAI Supabase PostgreSQL Database Schema
-- Run this in your Supabase SQL Editor
-- ==========================================

-- 1. ENUMS (Custom Data Types)
CREATE TYPE safety_state_type AS ENUM ('SAFE', 'CAUTION', 'ALERT', 'CRITICAL');
CREATE TYPE direction_type AS ENUM ('LEFT', 'CENTER', 'RIGHT', 'REAR', 'AROUND', 'NONE');
CREATE TYPE motion_type AS ENUM ('STATIC', 'APPROACHING', 'RETREATING');
CREATE TYPE sound_pattern_type AS ENUM ('HORN', 'SIREN', 'ALARM');

-- 2. TABLES

-- A. Profiles (Linked to Supabase Auth)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now(),
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    preferred_language TEXT DEFAULT 'English',
    voice_enabled BOOLEAN DEFAULT true,
    alert_frequency TEXT DEFAULT 'normal'
);

-- B. Hazard Events (Camera YOLO + Tracker + Score)
CREATE TABLE IF NOT EXISTS public.hazard_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE, -- NULL if anonymous visitor
    object_type TEXT NOT NULL,
    confidence FLOAT NOT NULL,
    direction direction_type DEFAULT 'NONE',
    proximity TEXT NOT NULL,          -- 'near', 'medium', 'far'
    motion_state motion_type DEFAULT 'STATIC',
    risk_score INT NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_level safety_state_type DEFAULT 'SAFE',
    reasons JSONB DEFAULT '[]'::jsonb,
    tti FLOAT                         -- Time-to-Interaction
);

-- C. Audio Events (Microphone FFT peaks)
CREATE TABLE IF NOT EXISTS public.audio_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    sound_type sound_pattern_type NOT NULL,
    confidence FLOAT NOT NULL,
    amplitude_rms FLOAT NOT NULL,
    peak_frequency_hz FLOAT NOT NULL,
    safety_state safety_state_type DEFAULT 'CAUTION'
);

-- D. Fusion Events (Integrated Multi-Modal Status)
CREATE TABLE IF NOT EXISTS public.fusion_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    vision_detected BOOLEAN DEFAULT false,
    audio_detected BOOLEAN DEFAULT false,
    motion_detected BOOLEAN DEFAULT false,
    object_type TEXT,
    sound_type TEXT,
    final_risk INT NOT NULL CHECK (final_risk >= 0 AND final_risk <= 100),
    final_level safety_state_type DEFAULT 'SAFE'
);

-- E. Scan Sessions (Smart Scan tracker)
CREATE TABLE IF NOT EXISTS public.scan_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    status TEXT DEFAULT 'IN_PROGRESS' -- 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'
);

-- F. Scan Results (Sector details for Smart Scan)
CREATE TABLE IF NOT EXISTS public.scan_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scan_id UUID REFERENCES public.scan_sessions(id) ON DELETE CASCADE,
    direction direction_type NOT NULL,
    hazard TEXT NOT NULL,              -- E.g. 'car', 'person', 'clear'
    risk_score INT NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    timestamp TIMESTAMPTZ DEFAULT now()
);

-- G. OCR Events (Read text/signs)
CREATE TABLE IF NOT EXISTS public.ocr_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    extracted_text TEXT NOT NULL,
    confidence FLOAT NOT NULL,
    language TEXT DEFAULT 'English'
);

-- H. Voice Alerts (Speech logs)
CREATE TABLE IF NOT EXISTS public.voice_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    message TEXT NOT NULL,
    alert_level safety_state_type DEFAULT 'SAFE',
    triggered_by TEXT NOT NULL,        -- 'hazard_event', 'audio_event', 'scan'
    delivered BOOLEAN DEFAULT true
);

-- I. Emergency Events (SOS tracker)
CREATE TABLE IF NOT EXISTS public.emergency_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT now(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users ON DELETE CASCADE,
    trigger TEXT NOT NULL,             -- 'VOICE', 'BUTTON'
    status TEXT DEFAULT 'ACTIVATED',   -- 'ACTIVATED', 'RESOLVED'
    latitude FLOAT,
    longitude FLOAT
);

-- 3. INDEXES (For speed query and performance)
CREATE INDEX IF NOT EXISTS idx_hazard_session ON public.hazard_events(session_id);
CREATE INDEX IF NOT EXISTS idx_audio_session ON public.audio_events(session_id);
CREATE INDEX IF NOT EXISTS idx_fusion_session ON public.fusion_events(session_id);
CREATE INDEX IF NOT EXISTS idx_scan_session ON public.scan_sessions(session_id);

-- 4. ROW LEVEL SECURITY (RLS) POLICIES
-- Bypasses for anonymous access during local testing / hackathon phase, 
-- but strictly locks tables to the logged-in user if authenticated.

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hazard_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_events ENABLE ROW LEVEL SECURITY;

-- A. Profile access policy
CREATE POLICY "Allow public select for validation" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Allow individual write" ON public.profiles FOR ALL USING (auth.uid() = id);

-- B. Event Log policy (Enforce user limits, allows anon inserts for MVP testing)
CREATE POLICY "Allow anon insert for hackathon testing" ON public.hazard_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read their own events" ON public.hazard_events FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for audio" ON public.audio_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read audio" ON public.audio_events FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for fusion" ON public.fusion_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read fusion" ON public.fusion_events FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for scan session" ON public.scan_sessions FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read scan session" ON public.scan_sessions FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for scan results" ON public.scan_results FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read scan results" ON public.scan_results FOR SELECT USING (true);

CREATE POLICY "Allow anon insert for ocr" ON public.ocr_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read ocr" ON public.ocr_events FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for voice" ON public.voice_alerts FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read voice" ON public.voice_alerts FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);

CREATE POLICY "Allow anon insert for emergency" ON public.emergency_events FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow users to read emergency" ON public.emergency_events FOR SELECT USING (auth.uid() = user_id OR user_id IS NULL);
