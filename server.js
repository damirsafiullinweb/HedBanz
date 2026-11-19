const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST_TIMEOUT_MS = 30 * 1000;
const ROOM_TTL_MS = 30 * 60 * 1000;
const NAME_MAX = 20;
const CHAR_MAX = 60;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/room/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/*
 * room = {
 *   code, hostId, phase: 'lobby' | 'picking' | 'playing' | 'results',
 *   players: Map<id, { id, name, socketId, online, offlineSince, inRound, removed }>,
 *   joinOrder: [id],           // для передачи прав хоста
 *   round: null | {
 *     no,                       // номер раунда
 *     ids: [id],                // участники раунда в порядке цикла
 *     pickFor: { pickerId: targetId },
 *     chars: { targetId: text },
 *     status: { id: 'playing' | 'guessed' | 'gaveup' },
 *     finished: [id],           // порядок угадывания
 *   },
 *   roundNo, emptySince,
 * }
 */
const rooms = new Map();

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function makeCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
function cleanChar(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, CHAR_MAX);
}

function activePlayers(room) {
  return [...room.players.values()].filter((p) => !p.removed);
}

function nameTaken(room, name, exceptId) {
  const n = name.toLowerCase();
  return activePlayers(room).some((p) => p.id !== exceptId && p.name.toLowerCase() === n);
}

function cycleTarget(round, pickerId) {
  const i = round.ids.indexOf(pickerId);
  return round.ids[(i + 1) % round.ids.length];
}

function rebuildPickFor(round) {
  round.pickFor = {};
  round.ids.forEach((id) => {
    round.pickFor[id] = cycleTarget(round, id);
  });
}

// ---------- представление состояния для конкретного игрока ----------

function viewFor(room, meId) {
  const me = room.players.get(meId);
  const players = activePlayers(room).map((p) => ({
    id: p.id,
    name: p.name,
    online: p.online,
    inRound: p.inRound,
  }));

  const view = {
    code: room.code,
    me: meId,
    hostId: room.hostId,
    phase: room.phase,
    players,
    round: null,
  };

  const r = room.round;
  if (!r) return view;

  const name = (id) => (room.players.get(id) || {}).name || '?';
  const iAmIn = me && me.inRound && r.ids.includes(meId);

  if (room.phase === 'picking') {
    view.round = {
      no: r.no,
      inRound: iAmIn,
      pickFor: iAmIn ? { id: r.pickFor[meId], name: name(r.pickFor[meId]) } : null,
      myPick: iAmIn ? r.chars[r.pickFor[meId]] || '' : '',
      ready: r.ids
        .filter((id) => !room.players.get(id).removed)
        .map((id) => ({ id, name: name(id), ready: Boolean(r.chars[r.pickFor[id]]) })),
    };
    return view;
  }

  // playing / results
  const pickerOf = {};
  Object.entries(r.pickFor).forEach(([picker, target]) => {
    pickerOf[target] = picker;
  });

  const place = {};
  let n = 1;
  r.finished.forEach((id) => {
    place[id] = n++;
  });

  const cards = r.ids.map((id) => {
    const status = r.status[id];
    const hidden = id === meId && status === 'playing' && room.phase === 'playing';
    return {
      id,
      name: name(id),
      removed: Boolean(room.players.get(id).removed),
      character: hidden ? null : r.chars[id],
      picker: name(pickerOf[id]),
      status,
      place: status === 'guessed' ? place[id] : null,
    };
  });

  if (room.phase === 'results') {
    const guessed = cards.filter((c) => c.status === 'guessed').sort((a, b) => a.place - b.place);
    const gaveup = cards.filter((c) => c.status !== 'guessed');
    view.round = { no: r.no, inRound: iAmIn, cards: [...guessed, ...gaveup] };
  } else {
    view.round = { no: r.no, inRound: iAmIn, cards };
  }
  return view;
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.online && p.socketId && !p.removed) {
      io.to(p.socketId).emit('state', viewFor(room, p.id));
    }
  }
}

// ---------- игровая логика ----------

