drop function if exists public.dashboard_event_trend(timestamptz, timestamptz);
create function public.dashboard_event_trend(since timestamptz, until_at timestamptz)
returns table(bucket text, visits bigint, instagram bigint, facebook bigint, tiktok bigint, other bigint, clicks bigint)
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
    count(e.id) filter (where e.event_type = 'visit' and e.dimension = 'facebook'),
    count(e.id) filter (where e.event_type = 'visit' and e.dimension = 'tiktok'),
    count(e.id) filter (where e.event_type = 'visit' and e.dimension = 'other'),
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

revoke execute on function public.dashboard_event_trend(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_event_trend(timestamptz, timestamptz) to authenticated;
