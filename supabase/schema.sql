-- ITO ONLINE / Supabase schema
-- Supabase SQL Editor でこのファイル全体を実行してください。
-- その後 Authentication > Providers で Anonymous Sign-Ins を有効にしてください。

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (char_length(code) = 6),
  host_user_id uuid not null,
  theme text,
  status text not null default 'lobby' check (status in ('lobby','playing','revealed')),
  ordering uuid[] not null default '{}',
  round integer not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null,
  name text not null check (char_length(name) between 1 and 14),
  is_host boolean not null default false,
  created_at timestamptz not null default now(),
  unique(room_id, user_id)
);

create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  owner_user_id uuid not null,
  slot smallint not null check (slot in (1,2)),
  value smallint not null check (value between 1 and 100),
  round integer not null,
  unique(room_id, player_id, slot, round)
);

create table if not exists public.card_hints (
  card_id uuid primary key references public.cards(id) on delete cascade,
  room_id uuid not null references public.rooms(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  owner_name text not null,
  slot smallint not null check (slot in (1,2)),
  hint text not null check (char_length(hint) between 1 and 80),
  created_at timestamptz not null default now()
);

alter table public.rooms enable row level security;
alter table public.players enable row level security;
alter table public.cards enable row level security;
alter table public.card_hints enable row level security;

-- 同じルームのメンバーかどうかを安全に確認する補助関数
create or replace function public.is_room_member(p_room uuid, p_user uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.players
    where room_id = p_room and user_id = p_user
  );
$$;

revoke all on function public.is_room_member(uuid, uuid) from public;
grant execute on function public.is_room_member(uuid, uuid) to authenticated;

drop policy if exists rooms_select_members on public.rooms;
create policy rooms_select_members on public.rooms
for select to authenticated
using (public.is_room_member(id));

drop policy if exists players_select_members on public.players;
create policy players_select_members on public.players
for select to authenticated
using (public.is_room_member(room_id));

drop policy if exists cards_select_owner on public.cards;
create policy cards_select_owner on public.cards
for select to authenticated
using (owner_user_id = auth.uid());

drop policy if exists hints_select_members on public.card_hints;
create policy hints_select_members on public.card_hints
for select to authenticated
using (public.is_room_member(room_id));

grant select on public.rooms, public.players, public.cards, public.card_hints to authenticated;

-- 6桁コード
create or replace function public.make_room_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text := '';
  i int;
begin
  for i in 1..6 loop
    result := result || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return result;
end;
$$;

-- ルーム作成
create or replace function public.create_game_room(p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_room uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if char_length(trim(p_name)) < 1 then raise exception '名前を入力してください'; end if;

  loop
    v_code := public.make_room_code();
    exit when not exists(select 1 from public.rooms where code = v_code);
  end loop;

  insert into public.rooms(code, host_user_id)
  values(v_code, auth.uid())
  returning id into v_room;

  insert into public.players(room_id, user_id, name, is_host)
  values(v_room, auth.uid(), left(trim(p_name),14), true);

  return v_code;
end;
$$;

-- 参加
create or replace function public.join_game_room(p_code text, p_name text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;

  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_room.status <> 'lobby' then raise exception 'このルームはすでにゲーム中です'; end if;

  insert into public.players(room_id, user_id, name, is_host)
  values(v_room.id, auth.uid(), left(trim(p_name),14), false)
  on conflict(room_id,user_id) do update set name = excluded.name;

  return v_room.code;
end;
$$;

-- カード配布（ホストのみ）
create or replace function public.start_game(p_code text, p_theme text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_count int;
begin
  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'ホストだけが開始できます'; end if;
  if v_room.status <> 'lobby' then raise exception '開始できない状態です'; end if;

  select count(*) into v_count from public.players where room_id = v_room.id;
  if v_count < 2 then raise exception '2人以上必要です'; end if;
  if v_count * 2 > 100 then raise exception '参加者が多すぎます'; end if;

  delete from public.card_hints where room_id = v_room.id;
  delete from public.cards where room_id = v_room.id;

  -- 1〜100から重複なしで人数×2枚を抽選し、各プレイヤーに2枚ずつ配布
  with picked as (
    select n, row_number() over(order by random()) as rn
    from generate_series(1,100) n
    order by random()
    limit (v_count * 2)
  ),
  ps as (
    select id, user_id, row_number() over(order by created_at, id) as prn
    from public.players where room_id = v_room.id
  )
  insert into public.cards(room_id, player_id, owner_user_id, slot, value, round)
  select v_room.id, ps.id, ps.user_id, s.slot, picked.n, v_room.round
  from ps
  cross join (values (1),(2)) as s(slot)
  join picked on picked.rn = ((ps.prn - 1) * 2 + s.slot);

  update public.rooms
  set theme = left(trim(p_theme), 50), status = 'playing', ordering = '{}'
  where id = v_room.id;
end;
$$;

-- ヒント保存（本人のカードだけ）
create or replace function public.upsert_card_hint(p_code text, p_card_id uuid, p_hint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_card public.cards%rowtype;
  v_player public.players%rowtype;
begin
  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found or v_room.status <> 'playing' then raise exception 'ゲーム中ではありません'; end if;

  select * into v_card from public.cards where id = p_card_id and room_id = v_room.id;
  if not found or v_card.owner_user_id <> auth.uid() then raise exception '自分のカードではありません'; end if;

  select * into v_player from public.players where id = v_card.player_id;

  insert into public.card_hints(card_id, room_id, player_id, owner_name, slot, hint)
  values(v_card.id, v_room.id, v_player.id, v_player.name, v_card.slot, left(trim(p_hint),80))
  on conflict(card_id) do update set hint = excluded.hint, owner_name = excluded.owner_name;
end;
$$;

-- 並び順更新。同じルームの参加者なら誰でも更新可
create or replace function public.set_ordering(p_code text, p_card_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_id uuid;
begin
  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found then raise exception 'ルームが見つかりません'; end if;
  if not public.is_room_member(v_room.id, auth.uid()) then raise exception '参加者ではありません'; end if;
  if v_room.status <> 'playing' then raise exception '並べ替えできない状態です'; end if;

  foreach v_id in array coalesce(p_card_ids, '{}'::uuid[]) loop
    if not exists(select 1 from public.card_hints where room_id = v_room.id and card_id = v_id) then
      raise exception '無効なカードが含まれています';
    end if;
  end loop;

  if cardinality(p_card_ids) <> (
    select count(distinct x) from unnest(coalesce(p_card_ids,'{}'::uuid[])) x
  ) then
    raise exception '同じカードを重複して並べることはできません';
  end if;

  update public.rooms set ordering = coalesce(p_card_ids,'{}'::uuid[]) where id = v_room.id;
end;
$$;

-- 答え合わせ（ホストのみ）
create or replace function public.reveal_game(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
  v_total int;
  v_hint_total int;
begin
  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'ホストだけが答え合わせできます'; end if;

  select count(*) into v_total from public.cards where room_id = v_room.id;
  select count(*) into v_hint_total from public.card_hints where room_id = v_room.id;

  if v_total = 0 or v_hint_total <> v_total then raise exception '全員のヒントが揃っていません'; end if;
  if cardinality(v_room.ordering) <> v_total then raise exception '全カードを並べてください'; end if;

  update public.rooms set status = 'revealed' where id = v_room.id;
end;
$$;

-- reveal後だけ数字を全員に返す
create or replace function public.get_revealed_cards(p_code text)
returns table(card_id uuid, value smallint, owner_name text, slot smallint, hint text)
language sql
security definer
set search_path = public
stable
as $$
  select c.id, c.value, p.name, c.slot, h.hint
  from public.rooms r
  join public.cards c on c.room_id = r.id
  join public.players p on p.id = c.player_id
  join public.card_hints h on h.card_id = c.id
  where r.code = upper(trim(p_code))
    and r.status = 'revealed'
    and public.is_room_member(r.id, auth.uid());
$$;

-- 次ラウンド（ホストのみ・ランダムテーマはクライアントから渡す）
create or replace function public.next_round(p_code text, p_theme text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms where code = upper(trim(p_code));
  if not found then raise exception 'ルームが見つかりません'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'ホストだけが開始できます'; end if;

  update public.rooms set status='lobby', ordering='{}', theme=null, round=round+1 where id=v_room.id;
  delete from public.card_hints where room_id=v_room.id;
  delete from public.cards where room_id=v_room.id;

  perform public.start_game(p_code, p_theme);
end;
$$;

grant execute on function public.create_game_room(text) to authenticated;
grant execute on function public.join_game_room(text,text) to authenticated;
grant execute on function public.start_game(text,text) to authenticated;
grant execute on function public.upsert_card_hint(text,uuid,text) to authenticated;
grant execute on function public.set_ordering(text,uuid[]) to authenticated;
grant execute on function public.reveal_game(text) to authenticated;
grant execute on function public.get_revealed_cards(text) to authenticated;
grant execute on function public.next_round(text,text) to authenticated;

-- Realtime対象
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.players;
alter publication supabase_realtime add table public.card_hints;