function startRound(room) {
  const ids = shuffle(activePlayers(room).map((p) => p.id));
  room.roundNo += 1;
  room.round = {
    no: room.roundNo,
    ids,
    pickFor: {},
    chars: {},
    status: {},
    finished: [],
  };
  rebuildPickFor(room.round);
  for (const p of room.players.values()) p.inRound = ids.includes(p.id);
  room.phase = 'picking';
}

function checkPickingDone(room) {
  const r = room.round;
  if (room.phase !== 'picking') return;
  if (r.ids.every((id) => r.chars[id])) {
    r.ids.forEach((id) => {
      r.status[id] = 'playing';
    });
    room.phase = 'playing';
  }
}

function checkRoundDone(room) {
  const r = room.round;
  if (room.phase !== 'playing') return;
  if (r.ids.every((id) => r.status[id] !== 'playing')) room.phase = 'results';
}

function purgeRemoved(room) {
  for (const [id, p] of room.players) {
    if (p.removed) room.players.delete(id);
  }
  room.joinOrder = room.joinOrder.filter((id) => room.players.has(id));
}

function backToLobby(room) {
  purgeRemoved(room);
  room.round = null;
  room.phase = 'lobby';
  for (const p of room.players.values()) p.inRound = false;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;

  if (room.phase === 'lobby' || room.phase === 'results' || !p.inRound) {
    if (room.phase === 'results' && p.inRound) {
      p.removed = true; // остаётся в итогах до следующего раунда
    } else {
      room.players.delete(id);
      room.joinOrder = room.joinOrder.filter((x) => x !== id);
    }
  } else if (room.phase === 'picking') {
    // чиним цикл: тот, кто загадывал удалённому, теперь загадывает его цели
    const r = room.round;
    const target = r.pickFor[id];
    r.ids = r.ids.filter((x) => x !== id);
    delete r.chars[id];
    room.players.delete(id);
    room.joinOrder = room.joinOrder.filter((x) => x !== id);
    if (r.ids.length < 2) {
      backToLobby(room);
    } else {
      // персонажа для target загадывал удалённый игрок — теперь его заново загадает picker
      delete r.chars[target];
      rebuildPickFor(r);
      checkPickingDone(room);
    }
  } else if (room.phase === 'playing') {
    p.removed = true;
    if (room.round.status[id] === 'playing') room.round.status[id] = 'gaveup';
    checkRoundDone(room);
  }

  if (room.hostId === id) assignNewHost(room, true);
}

function assignNewHost(room, force) {
  const candidates = room.joinOrder
    .map((id) => room.players.get(id))
    .filter((p) => p && !p.removed && p.online);
  if (candidates.length) {
    room.hostId = candidates[0].id;
  } else if (force) {
    const any = activePlayers(room)[0];
    room.hostId = any ? any.id : null;
  }
}

// ---------- сокеты ----------

