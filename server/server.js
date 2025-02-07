const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",  // 允許所有來源
        methods: ["GET", "POST"],
        credentials: true
    }
});
const multer = require('multer');
const path = require('path');
const dotenv = require('dotenv');
const cors = require('cors');
const fs = require('fs');
dotenv.config();

// 設置靜態文件目錄
app.use(cors());  // 允許所有跨域請求
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// 確保上傳目錄存在
const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置文件上傳
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
});

// 在線用戶列表
let publicUsers = new Map();  // 格式: socketId -> { id: number, user: string, type: 'public', chat_id: 'public' }
let privateUsers = new Map(); // 格式: socketId -> { id: number, user: string, type: 'private', chat_id: string }
let userIdCounter = 0;  // 用戶 ID 計數器
let userSockets = new Map();
let disconnectTimers = new Map();
let messageHistory = [];
let originalUsernames = new Map();
let joinMessages = new Set();  // 追踪已發送的加入消息
let rooms = new Map(); // 存儲房間信息
let roomUsers = new Map(); // 存儲每個房間的用戶
let roomMessages = new Map(); // 存儲每個房間的消息
let roomPasswords = new Map(); // 存儲房間密碼
let roomPassNeedIds = new Map(); // 存儲房間密碼需求標識

// 追踪斷開連接的計時器
const RECONNECT_TIMEOUT = 1000;

// 防止重複消息的超時時間
const MESSAGE_DEBOUNCE = 2000;

// 檢查並清理過期的用戶
function cleanupStaleUsers() {
    for (const [socketId, username] of publicUsers.entries()) {
        if (!io.sockets.sockets.has(socketId)) {
            cleanupUser(socketId);
        }
    }
}

// 清理舊的加入消息
function cleanupJoinMessages() {
    const now = Date.now();
    for (const message of joinMessages) {
        const [username, timestamp] = message.split('|');
        if (now - parseInt(timestamp) > MESSAGE_DEBOUNCE) {
            joinMessages.delete(message);
        }
    }
}

// 清理用戶
function cleanupUser(socketId) {
    const username = publicUsers.get(socketId);
    if (username) {
        // 檢查是否有其他相同用戶名的連接
        let hasOtherConnection = false;
        for (const [otherSocketId, otherUsername] of publicUsers.entries()) {
            if (otherSocketId !== socketId && otherUsername === username) {
                hasOtherConnection = true;
                break;
            }
        }

        // 只有在沒有其他連接時才發送離開消息
        if (!hasOtherConnection) {
            io.emit('message', {
                type: 'system',
                content: `${username} 離開了聊天室`,
                highlight: username,
                action: 'leave'
            });
        }

        userSockets.delete(username);
        publicUsers.delete(socketId);
        originalUsernames.delete(socketId);
        return username;
    }
    return null;
}

// 檢查用戶名是否可用
function isUsernameAvailable(username, currentSocketId) {
    for (const [socketId, name] of publicUsers.entries()) {
        if (name === username && socketId !== currentSocketId) {
            return false;
        }
    }
    return true;
}

// 存儲最近的消息
const MAX_HISTORY = 100; // 保存最近100條消息

// 檢查是否是私人房間
function isPrivateRoom(socket) {
  const query = socket.handshake.query;
  return query.chat_id && query.private === '1';
}

