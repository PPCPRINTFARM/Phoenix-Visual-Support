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

## How It Works

1. **Technician** opens the dashboard at your deployed URL
2. Click **"New Support Session"** — generates a unique link
3. **Copy or SMS** the link to the customer
4. **Customer** taps the link → allows camera access → stream begins
5. Use **Pointer**, **Draw**, **Freeze**, **Screenshot** tools to guide them

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