io.on('connection', (socket) => {
  let room = null;
  let playerId = null;

  function err(msg) {
    socket.emit('fail', msg);
  }

  function attach(r, id) {
    room = r;
    playerId = id;
    const p = r.players.get(id);
    p.socketId = socket.id;
    p.online = true;
    p.offlineSince = null;
    r.emptySince = null;
    if (!r.hostId || !r.players.get(r.hostId) || r.players.get(r.hostId).removed) {
      r.hostId = id;
    }
  }

  socket.on('create', ({ name, playerId: pid }, ack) => {
    name = cleanName(name);
    if (!name) return ack && ack({ error: 'Введите имя' });
    if (!pid || typeof pid !== 'string') return ack && ack({ error: 'Ошибка клиента' });
    const code = makeCode();
    const r = {
      code,
      hostId: pid,
      phase: 'lobby',
      players: new Map(),
      joinOrder: [pid],
      round: null,
      roundNo: 0,
      emptySince: null,
    };
    r.players.set(pid, { id: pid, name, socketId: null, online: true, offlineSince: null, inRound: false, removed: false });
    rooms.set(code, r);
    ack && ack({ code });
  });

  socket.on('join', ({ code, name, playerId: pid }, ack) => {
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return ack && ack({ error: 'notfound' });
    if (!pid || typeof pid !== 'string') return ack && ack({ error: 'Ошибка клиента' });

    const existing = r.players.get(pid);
    if (existing && !existing.removed) {
      // переподключение; имя можно сменить только в лобби
      const n = cleanName(name);
      if (n && n !== existing.name && r.phase === 'lobby' && !nameTaken(r, n, pid)) existing.name = n;
      attach(r, pid);
      ack && ack({ ok: true });
      broadcast(r);
      return;
    }
    if (existing && existing.removed) return ack && ack({ error: 'Вас удалили из комнаты' });

    name = cleanName(name);
    if (!name) return ack && ack({ error: 'Введите имя' });
    if (nameTaken(r, name, pid)) return ack && ack({ error: 'Это имя уже занято' });

    r.players.set(pid, { id: pid, name, socketId: null, online: true, offlineSince: null, inRound: false, removed: false });
    r.joinOrder.push(pid);
    attach(r, pid);
    ack && ack({ ok: true });
    broadcast(r);
  });

  function guard(hostOnly) {
    if (!room || !playerId) return false;
    const p = room.players.get(playerId);
    if (!p || p.removed) return false;
    if (hostOnly && room.hostId !== playerId) return false;
    return true;
  }

  socket.on('start', () => {
    if (!guard(true) || room.phase !== 'lobby') return;
    if (activePlayers(room).length < 2) return err('Нужно минимум 2 игрока');
    startRound(room);
    broadcast(room);
  });

  socket.on('newRound', () => {
    if (!guard(true) || room.phase !== 'results') return;
    purgeRemoved(room);
    if (activePlayers(room).length < 2) {
      backToLobby(room);
    } else {
      startRound(room);
    }
    broadcast(room);
  });

  socket.on('setCharacter', ({ text }) => {
    if (!guard() || room.phase !== 'picking') return;
    const r = room.round;
    if (!r.ids.includes(playerId)) return;
    const t = cleanChar(text);
    const target = r.pickFor[playerId];
    if (t) r.chars[target] = t;
    else delete r.chars[target];
    checkPickingDone(room);
    broadcast(room);
  });

  socket.on('guessed', ({ targetId }) => {
    if (!guard() || room.phase !== 'playing') return;
    const r = room.round;
    if (targetId === playerId || !r.ids.includes(targetId)) return;
    if (r.status[targetId] !== 'playing') return;
    r.status[targetId] = 'guessed';
    r.finished.push(targetId);
    checkRoundDone(room);
    broadcast(room);
  });

  socket.on('undoGuess', ({ targetId }) => {
    if (!guard() || room.phase !== 'playing') return;
    const r = room.round;
    if (targetId === playerId || r.status[targetId] !== 'guessed') return;
    r.status[targetId] = 'playing';
    r.finished = r.finished.filter((x) => x !== targetId);
    broadcast(room);
  });

  socket.on('giveUp', () => {
    if (!guard() || room.phase !== 'playing') return;
    const r = room.round;
    if (r.status[playerId] !== 'playing') return;
    r.status[playerId] = 'gaveup';
    checkRoundDone(room);
    broadcast(room);
  });

  socket.on('kick', ({ targetId }) => {
    if (!guard(true) || targetId === playerId) return;
    const target = room.players.get(targetId);
    if (!target || target.removed) return;
    const sid = target.socketId;
    removePlayer(room, targetId);
    if (sid) io.to(sid).emit('kicked');
    broadcast(room);
  });

  socket.on('disconnect', () => {
    if (!room || !playerId) return;
    const p = room.players.get(playerId);
    if (!p || p.socketId !== socket.id) return;
    p.online = false;
    p.offlineSince = Date.now();
    if (!activePlayers(room).some((x) => x.online)) room.emptySince = Date.now();
    broadcast(room);
  });
});

// ---------- фоновые проверки: передача хоста и удаление пустых комнат ----------

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > ROOM_TTL_MS) {
      rooms.delete(code);
      continue;
    }
    const host = room.players.get(room.hostId);
    if (!host || host.removed || (!host.online && now - host.offlineSince > HOST_TIMEOUT_MS)) {
      const before = room.hostId;
      assignNewHost(room, false);
      if (room.hostId !== before) broadcast(room);
    }
  }
}, 5000);

server.listen(PORT, () => {
  console.log(`Кто я? — http://localhost:${PORT}`);
});
