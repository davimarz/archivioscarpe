create or replace function public.dashboard_event_trend(since timestamptz, until_at timestamptz)
returns table(bucket text, visits bigint, instagram bigint, clicks bigint)
language sql stable security invoker set search_path = ''
as $$
  select
    case when until_at - since > interval '62 days'
      then to_char(e.recorded_at at time zone 'Europe/Rome', 'YYYY-MM')
      else to_char(e.recorded_at at time zone 'Europe/Rome', 'YYYY-MM-DD')
    end as bucket,
    count(*) filter (where e.event_type = 'visit'),
    count(*) filter (where e.event_type = 'visit' and e.dimension = 'instagram'),
    count(*) filter (where e.event_type = 'affiliate_click')
  from public.app_events e
  where until_at > since and until_at - since <= interval '367 days'
    and e.recorded_at >= since and e.recorded_at < until_at
    and e.event_type in ('visit', 'affiliate_click')
  group by 1
  order by 1
$$;

revoke execute on function public.dashboard_event_trend(timestamptz, timestamptz) from public, anon;
grant execute on function public.dashboard_event_trend(timestamptz, timestamptz) to authenticated;
