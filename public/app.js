(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // ---------- localStorage (с защитой от ошибок) ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  function getPlayerId() {
    let id = store.get('hb:id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
      store.set('hb:id', id);
    }
    return id;
  }
  const savedName = () => store.get('hb:name') || '';

  // ---------- виды ----------
  const views = ['v-home', 'v-name', 'v-message', 'v-room'];
  function show(view) {
    views.forEach((v) => { $(v).hidden = v !== view; });
  }
  function message(text) {
    $('t-message').textContent = text;
    show('v-message');
  }

  const socket = io();
  const match = location.pathname.match(/^\/room\/([A-Za-z]{4})\/?$/);
  const roomCode = match ? match[1].toUpperCase() : null;
  let joined = false;
  let state = null;

  // ---------- главная ----------
  if (!roomCode) {
    show('v-home');
    $('i-create-name').value = savedName();
    $('f-create').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('i-create-name').value.trim();
      if (!name) return;
      store.set('hb:name', name);
      socket.emit('create', { name, playerId: getPlayerId() }, (res) => {
        if (res.error) { $('e-create').textContent = res.error; return; }
        store.set('hb:joined:' + res.code, '1');
        location.href = '/room/' + res.code;
      });
    });
    return;
  }

  // ---------- вход в комнату ----------
  $('t-join-code').textContent = roomCode;
  $('t-code').textContent = roomCode;

  function join(name) {
    socket.emit('join', { code: roomCode, name, playerId: getPlayerId() }, (res) => {
      if (res.error === 'notfound') { message('Комната не найдена. Возможно, она устарела.'); return; }
      if (res.error) {
        joined = false;
        show('v-name');
        $('i-join-name').value = name || savedName();
        $('e-join').textContent = res.error;
        return;
      }
      joined = true;
      store.set('hb:joined:' + roomCode, '1');
      if (name) store.set('hb:name', name);
    });
  }

  $('f-join').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('i-join-name').value.trim();
    if (!name) return;
    $('e-join').textContent = '';
    join(name);
  });

  socket.on('connect', () => {
    $('t-conn').hidden = true;
    if (joined || store.get('hb:joined:' + roomCode)) {
      join(savedName()); // переподключение: сервер узнает нас по ID
    } else {
      show('v-name');
      $('i-join-name').value = savedName();
      $('i-join-name').focus();
    }
  });
  socket.on('disconnect', () => { if (joined) $('t-conn').hidden = false; });

  socket.on('kicked', () => {
    joined = false;
    store.del('hb:id');
    message('Хост удалил вас из комнаты.');
  });
  socket.on('fail', (msg) => alert(msg));

  // ---------- кнопки ----------
  $('b-copy').addEventListener('click', async () => {
    const url = location.origin + '/room/' + roomCode;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const t = document.createElement('textarea');
      t.value = url; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
    }
    $('b-copy').textContent = 'Скопировано';
    setTimeout(() => { $('b-copy').textContent = 'Скопировать ссылку'; }, 1500);
  });

  $('b-start').addEventListener('click', () => socket.emit('start'));
  $('b-new').addEventListener('click', () => socket.emit('newRound'));

  $('f-pick').addEventListener('submit', (e) => {
    e.preventDefault();
    socket.emit('setCharacter', { text: $('i-pick').value });
    $('i-pick').blur();
  });
  $('i-pick').addEventListener('input', renderPickState);

  $('b-giveup').addEventListener('click', () => {
    if (confirm('Точно сдаётесь? Вы увидите своего персонажа.')) socket.emit('giveUp');
  });

  $('i-notes').addEventListener('input', () => {
    if (state && state.round) store.set(notesKey(), $('i-notes').value);
  });
  const notesKey = () => `hb:notes:${roomCode}:${state.round.no}`;

  // делегирование кликов в списках
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    const act = btn.dataset.act;
    if (act === 'guessed') socket.emit('guessed', { targetId: id });
    if (act === 'undo') socket.emit('undoGuess', { targetId: id });
    if (act === 'kick') {
      const p = state.players.find((x) => x.id === id);
      if (p && confirm(`Удалить игрока ${p.name}?`)) socket.emit('kick', { targetId: id });
    }
  });

  // ---------- отрисовка ----------
  socket.on('state', (s) => {
    const prevRound = state && state.round ? state.round.no : null;
    state = s;
    show('v-room');
    render(prevRound);
  });

  function playerRow(p, extra) {
    const isHost = p.id === state.hostId;
    const amHost = state.me === state.hostId;
    const tags = [];
    if (p.id === state.me) tags.push('<span class="tag">вы</span>');
    if (isHost) tags.push('<span class="tag">хост</span>');
    if (!p.online) tags.push('<span class="tag">не в сети</span>');
    if (extra) tags.push(extra);
    const kick = amHost && p.id !== state.me
      ? `<button class="link" data-act="kick" data-id="${esc(p.id)}">удалить</button>` : '';
    return `<li><span class="name${p.online ? '' : ' off'}">${esc(p.name)}</span>${tags.join('')}${kick}</li>`;
  }

  function render(prevRound) {
    const s = state;
    const amHost = s.me === s.hostId;
    const r = s.round;
    const waiting = s.phase !== 'lobby' && r && !r.inRound;

    $('p-lobby').hidden = s.phase !== 'lobby';
    $('p-wait').hidden = !waiting || s.phase === 'results';
    $('p-picking').hidden = s.phase !== 'picking';
    $('p-playing').hidden = s.phase !== 'playing';
    $('p-results').hidden = s.phase !== 'results';
    $('p-roster').hidden = s.phase === 'lobby';

    // лобби
    if (s.phase === 'lobby') {
      $('l-lobby').innerHTML = s.players.map((p) => playerRow(p)).join('');
      $('b-start').hidden = !amHost;
      $('b-start').disabled = s.players.length < 2;
      const host = s.players.find((p) => p.id === s.hostId);
      $('t-lobby-hint').textContent = amHost
        ? (s.players.length < 2 ? 'Отправьте ссылку друзьям. Нужно минимум 2 игрока.' : 'Когда все соберутся, нажмите «Начать».')
        : `Ждём, когда ${host ? host.name : 'хост'} начнёт игру.`;
    }

    // список игроков во время раунда
    if (s.phase !== 'lobby') {
      $('l-roster').innerHTML = s.players
        .map((p) => playerRow(p, p.inRound ? '' : '<span class="tag">ждёт раунда</span>'))
        .join('');
    }

    // загадывание
    if (s.phase === 'picking') {
      $('pick-box').hidden = !r.inRound;
      if (r.inRound) {
        $('t-pick-for').textContent = r.pickFor.name;
        const input = $('i-pick');
        if (prevRound !== r.no || (document.activeElement !== input && input.value.trim() !== r.myPick)) {
          input.value = r.myPick;
        }
        renderPickState();
      }
      $('l-ready').innerHTML = r.ready.map((x) => {
        const p = s.players.find((pp) => pp.id === x.id) || { id: x.id, name: x.name, online: true };
        return playerRow(p, x.ready ? '<span class="tag ok">готов</span>' : '<span class="tag">загадывает</span>');
      }).join('');
    }

    // игра
    if (s.phase === 'playing') {
      const online = Object.fromEntries(s.players.map((p) => [p.id, p.online]));
      const mine = r.cards.find((c) => c.id === s.me);
      const others = r.cards.filter((c) => c.id !== s.me);
      const ordered = mine ? [mine, ...others] : others;
      $('l-cards').innerHTML = ordered.map((c) => cardHtml(c, online[c.id] !== false)).join('');

      $('me-tools').hidden = !mine;
      if (mine) {
        if (prevRound !== r.no) $('i-notes').value = store.get(notesKey()) || '';
        $('b-giveup').hidden = mine.status !== 'playing';
      }
    }

    // итоги
    if (s.phase === 'results') {
      $('l-results').innerHTML = r.cards.map((c) => {
        const pos = c.status === 'guessed'
          ? `<span class="pos">${c.place}</span>`
          : '<span class="pos gave">—</span>';
        const gave = c.status === 'guessed' ? '' : ' <span class="tag">сдался</span>';
        return `<li>${pos}<div><div>${esc(c.name)} — <span class="char">${esc(c.character)}</span>${gave}</div>`
          + `<div class="by">загадал(а): ${esc(c.picker)}</div></div></li>`;
      }).join('');
      $('b-new').hidden = !amHost;
      const host = s.players.find((p) => p.id === s.hostId);
      $('t-results-hint').textContent = amHost ? '' : `Новый раунд начнёт ${host ? host.name : 'хост'}.`;
    }
  }

  function cardHtml(c, online) {
    const isMe = c.id === state.me;
    const cls = ['card', c.status];
    if (isMe) cls.push('me');
    if (c.removed) cls.push('removed');

    const who = esc(c.name) + (isMe ? ' (вы)' : '') + (c.removed ? ' — удалён' : (online ? '' : ' — не в сети'));
    const charText = c.character == null ? '???' : esc(c.character);
    const by = isMe && c.character == null ? '' : `<div class="by">загадал(а): ${esc(c.picker)}</div>`;

    let side = '';
    if (c.status === 'guessed') {
      side = `<span class="mark">угадал, ${c.place} место</span>`;
      if (!isMe) side += `<button class="secondary small" data-act="undo" data-id="${esc(c.id)}">Отменить</button>`;
    } else if (c.status === 'gaveup') {
      side = '<span class="mark">сдался</span>';
    } else if (!isMe) {
      side = `<button class="small" data-act="guessed" data-id="${esc(c.id)}">Угадал</button>`;
    }

    return `<li class="${cls.join(' ')}"><div class="body"><div class="who${online ? '' : ' off'}">${who}</div>`
      + `<div class="char">${charText}</div>${by}</div><div class="side">${side}</div></li>`;
  }

  function renderPickState() {
    if (!state || state.phase !== 'picking' || !state.round.inRound) return;
    const v = $('i-pick').value.trim().replace(/\s+/g, ' ');
    const saved = state.round.myPick;
    let t;
    if (!saved) t = 'Введите персонажа и нажмите «Готово».';
    else if (v === saved) t = 'Сохранено. Можно изменить, пока остальные загадывают.';
    else t = 'Есть несохранённые изменения — нажмите «Готово».';
    $('t-pick-state').textContent = t;
  }
})();
