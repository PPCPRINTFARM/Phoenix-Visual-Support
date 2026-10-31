// Retell AI voice agent bridge.
//
// The customer page starts a Retell web call tied to a visual support session.
// Retell then calls the custom tools below while it talks to the customer:
//   look_at_camera  - grab a frame from the customer's camera and describe it with Google Gemini
//   show_visual     - put a diagram, video or link on the customer's screen
//   clear_visual    - take it down again
const fs = require('fs');
const path = require('path');
const { timingSafeEqual } = require('crypto');
const { Retell } = require('retell-sdk');

const FRAME_TIMEOUT_MS = 6000;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const LIBRARY_PATH = path.join(__dirname, 'media-library.json');

const VISION_PROMPT = `You are the eyes of a Phoenix Phase Converters support agent on a live call.
You are looking at a single frame from the customer's phone camera.
Describe only what is actually visible that matters for troubleshooting rotary or static phase
converters, motors, wiring, breakers, disconnects, nameplates and control panels.
Read out any visible labels, model numbers, nameplate values, indicator lights or meter readings exactly.
Point out anything that looks unsafe (exposed conductors, burn marks, loose wires, water).
If the image is blurry, too dark, or the equipment is not in view, say so and say what the
customer should do to get a better view. Answer in 2-5 short sentences of plain spoken English
with no markdown, because the answer will be read aloud.`;

function loadMediaLibrary(file = LIBRARY_PATH) {
  try {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(items) ? items.filter((m) => m && m.id && m.url) : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read media library:', err.message);
    return [];
  }
}

