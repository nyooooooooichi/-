import { createClient } from '@supabase/supabase-js'
import './style.css'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const app = document.querySelector('#app')

if (!SUPABASE_URL || !SUPABASE_KEY) {
  app.innerHTML = `<main class="app">
    <div class="panel">
      <h2>Supabase設定が必要です</h2>
      <p><code>.env</code> に <code>VITE_SUPABASE_URL</code> と <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> を設定してください。</p>
    </div>
  </main>`
  throw new Error('Missing Supabase environment variables')
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const RANDOM_THEMES = [
  '弱いもの', '強そうなもの', '怖いもの', 'テンションが上がるもの',
  '食べたいもの', '便利なもの', '高そうなもの', '大切なもの',
  '速そうなもの', 'もらって嬉しいもの', '住みたい場所',
  '人気がありそうなもの', '学校にあったら嬉しいもの'
]

let state = {
  user: null,
  room: null,
  me: null,
  players: [],
  myCards: [],
  hints: [],
  ordering: [],
  revealed: []
}
let channel = null

const esc = (v='') => String(v).replace(/[&<>"']/g, ch => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
}[ch]))

async function boot() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) {
    const { data, error } = await supabase.auth.signInAnonymously()
    if (error) return fatal('匿名ログインに失敗しました。SupabaseでAnonymous Sign-InsをONにしてください。', error)
    state.user = data.user
  } else {
    state.user = session.user
  }
  renderHome()
}

function shell(content) {
  app.innerHTML = `<main class="app">
    <header>
      <div class="eyebrow">ONLINE CARD GAME</div>
      <h1>ITO ONLINE</h1>
      <div class="muted">PC・スマホ対応 / ルームコードで友達と対戦</div>
    </header>
    ${content}
  </main>`
}

function renderHome(message='') {
  cleanupChannel()
  state = { ...state, room:null, me:null, players:[], myCards:[], hints:[], ordering:[], revealed:[] }
  shell(`
    <section class="panel stack">
      <h2>ゲームを始める</h2>
      ${message ? `<div class="error">${esc(message)}</div>` : ''}
      <label>プレイヤー名
        <input id="name" maxlength="14" placeholder="名前を入力">
      </label>
      <div class="grid2">
        <button id="create" class="primary">ルームを作る</button>
        <button id="joinToggle">ルームに参加</button>
      </div>
      <div id="joinBox" class="stack hidden">
        <label>ルームコード
          <input id="code" maxlength="6" placeholder="例：A7K2P9" style="text-transform:uppercase">
        </label>
        <button id="join" class="primary">参加する</button>
      </div>
    </section>
  `)

  document.querySelector('#joinToggle').onclick = () => document.querySelector('#joinBox').classList.toggle('hidden')
  document.querySelector('#create').onclick = createRoom
  document.querySelector('#join').onclick = joinRoom
}

async function createRoom() {
  const name = document.querySelector('#name').value.trim()
  if (!name) return alert('名前を入力してね。')

  const { data, error } = await supabase.rpc('create_game_room', { p_name: name })
  if (error) return alert(error.message)

  await enterRoom(data)
}

async function joinRoom() {
  const name = document.querySelector('#name').value.trim()
  const code = document.querySelector('#code').value.trim().toUpperCase()
  if (!name || code.length !== 6) return alert('名前と6桁のルームコードを入力してね。')

  const { data, error } = await supabase.rpc('join_game_room', { p_code: code, p_name: name })
  if (error) return alert(error.message)

  await enterRoom(data)
}

async function enterRoom(code) {
  await loadRoom(code)
  subscribeRoom()
  renderRoom()
}

async function loadRoom(code = state.room?.code) {
  const { data: room, error: re } = await supabase.from('rooms').select('*').eq('code', code).single()
  if (re) throw re
  state.room = room

  const { data: players, error: pe } = await supabase.from('players')
    .select('id,user_id,name,is_host,created_at').eq('room_id', room.id).order('created_at')
  if (pe) throw pe
  state.players = players
  state.me = players.find(p => p.user_id === state.user.id)

  const { data: myCards, error: ce } = await supabase.from('cards')
    .select('id,value,slot').eq('room_id', room.id).eq('owner_user_id', state.user.id).order('slot')
  if (ce) throw ce
  state.myCards = myCards || []

  const { data: hints, error: he } = await supabase.from('card_hints')
    .select('card_id,room_id,player_id,owner_name,slot,hint,created_at').eq('room_id', room.id)
  if (he) throw he
  state.hints = hints || []

  state.ordering = room.ordering || []

  if (room.status === 'revealed') {
    const { data, error } = await supabase.rpc('get_revealed_cards', { p_code: room.code })
    if (!error) state.revealed = data || []
  } else {
    state.revealed = []
  }
}

