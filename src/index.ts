// src/index.ts
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const httpServer = createServer(app);

const corsOptions = {
  origin: "*",
  methods: ["GET", "POST"],
};

app.use(cors(corsOptions));
app.use(express.json());

// In-memory storage only - no database needed!
const onlineUsers = new Map<
  string,
  {
    userId: string;
    isOnline: boolean;
    lastSeen: Date;
    socketId: string;
    userInfo?: {
      name?: string;
      email?: string;
      image?: string;
    };
  }
>();

const typingUsers = new Map<string, Set<string>>(); // chatId -> userIds

// Health check
app.get("/health", (req, res) => {
  const onlineUsersArray = Array.from(onlineUsers.entries())
    .filter(([_, status]) => status.isOnline)
    .map(([userId, status]) => ({
      userId,
      isOnline: status.isOnline,
      lastSeen: status.lastSeen,
      userInfo: status.userInfo,
    }));

  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    onlineUsers: onlineUsersArray,
    totalOnline: onlineUsersArray.length,
  });
});

// Get user status
app.get("/users/:userId/status", (req, res) => {
  const { userId } = req.params;
  const status = onlineUsers.get(userId);

  if (!status) {
    return res.json({
      isOnline: false,
      lastSeen: new Date(),
    });
  }

  res.json(status);
});

// Get all online users
app.get("/users/online", (req, res) => {
  const onlineUsersArray = Array.from(onlineUsers.entries())
    .filter(([_, status]) => status.isOnline)
    .map(([userId, status]) => ({
      userId,
      isOnline: status.isOnline,
      lastSeen: status.lastSeen,
      userInfo: status.userInfo,
    }));

  res.json(onlineUsersArray);
});

// Socket.IO setup
const io = new Server(httpServer, {
  cors: corsOptions,
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // User goes online
  socket.on("user_online", (data: { userId: string; userInfo?: any }) => {
    handleUserOnline(socket, data.userId, data.userInfo);
  });

  // Join/leave chat rooms
  socket.on("join_chat", (chatId: string) => {
    socket.join(chatId);
    console.log(`User ${socket.id} joined chat: ${chatId}`);
  });

  socket.on("leave_chat", (chatId: string) => {
    socket.leave(chatId);
    console.log(`User ${socket.id} left chat: ${chatId}`);
  });

  // Typing events - FIXED: Added user_typing event
  socket.on(
    "user_typing",
    (data: { chatId: string; userId: string; isTyping: boolean }) => {
      if (data.isTyping) {
        handleTypingStart(socket, data.chatId, data.userId);
      } else {
        handleTypingStop(socket, data.chatId, data.userId);
      }
    }
  );

  socket.on("typing_start", (data: { chatId: string; userId: string }) => {
    handleTypingStart(socket, data.chatId, data.userId);
  });

  socket.on("typing_stop", (data: { chatId: string; userId: string }) => {
    handleTypingStop(socket, data.chatId, data.userId);
  });

  // Send message event
  socket.on("send_message", (data: { chatId: string; message: any }) => {
    // Broadcast the message to all users in the chat room except the sender
    socket.to(data.chatId).emit("receive_message", data.message);
    console.log(
      `Message sent in chat ${data.chatId} by user ${data.message.senderId}`
    );
  });

  // Handle disconnect
  socket.on("disconnect", () => {
    handleUserDisconnect(socket);
  });

  // Handle connection errors
  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
});

// Event handlers
function handleUserOnline(socket: any, userId: string, userInfo?: any) {
  onlineUsers.set(userId, {
    userId,
    isOnline: true,
    lastSeen: new Date(),
    socketId: socket.id,
    userInfo,
  });

  // Join user to their personal room
  socket.join(`user_${userId}`);

  // Send current online users list to the newly connected user
  const currentOnlineUsers = Array.from(onlineUsers.entries())
    .filter(([id, status]) => status.isOnline && id !== userId) // Exclude self
    .map(([id, status]) => ({
      userId: id,
      isOnline: true,
      lastSeen: status.lastSeen,
      userInfo: status.userInfo,
    }));

  // Send online users list to the newly connected user
  socket.emit("online_users_list", currentOnlineUsers);

  // Broadcast online status to all connected clients
  io.emit("user_status_changed", {
    userId,
    isOnline: true,
    lastSeen: new Date(),
    userInfo,
  });

  console.log(
    `User ${userId} is now online. Online users: ${
      Array.from(onlineUsers.values()).filter((u) => u.isOnline).length
    }`
  );
}

function handleUserDisconnect(socket: any) {
  const userEntry = Array.from(onlineUsers.entries()).find(
    ([_, status]) => status.socketId === socket.id
  );

  if (userEntry) {
    const [userId, userStatus] = userEntry;

    onlineUsers.set(userId, {
      ...userStatus,
      isOnline: false,
      lastSeen: new Date(),
    });

    // Clean up typing status
    typingUsers.forEach((users, chatId) => {
      if (users.has(userId)) {
        users.delete(userId);
        io.to(chatId).emit("user_stop_typing", {
          chatId,
          userId,
          typingUsers: Array.from(users),
        });
      }
    });

    // Broadcast offline status to all connected clients
    io.emit("user_status_changed", {
      userId,
      isOnline: false,
      lastSeen: new Date(),
    });

    console.log(
      `User ${userId} disconnected. Online users: ${
        Array.from(onlineUsers.values()).filter((u) => u.isOnline).length
      }`
    );
  }
}

function handleTypingStart(socket: any, chatId: string, userId: string) {
  if (!typingUsers.has(chatId)) {
    typingUsers.set(chatId, new Set());
  }

  const users = typingUsers.get(chatId)!;
  users.add(userId);

  // Broadcast to all users in the chat room except the sender
  socket.to(chatId).emit("user_typing", {
    chatId,
    userId,
    isTyping: true,
    typingUsers: Array.from(users),
  });

  console.log(`User ${userId} started typing in chat ${chatId}`);
}

function handleTypingStop(socket: any, chatId: string, userId: string) {
  const users = typingUsers.get(chatId);
  if (users && users.has(userId)) {
    users.delete(userId);

    // Broadcast to all users in the chat room
    io.to(chatId).emit("user_stop_typing", {
      chatId,
      userId,
      isTyping: false,
      typingUsers: Array.from(users),
    });

    console.log(`User ${userId} stopped typing in chat ${chatId}`);
  }
}

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Socket server running on port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(
    `👥 Online users endpoint: http://localhost:${PORT}/users/online`
  );
});