function allowedHosts() {
  return (process.env.MEDIA_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(url, hosts) {
  const host = url.hostname === 'youtu.be' ? 'youtube.com' : url.hostname;
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function mediaKind(url, requested) {
  if (['image', 'video', 'link'].includes(requested)) return requested;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(url.pathname)) return 'image';
  if (/\.(mp4|webm|mov)$/i.test(url.pathname) || youtubeId(url)) return 'video';
  return 'link';
}

function youtubeId(url) {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
  if (/(^|\.)youtube\.com$/.test(url.hostname)) {
    if (url.pathname === '/watch') return url.searchParams.get('v');
    const m = url.pathname.match(/^\/(embed|shorts)\/([\w-]+)/);
    if (m) return m[2];
  }
  return null;
}

// Gemini (Google AI Studio API key) multimodal description of one JPEG frame.
async function describeWithGemini(jpegBase64, question) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: VISION_PROMPT }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: jpegBase64 } },
            { text: question || 'What do you see? Describe anything relevant to the problem.' }
          ]
        }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
      }),
      signal: AbortSignal.timeout(15000)
    }
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${body.error?.message || 'request failed'}`);
  const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no description');
  return text;
}

function attachAssistant({ app, io, activeSession, options = {} }) {
  // `options` overrides are read per request so tests can swap in fakes.
  const describeImage = (...a) => (options.describeImage || describeWithGemini)(...a);
  const verifySignature = (raw, sig) => options.verifySignature
    ? options.verifySignature(raw, sig)
    : !!(process.env.RETELL_API_KEY && sig) && Retell.verify(raw, process.env.RETELL_API_KEY, sig);
  const createWebCall = (body) => options.createWebCall
    ? options.createWebCall(body)
    : new Retell({ apiKey: process.env.RETELL_API_KEY }).call.createWebCall(body);
  const library = () => options.mediaLibrary || loadMediaLibrary();

  // Retell call_id -> visual support session id. Only calls this server created can act on a session.
  const calls = new Map();

  function sessionForCall(callId) {
    const sessionId = callId && calls.get(callId);
    const session = sessionId && activeSession(sessionId);
    if (!session) {
      if (sessionId) calls.delete(callId);
      return null;
    }
    return { sessionId, session };
  }

  function customerSocket(session) {
    return session.customerConnected && io.sockets.sockets.get(session.customerSocketId);
  }

  function activity(sessionId, text) {
    io.to(sessionId).emit('ai-activity', { text });
  }

  const configured = () => !!process.env.RETELL_AGENT_ID && (!!options.createWebCall || !!process.env.RETELL_API_KEY);

  app.get('/api/retell/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: configured() });
  });

  // Customer page asks for a Retell web call for its session.
  app.post('/api/retell/web-call', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { sessionId } = req.body || {};
    const session = typeof sessionId === 'string' && activeSession(sessionId);
    if (!session || !session.customerConnected) {
      return res.status(404).json({ error: 'Session not found or customer not connected.' });
    }
    if (!configured()) {
      return res.status(503).json({ error: 'The AI assistant is not configured.' });
    }
    try {
      const media = library().map((m) => `${m.id}: ${m.title || m.id}`).join('\n');
      const call = await createWebCall({
        agent_id: process.env.RETELL_AGENT_ID,
        metadata: { visual_session_id: sessionId },
        retell_llm_dynamic_variables: {
          visual_session_id: sessionId,
          media_catalog: media || 'No saved diagrams or videos yet.'
        }
      });
      if (session.retellCallId) calls.delete(session.retellCallId);
      session.retellCallId = call.call_id;
      calls.set(call.call_id, sessionId);
      activity(sessionId, 'AI assistant call started');
      res.json({ accessToken: call.access_token, callId: call.call_id });
    } catch (err) {
      console.error('Retell create-web-call failed:', err.message);
      res.status(502).json({ error: 'Could not start the AI assistant.' });
    }
  });

  // Every tool request must be signed by Retell (x-retell-signature) or carry the shared secret header.
  async function retellAuth(req, res, next) {
    const secret = process.env.RETELL_TOOL_SECRET;
    const supplied = req.get('x-phoenix-tool-secret');
    if (secret && supplied && supplied.length === secret.length &&
        timingSafeEqual(Buffer.from(supplied), Buffer.from(secret))) {
      return next();
    }
    try {
      if (await verifySignature(req.rawBody || '', req.get('x-retell-signature'))) return next();
    } catch (err) {
      console.error('Retell signature check failed:', err.message);
    }
    res.status(401).json({ error: 'unauthorized' });
  }

  function toolHandler(fn) {
    return async (req, res) => {
      const body = req.body || {};
      const match = sessionForCall(body.call?.call_id);
      if (!match) {
        return res.json({ result: 'This call is not linked to an active visual support session. Ask the customer to open their support link and tap the assistant button on that page.' });
      }
      try {
        res.json({ result: await fn(body.args || {}, match) });
      } catch (err) {
        console.error(`Retell tool ${req.path} failed:`, err.message);
        res.json({ result: `That did not work: ${err.message}` });
      }
    };
  }

  app.post('/api/retell/tools/look', retellAuth, toolHandler(async (args, { sessionId, session }) => {
    const customer = customerSocket(session);
    if (!customer) return 'The customer camera is not connected right now. Ask them to reopen the support link.';
    let frame;
    try {
      frame = await customer.timeout(FRAME_TIMEOUT_MS).emitWithAck('ai-capture-frame');
    } catch {
      return 'The camera did not respond in time. Ask the customer to keep the support page open and try again.';
    }
    const match = typeof frame?.data === 'string' && frame.data.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1].length > MAX_FRAME_BYTES * 4 / 3) {
      return 'No usable camera image came back. Ask the customer to point the camera at the equipment.';
    }
    const question = typeof args.question === 'string' ? args.question.slice(0, 500) : '';
    activity(sessionId, `AI looked at the camera${question ? `: "${question}"` : ''}`);
    const description = await describeImage(match[1], question);
    activity(sessionId, `AI saw: ${description}`);
    return description;
  }));

  app.post('/api/retell/tools/show', retellAuth, toolHandler(async (args, { sessionId, session }) => {
    let item;
    if (args.media_id) {
      item = library().find((m) => m.id === args.media_id);
      if (!item) return `There is no saved media called ${args.media_id}. Available: ${library().map((m) => m.id).join(', ') || 'none'}.`;
    } else if (typeof args.url === 'string') {
      item = { url: args.url, title: args.title, caption: args.caption, type: args.type };
    } else {
      return 'Give either media_id from the catalog or a url.';
    }

    let url;
    try { url = new URL(item.url); } catch { return 'That URL is not valid.'; }
    if (url.protocol !== 'https:') return 'Only https links can be shown.';
    if (!args.media_id && !hostAllowed(url, allowedHosts())) {
      return 'That website is not on the approved list. Use an item from the media catalog instead.';
    }
    if (!customerSocket(session)) return 'The customer page is not connected right now.';

    const kind = mediaKind(url, item.type);
    const yt = kind === 'video' ? youtubeId(url) : null;
    const payload = {
      kind,
      url: url.href,
      embedUrl: yt ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}?autoplay=1&playsinline=1` : null,
      title: String(item.title || args.title || '').slice(0, 120),
      caption: String(args.caption || item.caption || '').slice(0, 500)
    };
    io.to(sessionId).emit('show-media', payload);
    activity(sessionId, `AI showed the customer ${kind === 'link' ? 'a link' : `a ${kind}`}: ${payload.title || payload.url}`);
    return `Now showing ${payload.title || 'it'} on the customer's screen. Tell them what to look at.`;
  }));

  app.post('/api/retell/tools/clear', retellAuth, toolHandler(async (args, { sessionId }) => {
    io.to(sessionId).emit('hide-media');
    return 'Cleared the customer screen. The live camera is visible again.';
  }));

  return { calls };
}

module.exports = { attachAssistant, describeWithGemini, loadMediaLibrary, youtubeId };
