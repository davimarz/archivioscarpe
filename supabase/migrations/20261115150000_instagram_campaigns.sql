alter table public.app_events
  add column campaign text,
  add constraint valid_instagram_campaign check (
    campaign is null or (
      event_type = 'visit' and dimension = 'instagram'
      and campaign ~ '^[a-z0-9][a-z0-9_-]{0,47}$'
    )
  );

-- Keep the existing column-level INSERT grants and RLS policies.
grant insert (campaign) on table public.app_events to anon, authenticated;

create or replace function public.dashboard_event_counts(since timestamptz)
returns table(event_type text, dimension text, total bigint)
language sql stable security invoker set search_path = ''
as $$
  select e.event_type, e.dimension, count(*)
  from public.app_events e
  where e.recorded_at >= since
  group by e.event_type, e.dimension
  union all
  select 'instagram_campaign', e.campaign, count(*)
  from public.app_events e
  where e.recorded_at >= since and e.event_type = 'visit'
    and e.dimension = 'instagram' and e.campaign is not null
  group by e.campaign
$$;
