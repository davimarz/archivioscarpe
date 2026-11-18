alter table public.app_events
  add column session_id text,
  add column source text,
  add column merchant text,
  add column product_id text,
  add column product_name text;

alter table public.app_events drop constraint valid_instagram_campaign;
alter table public.app_events drop constraint allowed_app_event;
alter table public.app_events add constraint allowed_app_event check (
  (event_type = 'visit' and dimension in ('instagram', 'tiktok', 'other')) or
  (event_type = 'section' and dimension in ('archive', 'add', 'check', 'promotions', 'settings')) or
  (event_type = 'affiliate_click' and dimension = 'awin')
);
alter table public.app_events add constraint valid_campaign check (
  campaign is null or (
    event_type in ('visit', 'affiliate_click')
    and campaign ~ '^[a-z0-9][a-z0-9_-]{0,47}$'
  )
);
alter table public.app_events add constraint valid_session_id check (
  session_id is null or session_id ~ '^[a-f0-9-]{36}$'
);
alter table public.app_events add constraint valid_traffic_source check (
  source is null or (event_type = 'affiliate_click' and source in ('instagram', 'tiktok', 'other'))
);
alter table public.app_events add constraint valid_affiliate_details check (
  (merchant is null and product_id is null and product_name is null) or (
    event_type = 'affiliate_click'
    and merchant is not null and length(merchant) between 1 and 120
    and product_id is not null and length(product_id) between 1 and 120
    and product_name is not null and length(product_name) between 1 and 240
  )
);

grant insert (session_id, source, merchant, product_id, product_name) on public.app_events to anon, authenticated;
create index app_events_session_id_idx on public.app_events (session_id) where session_id is not null;

create or replace function public.dashboard_event_trend(since timestamptz, until_at timestamptz)
returns table(bucket text, visits bigint, instagram bigint, clicks bigint)
language sql stable security invoker set search_path = ''
as $$
  with settings as (
    select case when until_at - since > interval '62 days' then 'month' else 'day' end as unit
  ), buckets as (
    select point, unit
    from settings, lateral generate_series(
      date_trunc(unit, since at time zone 'Europe/Rome'),
      date_trunc(unit, (until_at - interval '1 microsecond') at time zone 'Europe/Rome'),
      case when unit = 'month' then interval '1 month' else interval '1 day' end
    ) point
  )
  select
    to_char(b.point, case when b.unit = 'month' then 'YYYY-MM' else 'YYYY-MM-DD' end),
    count(e.id) filter (where e.event_type = 'visit'),
    count(e.id) filter (where e.event_type = 'visit' and e.dimension = 'instagram'),
    count(e.id) filter (where e.event_type = 'affiliate_click')
  from buckets b
  left join public.app_events e on
    e.recorded_at >= b.point at time zone 'Europe/Rome'
    and e.recorded_at < (b.point + case when b.unit = 'month' then interval '1 month' else interval '1 day' end) at time zone 'Europe/Rome'
    and e.recorded_at >= since and e.recorded_at < until_at
    and e.event_type in ('visit', 'affiliate_click')
  where until_at > since and until_at - since <= interval '367 days'
  group by b.point, b.unit
  order by b.point
$$;

create or replace function public.dashboard_admin_report(since timestamptz, until_at timestamptz)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with period_events as (
    select * from public.app_events
    where recorded_at >= since and recorded_at < until_at
      and until_at > since and until_at - since <= interval '367 days'
  ), summary as (
    select
      count(*) filter (where event_type = 'visit') visits,
      count(*) filter (where event_type = 'visit' and dimension = 'instagram') instagram,
      count(*) filter (where event_type = 'visit' and dimension = 'tiktok') tiktok,
      count(*) filter (where event_type = 'affiliate_click') clicks,
      count(distinct session_id) filter (where event_type = 'visit' and session_id is not null) visit_sessions,
      count(distinct session_id) filter (where event_type = 'affiliate_click' and session_id is not null) click_sessions,
      count(*) filter (where event_type = 'visit' and session_id is null) legacy_visits
    from period_events
  ), section_rows as (
    select dimension name, count(*) total from period_events where event_type = 'section' group by dimension
  ), campaign_rows as (
    select campaign name, case when event_type = 'visit' then dimension else source end source,
      count(*) filter (where event_type = 'visit') visits,
      count(*) filter (where event_type = 'affiliate_click') clicks
    from period_events where campaign is not null
    group by campaign, case when event_type = 'visit' then dimension else source end
  ), store_rows as (
    select merchant name, count(*) clicks
    from period_events where event_type = 'affiliate_click' and merchant is not null
    group by merchant order by clicks desc, merchant limit 20
  ), product_rows as (
    select product_id id, max(product_name) name, max(merchant) merchant, count(*) clicks
    from period_events where event_type = 'affiliate_click' and product_id is not null
    group by product_id order by clicks desc, max(product_name) limit 20
  )
  select jsonb_build_object(
    'visits', s.visits, 'instagram', s.instagram, 'tiktok', s.tiktok, 'clicks', s.clicks,
    'visitSessions', s.visit_sessions, 'clickSessions', s.click_sessions,
    'legacyVisits', s.legacy_visits,
    'sections', coalesce((select jsonb_agg(to_jsonb(x) order by x.total desc) from section_rows x), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc, x.name) from campaign_rows x), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(to_jsonb(x)) from store_rows x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(x)) from product_rows x), '[]'::jsonb)
  ) from summary s
$$;

revoke execute on function public.dashboard_admin_report(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_admin_report(timestamptz, timestamptz) to authenticated;
