import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const app = express();
const server = http.createServer(app);
const allowedOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json());

// Inject Socket.io into requests so controllers can emit
app.use((req, res, next) => {
  req.io = io;
  next();
});
// Database connection
const connectDB = async () => {
  try {
    if (process.env.MONGO_URI) {
      await mongoose.connect(process.env.MONGO_URI);
      console.log('MongoDB Connected');
    } else {
      console.log('No MONGO_URI provided. Running without database for now.');
    }
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
};
connectDB();

import eventRoutes from './routes/eventRoutes.js';
import authRoutes from './routes/authRoutes.js';


// Basic API routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'SyncSphere API is running' });
});

app.use('/api/events', eventRoutes);
app.use('/api/auth', authRoutes);


// In-memory presence tracking
const activeUsers = new Map(); // socketId -> { userId, name, activity }

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  socket.on('add_task', (data) => {
    socket.to(data.workspaceId).emit('task_added', data.task);
  });

  socket.on('toggle_task', (data) => {
    socket.to(data.workspaceId).emit('task_toggled', data.taskId);
  });

  socket.on('delete_task', (data) => {
    socket.to(data.workspaceId).emit('task_deleted', data.taskId);
  });

  socket.on('user_joined', (userData) => {

    activeUsers.set(socket.id, {
      userId: userData.id,
      name: userData.name,
      activity: 'Browsing Dashboard'
    });
    // Broadcast to everyone that presence changed
    io.emit('presence_update', Array.from(activeUsers.values()));
  });

  socket.on('update_activity', (activity) => {
    const user = activeUsers.get(socket.id);
    if (user) {
      user.activity = activity;
      io.emit('presence_update', Array.from(activeUsers.values()));
    }
  });

  socket.on('ping_user', (data) => {
    // data: { targetUserId, fromName }
    // Since we don't have a reliable mapping to user ID yet (many sockets could be same user), 
    // for this demo we'll broadcast the ping if the target user ID matches.
    // In a production app, we'd map userId to socketId(s).
    io.emit('user_pinged', data);
  });

  socket.on('join_workspace', (workspaceId) => {
    socket.join(workspaceId);
    
    // Update user's current room
    const user = activeUsers.get(socket.id);
    if (user) {
      user.currentRoom = workspaceId;
      user.activity = 'In Workspace';
      
      // Get all users in this specifically joined room
      const roomUsers = Array.from(activeUsers.values())
        .filter(u => u.currentRoom === workspaceId);
      
      io.to(workspaceId).emit('room_users', roomUsers);
    }
    
    console.log(`Socket ${socket.id} joined workspace ${workspaceId}`);
  });


  socket.on('send_message', (data) => {
    socket.to(data.workspaceId).emit('receive_message', data.message);
  });

  socket.on('update_notes', (data) => {
    socket.to(data.workspaceId).emit('notes_updated', data.notes);
  });

  socket.on('start_typing', (data) => {
    socket.to(data.workspaceId).emit('user_typing', {
      user: data.user,
      eventId: data.eventId
    });
  });

  socket.on('stop_typing', (data) => {
    socket.to(data.workspaceId).emit('user_stopped_typing', {
      user: data.user,
      eventId: data.eventId
    });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const user = activeUsers.get(socket.id);
    const roomToNotify = user?.currentRoom;
    activeUsers.delete(socket.id);
    
    // Broadcast general presence update
    io.emit('presence_update', Array.from(activeUsers.values()));
    
    // Notify room participants if user was in a workspace
    if (roomToNotify) {
      const roomUsers = Array.from(activeUsers.values())
        .filter(u => u.currentRoom === roomToNotify);
      io.to(roomToNotify).emit('room_users', roomUsers);
    }
  });

});


const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