function subscribeRoom() {
  cleanupChannel()
  channel = supabase.channel(`ito:${state.room.id}`)
    .on('postgres_changes', { event:'*', schema:'public', table:'rooms', filter:`id=eq.${state.room.id}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'players', filter:`room_id=eq.${state.room.id}` }, refresh)
    .on('postgres_changes', { event:'*', schema:'public', table:'card_hints', filter:`room_id=eq.${state.room.id}` }, refresh)
    .subscribe()
}

function cleanupChannel() {
  if (channel) supabase.removeChannel(channel)
  channel = null
}

let refreshTimer = null
function refresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(async () => {
    if (!state.room) return
    try {
      await loadRoom()
      renderRoom()
    } catch (e) {
      console.error(e)
    }
  }, 120)
}

function renderRoom() {
  const r = state.room
  if (!r) return

  if (r.status === 'lobby') return renderLobby()
  if (r.status === 'playing') return renderPlaying()
  if (r.status === 'revealed') return renderRevealed()
}

function renderLobby() {
  const isHost = state.me?.is_host
  shell(`
    <section class="panel">
      <div class="roomline">
        <div><div class="muted">ルームコード</div><div class="roomcode">${esc(state.room.code)}</div></div>
        <span class="badge">${state.players.length}人参加中</span>
      </div>
    </section>

    <section class="panel">
      <h2>参加者</h2>
      <div class="list">
        ${state.players.map(p => `<div class="row">
          <b>${esc(p.name)} ${p.is_host ? '👑' : ''}</b>
          <span class="badge">${p.user_id === state.user.id ? 'あなた' : '参加中'}</span>
        </div>`).join('')}
      </div>
    </section>

    ${isHost ? `<section class="panel stack">
      <h2>お題</h2>
      <label>お題の決め方
        <select id="themeMode">
          <option value="random">ランダム</option>
          <option value="custom">自分たちで作る</option>
        </select>
      </label>
      <input id="customTheme" class="hidden" maxlength="50" placeholder="例：コンビニで買いたいもの">
      <button id="start" class="primary">ゲーム開始</button>
      <div class="muted">開始すると全員に1〜100の数字カードが2枚ずつ配られます。</div>
    </section>` : `<section class="panel"><div class="muted">ホストがゲームを開始するのを待っています。</div></section>`}

    <button id="leave">ホームに戻る</button>
  `)

  if (isHost) {
    const mode = document.querySelector('#themeMode')
    const custom = document.querySelector('#customTheme')
    mode.onchange = () => custom.classList.toggle('hidden', mode.value !== 'custom')
    document.querySelector('#start').onclick = async () => {
      if (state.players.length < 2) return alert('2人以上で遊んでね。')
      const theme = mode.value === 'custom'
        ? custom.value.trim()
        : RANDOM_THEMES[Math.floor(Math.random() * RANDOM_THEMES.length)]
      if (!theme) return alert('お題を入力してね。')
      const { error } = await supabase.rpc('start_game', { p_code: state.room.code, p_theme: theme })
      if (error) alert(error.message)
    }
  }
  document.querySelector('#leave').onclick = () => renderHome()
}

function myHintFor(cardId) {
  return state.hints.find(h => h.card_id === cardId)?.hint || ''
}

function renderPlaying() {
  const allHinted = state.hints.length === state.players.length * 2
  shell(`
    <section class="panel">
      <div class="muted">今回のお題</div>
      <h2>${esc(state.room.theme)}</h2>
    </section>

    <section class="panel">
      <h2>あなたの数字カード</h2>
      <div class="cards">
        ${state.myCards.map(c => `<div class="card">
          <div class="muted">カード ${c.slot}</div>
          <div class="num">${c.value}</div>
        </div>`).join('')}
      </div>
      <p class="muted">数字そのものは他のプレイヤーには表示されません。</p>
    </section>

    <section class="panel stack">
      <h2>2枚のヒントを入力</h2>
      ${state.myCards.map(c => `<label>カード ${c.slot} のヒント
        <input id="hint-${c.id}" maxlength="80" value="${esc(myHintFor(c.id))}" placeholder="数字を直接言わずに表現">
      </label>`).join('')}
      <button id="saveHints" class="primary">ヒントを保存</button>
    </section>

    <section class="panel">
      <div class="roomline">
        <h2>みんなのヒント</h2>
        <span class="badge">${state.hints.length}/${state.players.length * 2}</span>
      </div>
      <div class="list">
        ${state.hints.length ? state.hints.map(h => `<div class="hintcard">
          <b>${esc(h.owner_name)} / カード${h.slot}</b>
          <div>${esc(h.hint)}</div>
        </div>`).join('') : `<div class="muted">まだヒントがありません。</div>`}
      </div>
    </section>

    <section class="panel stack">
      <h2>小さいと思う順に並べる</h2>
      <div class="muted">ヒントをタップすると順番に追加されます。全員の画面に同期されます。</div>
      <div id="ordering" class="list"></div>
      <div class="grid2">
        <button id="clearOrder">並び順をリセット</button>
        ${state.me?.is_host ? `<button id="reveal" class="primary" ${allHinted && state.ordering.length === state.hints.length ? '' : 'disabled'}>答え合わせ</button>` : ''}
      </div>
      ${!allHinted ? `<div class="muted">全員が2枚ずつヒントを入力すると答え合わせできます。</div>` : ''}
    </section>
  `)

  document.querySelector('#saveHints').onclick = saveHints
  renderOrdering()

  document.querySelector('#clearOrder').onclick = async () => {
    const { error } = await supabase.rpc('set_ordering', { p_code: state.room.code, p_card_ids: [] })
    if (error) alert(error.message)
  }

  const reveal = document.querySelector('#reveal')
  if (reveal) reveal.onclick = async () => {
    const { error } = await supabase.rpc('reveal_game', { p_code: state.room.code })
    if (error) alert(error.message)
  }
}

async function saveHints() {
  for (const card of state.myCards) {
    const hint = document.querySelector(`#hint-${card.id}`).value.trim()
    if (!hint) return alert('2枚ともヒントを入力してね。')
    const { error } = await supabase.rpc('upsert_card_hint', {
      p_code: state.room.code,
      p_card_id: card.id,
      p_hint: hint
    })
    if (error) return alert(error.message)
  }
}

function renderOrdering() {
  const wrap = document.querySelector('#ordering')
  if (!wrap) return

  const byId = new Map(state.hints.map(h => [h.card_id, h]))
  const chosen = state.ordering.map(id => byId.get(id)).filter(Boolean)
  const remaining = state.hints.filter(h => !state.ordering.includes(h.card_id))

  wrap.innerHTML = `
    ${chosen.map((h, i) => `<button class="order-item chosen" data-id="${h.card_id}">
      <span class="order-num">${i + 1}</span>
      <span><b>${esc(h.owner_name)} / カード${h.slot}</b><br>${esc(h.hint)}</span>
    </button>`).join('')}
    ${remaining.map(h => `<button class="order-item" data-id="${h.card_id}">
      <span class="order-num">＋</span>
      <span><b>${esc(h.owner_name)} / カード${h.slot}</b><br>${esc(h.hint)}</span>
    </button>`).join('')}
  `

  wrap.querySelectorAll('.order-item').forEach(btn => {
    btn.onclick = async () => {
      const id = btn.dataset.id
      let next
      if (state.ordering.includes(id)) {
        next = state.ordering.filter(x => x !== id)
      } else {
        next = [...state.ordering, id]
      }
      const { error } = await supabase.rpc('set_ordering', { p_code: state.room.code, p_card_ids: next })
      if (error) alert(error.message)
    }
  })
}

function renderRevealed() {
  const byId = new Map(state.revealed.map(x => [x.card_id, x]))
  const chosen = state.ordering.map(id => byId.get(id)).filter(Boolean)
  const correct = [...state.revealed].sort((a,b) => a.value - b.value)
  const isCorrect = chosen.length === correct.length && chosen.every((x,i) => x.card_id === correct[i].card_id)

  shell(`
    <section class="panel">
      <div class="muted">今回のお題</div>
      <h2>${esc(state.room.theme)}</h2>
    </section>

    <section class="panel">
      <h2>答え合わせ</h2>
      <div class="${isCorrect ? 'success' : 'error'}">${isCorrect ? '🎉 正解！小さい順に並べられました！' : '❌ 惜しい！正しい順番を確認しよう。'}</div>
      <p class="muted">正しい順番</p>
      ${correct.map((x,i) => `<div class="answer">
        <div class="n">${x.value}</div>
        <div><b>${i+1}. ${esc(x.owner_name)} / カード${x.slot}</b><br>${esc(x.hint)}</div>
        <div class="owner">${state.ordering[i] === x.card_id ? '✓' : ''}</div>
      </div>`).join('')}
    </section>

    ${state.me?.is_host ? `<section class="panel stack">
      <button id="nextRound" class="primary">次のラウンド</button>
    </section>` : `<section class="panel"><div class="muted">ホストが次のラウンドを開始するのを待っています。</div></section>`}

    <button id="leave">ホームに戻る</button>
  `)

  const next = document.querySelector('#nextRound')
  if (next) next.onclick = async () => {
    const theme = RANDOM_THEMES[Math.floor(Math.random() * RANDOM_THEMES.length)]
    const { error } = await supabase.rpc('next_round', { p_code: state.room.code, p_theme: theme })
    if (error) alert(error.message)
  }
  document.querySelector('#leave').onclick = () => renderHome()
}

function fatal(message, err) {
  console.error(err)
  shell(`<section class="panel"><div class="error">${esc(message)}</div></section>`)
}

boot()
