// ═══════════════════════════════════════════════════════════════════
//  FORSAKEN — Servidor Socket.IO
//  Ejecutar: node server.js
//  Requiere:  npm install socket.io
// ═══════════════════════════════════════════════════════════════════

const http    = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// ── Servidor HTTP base ────────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('FORSAKEN Server OK\n');
});

// ── Socket.IO ────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: '*',            // En producción pon tu dominio exacto
    methods: ['GET', 'POST'],
  },
  pingInterval: 10000,
  pingTimeout:  20000,
});

// ═══════════════════════════════════════════════════════════════════
//  Estructura de salas
//  rooms[code] = {
//    code:      string,
//    hostId:    string,          ← socket.id del host actual
//    running:   boolean,         ← partida en curso
//    players: [
//      { id, socketId, name, username, malicia, afk,
//        equippedKiller, equippedSurvivor }
//    ]
//  }
// ═══════════════════════════════════════════════════════════════════
const rooms = {};

// ── Utilidades ────────────────────────────────────────────────────
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function getRoom(code) {
  return rooms[code] || null;
}

function playerList(room) {
  // Devuelve copia limpia de jugadores (sin socketId interno)
  return room.players.map(p => ({ ...p }));
}

function findRoomBySocket(socketId) {
  for (const code in rooms) {
    const r = rooms[code];
    if (r.players.find(p => p.socketId === socketId)) return r;
  }
  return null;
}

// ── Log con timestamp ─────────────────────────────────────────────
function log(...args) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`[${t}]`, ...args);
}

