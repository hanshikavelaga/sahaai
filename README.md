# SAHAAI 🛡️👁️🔊
### Smart AI Hazard Awareness & Assistive Intelligence

SAHAAI is a voice-first, low-latency assistive companion Progressive Web App (PWA) designed to empower visually impaired and blind users to navigate the physical world safely and confidently. By converting live visual environments into highly structured, directional verbal alerts, SAHAAI behaves as a smart companion that understands surroundings, filters noise, and acts instantly during emergencies.

---

## 🚀 Key Features

* **🎙️ Voice-First Continuous Interaction**: Automatic continuous microphone listening loop that adjusts itself around spoken synthesis to prevent echo feedback loops.
* **⚡ Low-Latency Visual Processing**: Live frame stream ingestion running at 150ms intervals using an optimized YOLOv8 ONNX model for real-time person, table, chair, bottle, computer, and screen classifications.
* **📱 Selfie Camera Mirror Correction**: Auto-detects user-facing webcams and dynamically flips warning directions (`left` ➔ `right`) and 2D canvas radar markers to correct front-facing coordinate mirroring.
* **📐 Phone Orientation Downwards Tilt Sensor**: Monitors the phone's pitch using the Device Orientation API. If tilted downwards (looking at the ground/floor instead of ahead), the app displays a warning overlay and verbally alerts the user to hold the phone upright.
* **💾 Offline-First Emergency Contacts**: Save up to 3 emergency contacts securely in client-side `localStorage`. Persists across reloads without database latency.
* **🚨 Parallel Geolocation SOS & Twilio SMS**: Pressing or speaking "Help me" triggers a 5-second countdown. On completion, it fetches GPS coordinates in parallel and logs the event to Supabase, while triggering the Twilio REST API to dispatch a live Google Maps tracking link (`https://maps.google.com/?q=lat,lon`) to all contacts.
* **🔊 Sound Hazard Smart Trigger**: Automatically triggers a directional visual scan when backend sound decoders identify sirens, alarms, or horns.

---

## 🛠️ Technologies Used

### Frontend (PWA)
* **Markup & Styling**: HTML5, Tailwind CSS, Responsive Design layouts.
* **Web APIs**: Web Speech API (`SpeechRecognition` & `SpeechSynthesis`), Geolocation API, Device Orientation API.
* **Networking**: WebSockets for low-latency binary image stream uploads.

### Backend (FastAPI)
* **Framework**: FastAPI (Asynchronous endpoints and WebSockets), Uvicorn.
* **Vision & AI**: OpenCV, NumPy, ONNX Runtime (highly optimized CPU model execution).
* **Alerts & Integrations**: Twilio SMS REST API client, Supabase python client.

---

## 📂 Codebase Structure & File Descriptions

```text
SAHAAI/
│
├── backend/
│   └── app/
│       ├── main.py        # FastAPI server entrypoint hosting WebSockets stream ingestion & APIs
│       ├── database.py    # Database connection manager logging events and triggering Twilio SMS
│       ├── vision.py      # Vision processing pipeline managing YOLOv8-ONNX inference and contour gating
│       └── hazard.py      # Spatial hazard assessment logic computing severity and motion direction
│
├── frontend/
│   ├── index.html         # Main PWA responsive user interface layout with custom SVG integrations
│   ├── app.js             # Core client framework managing WebSockets, Web Speech, and localStorage state
│   ├── favicon.svg        # Official vector graphic icon of SAHAAI (emerald eye, safety shield, sound waves)
│   └── manifest.json      # Progressive Web App (PWA) manifest detailing icons and configurations
│
├── yolov8n.onnx           # YOLOv8 nano model weights downloaded on startup
├── .env                   # (Gitignored) Local configuration file containing API keys and endpoints
└── README.md              # Project documentation, repository architecture, and setup guides
```

---

## ⚙️ Setup & Installation Instructions

### 1. Prerequisites
Ensure you have the following installed on your machine:
* Python 3.10 or higher
* Git

### 2. Clone the Repository
Open your terminal and clone the project:
```cmd
git clone https://github.com/hanshal14/SAHAAI.git
cd SAHAAI
```

### 3. Configure Environment Variables
Create a file named `.env` in the root of the project directory and insert your credentials:
```text
# Supabase Database Configuration
SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_KEY=your-supabase-anon-key

# Twilio SMS Configuration
TWILIO_ACCOUNT_SID=your-account-sid
TWILIO_AUTH_TOKEN=your-auth-token
TWILIO_PHONE_NUMBER=your-assigned-twilio-number
```

### 4. Install Dependencies
Install the required python packages:
```cmd
pip install fastapi uvicorn opencv-python numpy onnxruntime supabase python-dotenv requests
```

### 5. Running the Application
Run the FastAPI server using Uvicorn:
```cmd
uvicorn backend.app.main:app --host 0.0.0.0 --port 8000
```
* **Self-Healing Model Download**: On startup, the server automatically checks if the `yolov8n.onnx` file exists. If it's missing or incomplete, it will download the unquantized official model weights automatically.

### 6. Testing the App
* **Localhost**: Open `http://localhost:8000/frontend/index.html` in your browser.
* **Mobile / Phone Testing**: Access the PWA over your local Wi-Fi network using your computer's IP address (e.g. `http://192.168.1.15:8000/frontend/index.html`).
* **Note for Geolocation & Camera**: Browsers restrict Camera and GPS access to secure contexts (`https://` or `localhost`). For mobile network testing, you can use a tunneling tool (like `ngrok`) or configure chrome flags (`unsafely-treat-insecure-origin-as-secure`) to grant permissions on local IP addresses.
