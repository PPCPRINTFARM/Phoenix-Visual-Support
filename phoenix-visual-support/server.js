const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID, randomBytes, timingSafeEqual } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

function activeSession(id) {
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.created >= SESSION_TTL_MS) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function validTechnicianToken(session, supplied) {
  if (!session || typeof supplied !== 'string') return false;
  const expected = Buffer.from(session.technicianToken);
  const received = Buffer.from(supplied);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

// Technician dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'technician.html'));
});

// Create a new session and get a customer link
app.get('/api/create-session', (req, res) => {
  const sessionId = randomUUID();
  const technicianToken = randomBytes(24).toString('base64url');
  sessions.set(sessionId, {
    created: Date.now(),
    technicianToken,
    technicianConnected: false,
    customerConnected: false
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    sessionId,
    link: `/join/${sessionId}`,
    technicianUrl: `/?session=${sessionId}#techToken=${technicianToken}`,
    technicianToken
  });
});

// Customer join page
app.get('/join/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!activeSession(sessionId)) {
    return res.status(404).send('Session not found or expired.');
  }
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

// WebRTC Signaling
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  const joined = (sessionId, role) =>
    socket.sessionId === sessionId &&
    !!activeSession(sessionId) &&
    (!role || socket.role === role);

  socket.on('join-session', ({ sessionId, role, technicianToken }) => {
    const session = activeSession(sessionId);
    if (!session || !['technician', 'customer'].includes(role) ||
        (role === 'technician' && !validTechnicianToken(session, technicianToken))) {
      socket.emit('join-error', { message: 'Session unavailable or access denied.' });
      return;
    }
    if (socket.sessionId) {
      socket.emit('join-error', { message: 'Already joined a session.' });
      return;
    }
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role = role;

    if (role === 'technician') {
      session.technicianConnected = true;
      session.technicianSocketId = socket.id;
    } else {
      session.customerConnected = true;
      session.customerSocketId = socket.id;
    }

    socket.emit('session-joined', { sessionId, role });

    // Notify the other party
    socket.to(sessionId).emit('peer-joined', { role });
    console.log(`${role} joined session ${sessionId}`);
  });

  socket.on('offer', ({ sessionId, offer }) => {
    if (!joined(sessionId)) return;
    socket.to(sessionId).emit('offer', { offer });
  });

  socket.on('answer', ({ sessionId, answer }) => {
    if (!joined(sessionId)) return;
    socket.to(sessionId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ sessionId, candidate }) => {
    if (!joined(sessionId)) return;
    socket.to(sessionId).emit('ice-candidate', { candidate });
  });

  // Pointer/annotation events from technician to customer
  socket.on('pointer-move', ({ sessionId, x, y }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('pointer-move', { x, y });
  });

  socket.on('pointer-show', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('pointer-show');
  });

  socket.on('pointer-hide', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('pointer-hide');
  });

  // Drawing annotations
  socket.on('draw-start', ({ sessionId, x, y, color }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('draw-start', { x, y, color });
  });

  socket.on('draw-move', ({ sessionId, x, y }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('draw-move', { x, y });
  });

  socket.on('draw-end', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('draw-end');
  });

  socket.on('clear-annotations', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('clear-annotations');
  });

  // Freeze frame
  socket.on('freeze-frame', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('freeze-frame');
  });

  socket.on('unfreeze-frame', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('unfreeze-frame');
  });

  // Camera switch
  socket.on('switch-camera', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('switch-camera');
  });

  // Screenshot
  socket.on('take-screenshot', ({ sessionId }) => {
    if (!joined(sessionId, 'technician')) return;
    socket.to(sessionId).emit('take-screenshot');
  });

  socket.on('screenshot-data', ({ sessionId, data }) => {
    if (!joined(sessionId, 'customer')) return;
    socket.to(sessionId).emit('screenshot-data', { data });
  });

  // Chat
  socket.on('chat-message', ({ sessionId, message, sender }) => {
    if (!joined(sessionId) || typeof message !== 'string') return;
    socket.to(sessionId).emit('chat-message', { message: message.slice(0, 2000), sender: socket.role });
  });

  socket.on('disconnect', () => {
    if (socket.sessionId) {
      socket.to(socket.sessionId).emit('peer-disconnected', { role: socket.role });
      const session = activeSession(socket.sessionId);
      if (session) {
        if (socket.role === 'technician' && session.technicianSocketId === socket.id) session.technicianConnected = false;
        if (socket.role === 'customer' && session.customerSocketId === socket.id) session.customerConnected = false;
      }
    }
    console.log('Socket disconnected:', socket.id);
  });
});

// Cleanup old sessions every 30 minutes
const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}, 1800000);
cleanup.unref();

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Phoenix Visual Support running on port ${PORT}`);
  });
}

module.exports = { app, server };
