# Phoenix Visual Support

A TechSee-style remote visual support tool for Phoenix Phase Converters. Send customers a link, view their phone camera in real-time, and guide them with a laser pointer and annotations.

## Features

- **Live Camera Streaming** — WebRTC peer-to-peer video from customer's phone
- **Laser Pointer** — Red dot shows on customer's screen where you're pointing
- **Draw Annotations** — Circle parts, draw arrows, highlight issues (5 colors)
- **Freeze Frame** — Pause the video to annotate a specific moment
- **Screenshots** — Capture and save annotated frames for records
- **Flip Camera** — Switch between front/rear camera remotely
- **Live Chat** — Text chat alongside video
- **SMS Link Sender** — Quick-send the session link via SMS
- **No App Install** — Customer just taps a link in their mobile browser
- **AI Voice Assistant (Retell)** — Talking orb on the customer page; the agent can look through the customer's camera (Google Gemini vision) and put diagrams, videos and links on their screen

## How It Works

1. **Technician** opens the dashboard at your deployed URL
2. Click **"New Support Session"** — generates a unique link
3. **Copy or SMS** the link to the customer
4. **Customer** taps the link → allows camera access → stream begins
5. Use **Pointer**, **Draw**, **Freeze**, **Screenshot** tools to guide them

## AI Voice Assistant (Retell + Google Gemini vision)

The customer page has a talking orb. When the customer taps it, the server starts a
[Retell](https://www.retellai.com) web call linked to that visual support session. While
talking, the Retell agent can call three tools on this server:

| Tool | What it does |
|------|--------------|
| `look_at_camera` | Grabs one still frame from the customer's camera, sends it to Google Gemini with the agent's question, and returns the description for the agent to speak. The customer sees an amber flash while the AI looks. |
| `show_visual` | Puts a diagram, image, video (MP4 or YouTube) or link on the customer's screen over the camera view. |
| `clear_visual` | Removes it again. |

Everything the AI looks at, sees and shows appears in the technician's chat panel (🤖), so a
person can follow along and take over.

### Setup

1. **Google:** create an API key in [Google AI Studio](https://aistudio.google.com/apikey) → `GEMINI_API_KEY`.
2. **Retell:** in the Retell dashboard, open your agent (the same one behind your orb) and:
   - Add the three custom tools from [`retell-tools.json`](retell-tools.json). Replace
     `YOUR-APP.onrender.com` with your deployed URL and the header value with your `RETELL_TOOL_SECRET`.
   - Add something like this to the agent prompt:
     > You can see the customer's equipment through their phone camera with `look_at_camera`.
     > Before guessing, ask them to point the camera at the part and look. Use `show_visual`
     > to show wiring diagrams or videos from this catalog: {{media_catalog}}
   - Copy the agent ID → `RETELL_AGENT_ID`, and your API key → `RETELL_API_KEY`.
3. Set the environment variables on Render (they are listed in `render.yaml`):

| Variable | Purpose |
|----------|---------|
| `RETELL_API_KEY` | Creates web calls and verifies Retell's `x-retell-signature` on tool requests |
| `RETELL_AGENT_ID` | The Retell agent the orb talks to |
| `RETELL_TOOL_SECRET` | Shared secret Retell sends in the `x-phoenix-tool-secret` header |
| `GEMINI_API_KEY` | Google Gemini key for camera vision |
| `GEMINI_MODEL` | Optional, defaults to `gemini-2.5-flash` |
| `MEDIA_ALLOWED_HOSTS` | Comma-separated sites the agent may show by URL (e.g. `phoenixphaseconverters.com,youtube.com`) |

The orb only appears when `RETELL_AGENT_ID` and `RETELL_API_KEY` are set.

### Media catalog

Put the diagrams and videos you want the agent to use in `media-library.json`. The agent gets
the list as the `{{media_catalog}}` dynamic variable and shows items by `id`, which is safer
than letting it make up URLs:

```json
[
  {
    "id": "rpc-wiring",
    "title": "Rotary phase converter wiring",
    "caption": "Incoming L1 and L2 land on the top two lugs",
    "url": "https://phoenixphaseconverters.com/diagrams/rpc-wiring.png"
  },
  {
    "id": "startup-video",
    "title": "How to start your converter",
    "url": "https://www.youtube.com/watch?v=VIDEO_ID"
  }
]
```

### Security

- Tool requests are accepted only with a valid Retell signature or the shared secret header.
- A tool call can only reach the session whose page started that Retell call, using the `call_id` this server created.
- The AI sees single frames, only when it asks, and the customer sees each one taken.

## Deployment on Render

1. Push this repo to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com)
3. Click **New > Web Service**
4. Connect your GitHub repo
5. Settings will auto-detect from `render.yaml`:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
6. Deploy!

**Important:** WebRTC requires HTTPS. Render provides this automatically.

## Local Development

```bash
npm install
node server.js
# Open http://localhost:3000
```

For local testing with a phone, use ngrok:
```bash
ngrok http 3000
```

## Tech Stack

- **Node.js + Express** — Server
- **Socket.IO** — WebRTC signaling + real-time events
- **WebRTC** — Peer-to-peer video streaming
- **Vanilla HTML/CSS/JS** — No framework dependencies

## File Structure

```
phoenix-visual-support/
├── server.js              # Express + Socket.IO signaling server
├── ai-assistant.js        # Retell web calls + look/show/clear tools (Gemini vision)
├── media-library.json     # Diagrams/videos the AI may show
├── retell-tools.json      # Tool definitions to paste into the Retell agent
├── package.json
├── render.yaml            # Render deployment config
└── public/
    ├── technician.html    # Your dashboard (pointer, draw, freeze, chat)
    └── customer.html      # Customer's mobile page (camera + annotations)
```

## Notes

- Sessions auto-expire after 1 hour
- Uses Google STUN servers for NAT traversal
- For production with firewalls, consider adding a TURN server (e.g., Twilio TURN or Metered.ca)
- All video is peer-to-peer — never touches your server