// ═══════════════════════════════════════════════════════════════════
//  Conexiones
// ═══════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  log(`+ Conectado  ${socket.id}`);

  // ────────────────────────────────────────────────────────────────
  //  createRoom — host crea sala privada
  //  data: { id, name, username, malicia, afk,
  //          equippedKiller, equippedSurvivor }
  //  cb  : { ok, code, players }
  // ────────────────────────────────────────────────────────────────
  socket.on('createRoom', (data, cb) => {
    if (typeof cb !== 'function') return;

    // Generar código único
    let code;
    do { code = genCode(); } while (rooms[code]);

    const player = {
      id:               data.id       || socket.id,
      socketId:         socket.id,
      name:             data.name     || data.username || 'HOST',
      username:         data.username || data.name     || 'HOST',
      malicia:          data.malicia  || 0,
      afk:              !!data.afk,
      equippedKiller:   data.equippedKiller   || '',
      equippedSurvivor: data.equippedSurvivor || '',
    };

    rooms[code] = {
      code,
      hostId:  socket.id,
      running: false,
      players: [player],
    };

    socket.join(code);
    log(`  createRoom  ${code}  host=${player.username}`);

    cb({ ok: true, code, players: playerList(rooms[code]) });
  });

  // ────────────────────────────────────────────────────────────────
  //  joinRoom — cliente se une (o reconecta) a una sala
  //  data: { code, id, name, username, malicia, afk,
  //          equippedKiller, equippedSurvivor, reconnect }
  //  cb  : { ok, isHost, players, spectate?, reason? }
  // ────────────────────────────────────────────────────────────────
  socket.on('joinRoom', (data, cb) => {
    if (typeof cb !== 'function') return;

    const code = String(data.code || '').trim().toUpperCase()
      .replace(/^FSK26-ROOM-/, '').replace(/^ROOM-/, '');

    const room = getRoom(code);

    if (!room) {
      return cb({ ok: false, reason: 'Sala no encontrada.' });
    }

    const isHost = (socket.id === room.hostId);

    // ¿Ya existe un jugador con este id? → reconexión
    const existing = room.players.find(p => p.id === data.id);
    if (existing) {
      existing.socketId = socket.id;
      existing.afk      = !!data.afk;
      socket.join(code);
      log(`  rejoin      ${code}  ${existing.username}  running=${room.running}`);

      // Si la partida está en curso → modo espectador
      if (room.running) {
        return cb({ ok: true, isHost, spectate: true, players: playerList(room) });
      }
      return cb({ ok: true, isHost, players: playerList(room) });
    }

    // Jugador nuevo
    const player = {
      id:               data.id       || socket.id,
      socketId:         socket.id,
      name:             data.name     || data.username || 'JUGADOR',
      username:         data.username || data.name     || '?',
      malicia:          data.malicia  || 0,
      afk:              !!data.afk,
      equippedKiller:   data.equippedKiller   || '',
      equippedSurvivor: data.equippedSurvivor || '',
    };

    room.players.push(player);
    socket.join(code);
    log(`  joinRoom    ${code}  ${player.username}  total=${room.players.length}`);

    // Notificar a los demás en la sala
    socket.to(code).emit('playerJoined', { players: playerList(room) });

    if (room.running) {
      return cb({ ok: true, isHost: false, spectate: true, players: playerList(room) });
    }
    cb({ ok: true, isHost: false, players: playerList(room) });
  });

  // ────────────────────────────────────────────────────────────────
  //  probeRoom — verificar si una sala existe y su estado
  //  data: { code }
  //  cb  : { exists, count, running }
  // ────────────────────────────────────────────────────────────────
  socket.on('probeRoom', (data, cb) => {
    if (typeof cb !== 'function') return;

    const code = String(data.code || '').trim().toUpperCase();
    const room  = getRoom(code);

    if (!room) return cb({ exists: false });
    cb({ exists: true, count: room.players.length, running: room.running });
  });

  // ────────────────────────────────────────────────────────────────
  //  leaveRoom — jugador abandona voluntariamente
  // ────────────────────────────────────────────────────────────────
  socket.on('leaveRoom', () => {
    _handleLeave(socket);
  });

  // ────────────────────────────────────────────────────────────────
  //  gameMsg — relay de mensajes del juego
  //  El host envía → todos los clientes de la sala lo reciben
  //  Un cliente envía → solo el host lo recibe
  //  El mensaje lleva _fromSocketId para que el host identifique quién lo mandó
  // ────────────────────────────────────────────────────────────────
  socket.on('gameMsg', (msg) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;

    msg._fromSocketId = socket.id;

    if (socket.id === room.hostId) {
      // Host → todos los clientes (no al host mismo)
      socket.to(room.code).emit('gameMsg', msg);

      // Si el mensaje indica que la partida empezó / terminó, actualizar estado
      if (msg.t === 'start') room.running = true;
      if (msg.t === 'over' || msg.t === 'returnLobby') room.running = false;
    } else {
      // Cliente → host solamente
      const hostSocket = io.sockets.sockets.get(room.hostId);
      if (hostSocket) hostSocket.emit('gameMsg', msg);
    }
  });

  // ────────────────────────────────────────────────────────────────
  //  lobbyPos — posición en el lobby (relay a todos excepto el emisor)
  // ────────────────────────────────────────────────────────────────
  socket.on('lobbyPos', (msg) => {
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    socket.to(room.code).emit('lobbyPos', msg);
  });

  // ────────────────────────────────────────────────────────────────
  //  Desconexión
  // ────────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    log(`- Desconectado  ${socket.id}  reason=${reason}`);
    _handleLeave(socket);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  _handleLeave — gestiona la salida de un jugador
// ═══════════════════════════════════════════════════════════════════
function _handleLeave(socket) {
  const room = findRoomBySocket(socket.id);
  if (!room) return;

  const idx = room.players.findIndex(p => p.socketId === socket.id);
  if (idx === -1) return;

  const removed = room.players.splice(idx, 1)[0];
  log(`  leave       ${room.code}  ${removed.username}  remaining=${room.players.length}`);

  // Si la sala queda vacía, eliminarla
  if (room.players.length === 0) {
    delete rooms[room.code];
    log(`  roomClosed  ${room.code}`);
    return;
  }

  const wasHost = (socket.id === room.hostId);

  if (wasHost) {
    // Migrar host al siguiente jugador disponible
    const newHost = room.players[0];
    room.hostId = newHost.socketId;
    log(`  hostMigrate ${room.code}  → ${newHost.username}`);

    io.to(room.code).emit('hostChanged', {
      newHostId: newHost.id,
      players:   playerList(room),
    });
  } else {
    io.to(room.code).emit('playerLeft', { players: playerList(room) });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Arrancar
// ═══════════════════════════════════════════════════════════════════
httpServer.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  FORSAKEN Server  →  puerto ${PORT}          ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});