// Socket.IO 連接處理
io.on('connection', (socket) => {
    let currentRoom = null;
    const isPrivate = socket.handshake.query.private === '1';
    const roomId = socket.handshake.query.chat_id || 'public';
    const password = socket.handshake.query.pass;
    const passNeed = socket.handshake.query.pass_need;
    const creating = socket.handshake.query.creating;

    // 將用戶添加到對應的房間
    const addUserToRoom = (username) => {
        // 先檢查用戶是否已存在於任何房間
        const existingPublicUser = Array.from(publicUsers.values())
            .find(u => u.user === username);
        const existingPrivateUser = Array.from(privateUsers.values())
            .find(u => u.user === username);
        
        // 如果用戶已存在，先移除
        if (existingPublicUser) {
            const socketId = Array.from(publicUsers.entries())
                .find(([_, u]) => u.user === username)[0];
            publicUsers.delete(socketId);
        }
        if (existingPrivateUser) {
            const socketId = Array.from(privateUsers.entries())
                .find(([_, u]) => u.user === username)[0];
            privateUsers.delete(socketId);
        }

        if (currentRoom && currentRoom !== 'public') {
            const roomUsersList = roomUsers.get(currentRoom);
            if (roomUsersList) {
                roomUsersList.add(username);
                privateUsers.set(socket.id, {
                    id: ++userIdCounter,
                    user: username,
                    type: 'private',
                    chat_id: currentRoom
                });
                // 只發送給當前房間的用戶
                const roomUsers = Array.from(privateUsers.values())
                    .filter(u => u.chat_id === currentRoom);
                socket.emit('userList', roomUsers);
                io.to(currentRoom).emit('userList', roomUsers);
            }
        } else {
            publicUsers.set(socket.id, {
                id: ++userIdCounter,
                user: username,
                type: 'public',
                chat_id: 'public'
            });
            // 只發送給公共聊天室的用戶
            const publicRoomSockets = Array.from(publicUsers.keys());
            const publicUsersList = Array.from(publicUsers.values())
                .filter((user, index, self) => 
                    index === self.findIndex(u => u.user === user.user)
                );
            publicRoomSockets.forEach(socketId => {
                io.to(socketId).emit('userList', publicUsersList);
            });
        }
    };

    console.log('新連接:', {
        roomId,
        isPrivate,
        hasPassword: !!password,
        passNeed,
        creating,
        currentRoom
    });

    if (roomId !== 'public') {
        console.log('房間信息:', {
            room: rooms.get(roomId),
            storedPassword: roomPasswords.get(roomId),
            storedPassNeedId: roomPassNeedIds.get(roomId)
        });

        // 初始化房間用戶列表
        if (!roomUsers.has(roomId)) {
            roomUsers.set(roomId, new Set());
        }
        
        // 檢查房間和密碼
        const room = rooms.get(roomId);
        const storedPassword = roomPasswords.get(roomId);
        const storedPassNeedId = roomPassNeedIds.get(roomId);
        const creating = socket.handshake.query.creating === '1';
        
        console.log('驗證信息:', {
            creating,
            hasRoom: !!room,
            storedPassNeedId,
            hasPassword: !!password
        });

        // 檢查是否是創建新房間還是加入現有房間
        if (creating === '1') {
            // 如果是創建新房間，不需要密碼驗證
            currentRoom = roomId;
            socket.join(roomId);
        } else {
            // 如果是加入現有房間
            // 先檢查房間是否存在
            if (!room) {
                socket.emit('error', {
                    type: 'auth',
                    message: '房間不存在'
                });
                return;
            }
            
            // 如果房間需要密碼
            if (storedPassNeedId && storedPassNeedId !== 'false') {
                // 如果沒有提供密碼，發送需要密碼的信號
                if (!password) {
                    socket.emit('error', {
                        type: 'auth',
                        message: 'need_password'
                    });
                    return;
                }
                // 檢查密碼是否正確
                if (password !== storedPassword) {
                    socket.emit('error', {
                        type: 'auth',
                        message: '密碼錯誤'
                    });
                    return;
                }
            }
        }
        
        currentRoom = roomId;
        socket.join(roomId);
        
        // 如果是創建房間的用戶，立即發送一個空的用戶列表
        if (creating === '1') {
            socket.emit('userList', []);
        }
        
        // 請求用戶列表更新
        socket.emit('requestUserList');
    } else {
        // 加入公共聊天室
        currentRoom = 'public';
        socket.join('public');
        socket.emit('requestUserList');
    }

    // 發送連接確認
    socket.emit('connectionConfirmed', {
        room: currentRoom,
        isPrivate: isPrivate === '1'
    });

    console.log('用戶連接');

    // 清理過期的用戶
    cleanupStaleUsers();
    cleanupJoinMessages();

    // 處理用戶列表請求
    socket.on('requestUserList', () => {
        let users;
        if (currentRoom && currentRoom !== 'public') {
            // 只返回當前私人房間的用戶
            const roomUsersList = roomUsers.get(currentRoom);
            if (roomUsersList) {
                users = Array.from(privateUsers.values())
                    .filter(u => roomUsersList.has(u.user) && u.chat_id === currentRoom)
                    .map(({ id, user, type, chat_id }) => ({
                        id,
                        user,
                        type: 'private',
                        chat_id: currentRoom
                    }));
            } else {
                users = [];
            }
        } else {
            // 只返回公共聊天室的用戶
            users = Array.from(publicUsers.values())
                .filter(u => u.chat_id === 'public')
                .map(({ id, user, type, chat_id }) => ({ id, user, type, chat_id }));
        }

        // 根據房間類型發送用戶列表
        if (currentRoom && currentRoom !== 'public') {
            io.to(currentRoom).emit('userList', users);
        } else {
            socket.emit('userList', users);
        }
    });

    // 處理歷史消息請求
    socket.on('requestHistory', () => {
        if (currentRoom && currentRoom !== 'public') {
            socket.emit('chatHistory', roomMessages.get(currentRoom) || []);
        } else {
            socket.emit('chatHistory', messageHistory);
        }
    });

    // 用戶加入
    socket.on('join', (username) => {
        // 檢查用戶當前所在的房間
        const currentUserRoom = currentRoom !== 'public' ? 
            Array.from(privateUsers.values()).find(u => u.user === username)?.chat_id :
            Array.from(publicUsers.values()).find(u => u.user === username)?.chat_id;
        
        // 如果用戶已經在其他房間，不顯示加入消息
        if (currentUserRoom === currentRoom) {
            return;
        }

        // 檢查是否已經在當前房間
        const isInRoom = currentRoom !== 'public' ?
            Array.from(privateUsers.values()).some(u => u.user === username && u.chat_id === currentRoom) :
            Array.from(publicUsers.values()).some(u => u.user === username);
        
        if (isInRoom) {
            console.log('用戶已在房間中:', username);
            return;
        }

        // 添加用戶到對應的房間
        addUserToRoom(username);
        
        // 發送加入消息
        const message = {
            type: 'system',
            content: `${username} ${currentRoom !== 'public' ? '加入了私人房間' : '加入了聊天室'}`,
            highlight: username,
            action: 'join'
        };
        
        // 只發送給相應的房間
        if (currentRoom !== 'public') {
            io.to(currentRoom).emit('message', message);
        } else {
            io.to('public').emit('message', message);
        }
    });

    // 處理消息
    socket.on('message', (data) => {
        // 如果收到的是字符串，轉換為標準消息格式
        if (typeof data === 'string') {
            data = {
                content: data,
                type: 'user'
            };
        }

        // 獲取當前用戶
        const currentUser = currentRoom !== 'public' ?
            privateUsers.get(socket.id)?.user :
            publicUsers.get(socket.id)?.user;
        
        // 檢查消息中的提及
        let mentions = [];
        if (typeof data.content === 'string') {
            const mentionRegex = /@(\S+)/g;
            mentions = [...data.content.matchAll(mentionRegex)]
                .map(match => match[1])
                .filter(mention => mention !== currentUser);
        }

        const messageData = {
            user: currentUser,
            type: data.type || 'user',
            content: data.content,
            timestamp: Date.now(),
            mentions: mentions
        };

        // 如果是私人房間
        if (currentRoom && currentRoom !== 'public') {
            // 保存消息到房間歷史記錄
            const roomHistory = roomMessages.get(currentRoom) || [];
            roomHistory.push(messageData);
            if (roomHistory.length > MAX_HISTORY) {
                roomHistory.shift();
            }
            roomMessages.set(currentRoom, roomHistory);
            
            // 只發送給房間成員
            io.to(currentRoom).emit('message', messageData);
            
            // 私人房間的提及通知只發送給房間內的用戶
            if (mentions.length > 0) {
                const mentionedSocketIds = Array.from(privateUsers.entries())
                    .filter(([_, u]) => mentions.includes(u.user))
                    // 排除自己
                    .filter(([_, u]) => u.user !== currentUser)
                    .map(([socketId]) => socketId)
                    .filter(socketId => io.sockets.adapter.rooms.get(currentRoom)?.has(socketId));

                mentionedSocketIds.forEach(socketId => {
                    io.to(socketId).emit('mentioned', {
                        from: currentUser,
                        message: data.content
                    });
                });
            }
            return;
        }

        // 公共聊天室的消息處理
        messageHistory.push(messageData);
        if (messageHistory.length > MAX_HISTORY) {
            messageHistory.shift();
        }
        
        // 只發送給公共聊天室的用戶
        const publicRoomSockets = Array.from(publicUsers.keys());
        publicRoomSockets.forEach(socketId => {
            io.to(socketId).emit('message', messageData);
        });

        // 發送提及通知（只給公共聊天室的用戶）
        if (mentions.length > 0) {
            const mentionedSocketIds = Array.from(publicUsers.entries())
                .filter(([_, u]) => mentions.includes(u.user))
                // 排除自己
                .filter(([_, u]) => u.user !== currentUser)
                .map(([socketId]) => socketId);

            mentionedSocketIds.forEach(socketId => {
                io.to(socketId).emit('mentioned', {
                    from: currentUser,
                    message: data.content
                });
            });
        }
    });

    // 處理斷開連接
    socket.on('disconnect', () => {
        console.log('用戶斷開連接');
        let username;
        
        if (currentRoom && currentRoom !== 'public') {
            const userInfo = privateUsers.get(socket.id);
            if (!userInfo) {
                console.log('用戶信息不存在');
                return;
            }
            username = userInfo.user;
            if (username) {
                const roomUsersList = roomUsers.get(currentRoom);
                if (roomUsersList) {
                    roomUsersList.delete(username);
                    privateUsers.delete(socket.id);
                    // 只發送給當前房間的用戶
                    const roomUsers = Array.from(privateUsers.values())
                        .filter(u => u.chat_id === currentRoom);
                    io.to(currentRoom).emit('userList', roomUsers);
                    
                    // 只發送離開消息給當前房間
                    io.to(currentRoom).emit('message', {
                        type: 'system',
                        content: `${username} 離開了私人房間`,
                        highlight: username,
                        action: 'leave'
                    });
                }
            }
        } else {
            const userInfo = publicUsers.get(socket.id);
            if (!userInfo) {
                console.log('用戶信息不存在');
                return;
            }
            username = userInfo.user;
            if (username) {
                publicUsers.delete(socket.id);
                // 只發送給公共聊天室的用戶
                const publicRoomSockets = Array.from(publicUsers.keys());
                const publicUsersList = Array.from(publicUsers.values())
                    .filter((user, index, self) => 
                        index === self.findIndex(u => u.user === user.user)
                    );
                publicRoomSockets.forEach(socketId => {
                    io.to(socketId).emit('userList', publicUsersList);
                });
                
                // 只發送離開消息給公共聊天室
                io.to('public').emit('message', {
                    type: 'system',
                    content: `${username} 離開了聊天室`,
                    highlight: username,
                    action: 'leave'
                });
            }
        }
    });

    // 處理創建房間
    socket.on('createRoom', (data, callback) => {
        const { roomId, password, passNeedId } = data;
        console.log('創建房間:', { roomId, password, passNeedId });
        
        // 先創建房間
        rooms.set(roomId, {
            created: true,
            password: password,
            passNeedId: passNeedId
        });
        
        if (password) {
            roomPasswords.set(roomId, password);
            roomPassNeedIds.set(roomId, passNeedId);
            console.log('設置房間密碼:', { roomId, password });
        }
        
        // 初始化房間用戶列表
        if (!roomUsers.has(roomId)) {
            roomUsers.set(roomId, new Set());
        }
        
        // 立即回調，不需要等待
        if (callback) {
            callback();
        }
    });
});

// 文件上傳路由
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    res.json({
        filename: req.file.filename,
        path: `/uploads/${req.file.filename}`
    });
});

// 啟動服務器
const PORT = process.env.SERVER_PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
http.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
}); 