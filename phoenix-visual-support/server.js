const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Store active sessions
const sessions = new Map();

// Technician dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'technician.html'));
});

// Create a new session and get a customer link
app.get('/api/create-session', (req, res) => {
  const sessionId = uuidv4().slice(0, 8);
  sessions.set(sessionId, {
    created: Date.now(),
    technicianConnected: false,
    customerConnected: false
  });
  res.json({ sessionId, link: `/join/${sessionId}` });
});

// Customer join page
app.get('/join/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  if (!sessions.has(sessionId)) {
    return res.status(404).send('Session not found or expired.');
  }
  res.sendFile(path.join(__dirname, 'public', 'customer.html'));
});

// WebRTC Signaling
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('join-session', ({ sessionId, role }) => {
    socket.join(sessionId);
    socket.sessionId = sessionId;
    socket.role = role;

    const session = sessions.get(sessionId);
    if (session) {
      if (role === 'technician') {
        session.technicianConnected = true;
        session.technicianSocketId = socket.id;
      } else {
        session.customerConnected = true;
        session.customerSocketId = socket.id;
      }
    }

    // Notify the other party
    socket.to(sessionId).emit('peer-joined', { role });
    console.log(`${role} joined session ${sessionId}`);
  });

  socket.on('offer', ({ sessionId, offer }) => {
    socket.to(sessionId).emit('offer', { offer });
  });

  socket.on('answer', ({ sessionId, answer }) => {
    socket.to(sessionId).emit('answer', { answer });
  });

  socket.on('ice-candidate', ({ sessionId, candidate }) => {
    socket.to(sessionId).emit('ice-candidate', { candidate });
  });

  // Pointer/annotation events from technician to customer
  socket.on('pointer-move', ({ sessionId, x, y }) => {
    socket.to(sessionId).emit('pointer-move', { x, y });
  });

  socket.on('pointer-show', ({ sessionId }) => {
    socket.to(sessionId).emit('pointer-show');
  });

  socket.on('pointer-hide', ({ sessionId }) => {
    socket.to(sessionId).emit('pointer-hide');
  });

  // Drawing annotations
  socket.on('draw-start', ({ sessionId, x, y, color }) => {
    socket.to(sessionId).emit('draw-start', { x, y, color });
  });

  socket.on('draw-move', ({ sessionId, x, y }) => {
    socket.to(sessionId).emit('draw-move', { x, y });
  });

  socket.on('draw-end', ({ sessionId }) => {
    socket.to(sessionId).emit('draw-end');
  });

  socket.on('clear-annotations', ({ sessionId }) => {
    socket.to(sessionId).emit('clear-annotations');
  });

  // Freeze frame
  socket.on('freeze-frame', ({ sessionId }) => {
    socket.to(sessionId).emit('freeze-frame');
  });

  socket.on('unfreeze-frame', ({ sessionId }) => {
    socket.to(sessionId).emit('unfreeze-frame');
  });

  // Camera switch
  socket.on('switch-camera', ({ sessionId }) => {
    socket.to(sessionId).emit('switch-camera');
  });

  // Screenshot
  socket.on('take-screenshot', ({ sessionId }) => {
    socket.to(sessionId).emit('take-screenshot');
  });

  socket.on('screenshot-data', ({ sessionId, data }) => {
    socket.to(sessionId).emit('screenshot-data', { data });
  });

  // Chat
  socket.on('chat-message', ({ sessionId, message, sender }) => {
    socket.to(sessionId).emit('chat-message', { message, sender });
  });

  socket.on('disconnect', () => {
    if (socket.sessionId) {
      socket.to(socket.sessionId).emit('peer-disconnected', { role: socket.role });
      const session = sessions.get(socket.sessionId);
      if (session) {
        if (socket.role === 'technician') session.technicianConnected = false;
        else session.customerConnected = false;
        if (!session.technicianConnected && !session.customerConnected) {
          sessions.delete(socket.sessionId);
        }
      }
    }
    console.log('Socket disconnected:', socket.id);
  });
});

// Cleanup old sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.created > 3600000) { // 1 hour
      sessions.delete(id);
    }
  }
}, 1800000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Phoenix Visual Support running on port ${PORT}`);
});
