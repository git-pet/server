begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text,
  avatar_url text,
  bio text,
  timezone text not null default 'UTC',
  current_streak integer not null default 0 check (current_streak >= 0),
  longest_streak integer not null default 0 check (longest_streak >= 0),
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.github_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  github_user_id bigint not null unique,
  github_username text not null unique,
  github_avatar_url text,
  access_token text,
  scope text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, github_user_id)
);

create table if not exists public.pet_species (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  base_image_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.pets (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  species_id uuid not null references public.pet_species(id) on delete restrict,
  name text not null,
  level integer not null default 1 check (level >= 1),
  exp integer not null default 0 check (exp >= 0),
  coins integer not null default 0 check (coins >= 0),
  mood integer not null default 80 check (mood between 0 and 100),
  hunger integer not null default 20 check (hunger between 0 and 100),
  energy integer not null default 80 check (energy between 0 and 100),
  health integer not null default 100 check (health between 0 and 100),
  equipped_style_id uuid,
  born_at timestamptz not null default now(),
  last_fed_at timestamptz,
  last_played_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id)
);

create table if not exists public.github_activity_types (
  id smallserial primary key,
  code text not null unique,
  name text not null,
  default_exp integer not null default 0 check (default_exp >= 0),
  default_coins integer not null default 0 check (default_coins >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.github_activity_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  github_account_id uuid references public.github_accounts(id) on delete set null,
  activity_type_id smallint not null references public.github_activity_types(id) on delete restrict,
  github_event_id text,
  repository_full_name text,
  subject_type text,
  subject_id text,
  subject_url text,
  title text,
  occurred_at timestamptz not null,
  exp_awarded integer not null default 0 check (exp_awarded >= 0),
  coins_awarded integer not null default 0 check (coins_awarded >= 0),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (github_account_id, github_event_id)
);

create table if not exists public.pet_status_event_types (
  id smallserial primary key,
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pet_stat_types (
  id smallserial primary key,
  code text not null unique check (code in ('mood', 'hunger', 'energy', 'health')),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pet_status_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  pet_id uuid not null references public.pets(id) on delete cascade,
  event_type_id smallint not null references public.pet_status_event_types(id) on delete restrict,
  stat_type_id smallint references public.pet_stat_types(id) on delete restrict,
  old_value integer check (old_value between 0 and 100),
  new_value integer check (new_value between 0 and 100),
  delta integer,
  reason text,
  source_activity_log_id uuid references public.github_activity_logs(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.widget_themes (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.pet_styles (
  id uuid primary key default extensions.gen_random_uuid(),
  species_id uuid references public.pet_species(id) on delete cascade,
  code text not null unique,
  name text not null,
  image_url text,
  required_level integer not null default 1 check (required_level >= 1),
  price_coins integer not null default 0 check (price_coins >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'pets_equipped_style_id_fkey'
      and conrelid = 'public.pets'::regclass
  ) then
    alter table public.pets
      add constraint pets_equipped_style_id_fkey
      foreign key (equipped_style_id) references public.pet_styles(id) on delete set null;
  end if;
end;
$$;

create table if not exists public.widget_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  theme_id uuid references public.widget_themes(id) on delete set null,
  show_level boolean not null default true,
  show_stats boolean not null default true,
  show_streak boolean not null default true,
  custom_message text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id)
);

create table if not exists public.coin_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  pet_id uuid references public.pets(id) on delete set null,
  amount integer not null check (amount <> 0),
  balance_after integer not null check (balance_after >= 0),
  reason text not null,
  source_activity_log_id uuid references public.github_activity_logs(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.wall_skins (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  image_url text,
  price_coins integer not null default 0 check (price_coins >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.floor_skins (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  image_url text,
  price_coins integer not null default 0 check (price_coins >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null default 'My Room',
  wall_skin_id uuid references public.wall_skins(id) on delete set null,
  floor_skin_id uuid references public.floor_skins(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id)
);

create table if not exists public.room_items (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text not null,
  image_url text,
  width integer not null default 1 check (width > 0),
  height integer not null default 1 check (height > 0),
  price_coins integer not null default 0 check (price_coins >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.user_inventory_items (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  room_item_id uuid references public.room_items(id) on delete cascade,
  wall_skin_id uuid references public.wall_skins(id) on delete cascade,
  floor_skin_id uuid references public.floor_skins(id) on delete cascade,
  pet_style_id uuid references public.pet_styles(id) on delete cascade,
  quantity integer not null default 1 check (quantity >= 0),
  acquired_at timestamptz not null default now(),
  check (
    num_nonnulls(room_item_id, wall_skin_id, floor_skin_id, pet_style_id) = 1
  )
);

create unique index if not exists user_inventory_items_unique_owned_item
  on public.user_inventory_items (
    profile_id,
    coalesce(room_item_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(wall_skin_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(floor_skin_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(pet_style_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

create table if not exists public.room_item_placements (
  id uuid primary key default extensions.gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete cascade,
  inventory_item_id uuid not null references public.user_inventory_items(id) on delete cascade,
  x integer not null check (x >= 0),
  y integer not null check (y >= 0),
  z_index integer not null default 0,
  rotation integer not null default 0 check (rotation in (0, 90, 180, 270)),
  placed_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default extensions.gen_random_uuid(),
  requester_profile_id uuid not null references public.profiles(id) on delete cascade,
  addressee_profile_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_profile_id <> addressee_profile_id)
);

create unique index if not exists friendships_unique_pair
  on public.friendships (
    least(requester_profile_id, addressee_profile_id),
    greatest(requester_profile_id, addressee_profile_id)
  );

create table if not exists public.guestbook_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  room_owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  author_profile_id uuid references public.profiles(id) on delete set null,
  message text not null check (char_length(message) <= 500),
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.guestbook_reactions (
  id uuid primary key default extensions.gen_random_uuid(),
  guestbook_entry_id uuid not null references public.guestbook_entries(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  reaction text not null check (reaction in ('like', 'heart', 'party')),
  created_at timestamptz not null default now(),
  unique (guestbook_entry_id, profile_id, reaction)
);

create table if not exists public.achievements (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  icon_url text,
  reward_exp integer not null default 0 check (reward_exp >= 0),
  reward_coins integer not null default 0 check (reward_coins >= 0),
  criteria jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.user_achievements (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete restrict,
  progress integer not null default 0 check (progress >= 0),
  is_completed boolean not null default false,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, achievement_id)
);

create table if not exists public.shop_purchases (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  room_item_id uuid references public.room_items(id) on delete restrict,
  wall_skin_id uuid references public.wall_skins(id) on delete restrict,
  floor_skin_id uuid references public.floor_skins(id) on delete restrict,
  pet_style_id uuid references public.pet_styles(id) on delete restrict,
  quantity integer not null default 1 check (quantity > 0),
  unit_price_coins integer not null check (unit_price_coins >= 0),
  total_price_coins integer not null check (total_price_coins >= 0),
  purchased_at timestamptz not null default now(),
  check (
    num_nonnulls(room_item_id, wall_skin_id, floor_skin_id, pet_style_id) = 1
  ),
  check (total_price_coins = quantity * unit_price_coins)
);

create table if not exists public.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists profiles_username_idx on public.profiles (username);
create index if not exists github_accounts_profile_id_idx on public.github_accounts (profile_id);
create index if not exists pets_profile_id_idx on public.pets (profile_id);
create index if not exists github_activity_logs_profile_occurred_idx on public.github_activity_logs (profile_id, occurred_at desc);
create index if not exists github_activity_logs_repo_idx on public.github_activity_logs (repository_full_name);
create index if not exists pet_status_logs_pet_created_idx on public.pet_status_logs (pet_id, created_at desc);
create index if not exists coin_logs_profile_created_idx on public.coin_logs (profile_id, created_at desc);
create index if not exists room_item_placements_room_idx on public.room_item_placements (room_id);
create index if not exists friendships_requester_idx on public.friendships (requester_profile_id, status);
create index if not exists friendships_addressee_idx on public.friendships (addressee_profile_id, status);
create index if not exists guestbook_entries_owner_created_idx on public.guestbook_entries (room_owner_profile_id, created_at desc);
create index if not exists user_achievements_profile_idx on public.user_achievements (profile_id, is_completed);
create index if not exists notifications_profile_created_idx on public.notifications (profile_id, created_at desc);
create index if not exists notifications_unread_idx on public.notifications (profile_id, created_at desc) where read_at is null;

insert into public.github_activity_types (code, name, default_exp, default_coins)
values
  ('commit', 'Commit', 10, 5),
  ('pull_request', 'Pull Request', 30, 15),
  ('issue', 'Issue', 20, 10),
  ('review', 'Code Review', 25, 12),
  ('release', 'Release', 50, 25)
on conflict (code) do nothing;

insert into public.pet_status_event_types (code, name)
values
  ('github_activity', 'GitHub Activity'),
  ('feed', 'Feed'),
  ('play', 'Play'),
  ('rest', 'Rest'),
  ('decay', 'Decay'),
  ('level_up', 'Level Up')
on conflict (code) do nothing;

insert into public.pet_stat_types (code, name)
values
  ('mood', 'Mood'),
  ('hunger', 'Hunger'),
  ('energy', 'Energy'),
  ('health', 'Health')
on conflict (code) do nothing;

insert into public.pet_species (code, name, description)
values
  ('octocat', 'Octocat', 'A GitHub-loving starter pet.')
on conflict (code) do nothing;

insert into public.widget_themes (code, name, config)
values
  ('default', 'Default', '{"background":"#0d1117","foreground":"#f0f6fc","accent":"#2f81f7"}'::jsonb)
on conflict (code) do nothing;

do $$
declare
  trigger_target record;
begin
  for trigger_target in
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and column_name = 'updated_at'
      and table_name in (
        'profiles',
        'github_accounts',
        'pets',
        'widget_settings',
        'rooms',
        'guestbook_entries',
        'user_achievements'
      )
  loop
    execute format('drop trigger if exists set_%I_updated_at on public.%I', trigger_target.table_name, trigger_target.table_name);
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      trigger_target.table_name,
      trigger_target.table_name
    );
  end loop;
end;
$$;

commit;
