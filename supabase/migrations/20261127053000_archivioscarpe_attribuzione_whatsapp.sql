alter table public.app_events drop constraint if exists allowed_app_event;
alter table public.app_events add constraint allowed_app_event check (
  (event_type = 'visit' and dimension in ('instagram', 'facebook', 'threads', 'tiktok', 'whatsapp', 'other')) or
  (event_type = 'section' and dimension in ('archive', 'add', 'check', 'promotions', 'settings')) or
  (event_type = 'affiliate_click' and dimension = 'awin')
);

alter table public.app_events drop constraint if exists valid_traffic_source;
alter table public.app_events add constraint valid_traffic_source check (
  source is null or (event_type = 'affiliate_click' and source in ('instagram', 'facebook', 'threads', 'tiktok', 'whatsapp', 'other'))
);

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
      count(*) filter (where event_type = 'visit' and dimension = 'facebook') facebook,
      count(*) filter (where event_type = 'visit' and dimension = 'threads') threads,
      count(*) filter (where event_type = 'visit' and dimension = 'tiktok') tiktok,
      count(*) filter (where event_type = 'visit' and dimension = 'whatsapp') whatsapp,
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
    'visits', s.visits, 'instagram', s.instagram, 'facebook', s.facebook, 'tiktok', s.tiktok, 'threads', s.threads, 'whatsapp', s.whatsapp, 'clicks', s.clicks,
    'visitSessions', s.visit_sessions, 'clickSessions', s.click_sessions,
    'legacyVisits', s.legacy_visits,
    'sections', coalesce((select jsonb_agg(to_jsonb(x) order by x.total desc) from section_rows x), '[]'::jsonb),
    'campaigns', coalesce((select jsonb_agg(to_jsonb(x) order by x.visits desc, x.name) from campaign_rows x), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(to_jsonb(x)) from store_rows x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(x)) from product_rows x), '[]'::jsonb)
  ) from summary s
$$;
