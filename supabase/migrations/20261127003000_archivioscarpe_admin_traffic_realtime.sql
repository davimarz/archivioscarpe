create policy "Archivio Scarpe admin traffic broadcast" on realtime.messages
for select to authenticated
using (
  realtime.topic() = 'archivioscarpe-admin-traffic'
  and exists (select 1 from public.admin_access where id = 1)
);

create function public.notify_archivioscarpe_admin_traffic()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send('{}'::jsonb, 'traffic_changed', 'archivioscarpe-admin-traffic', true);
  return new;
exception when others then
  raise warning 'Archivio Scarpe traffic broadcast failed: %', sqlstate;
  return new;
end;
$$;

revoke execute on function public.notify_archivioscarpe_admin_traffic() from public, anon, authenticated;

create trigger archivioscarpe_admin_traffic_insert
after insert on public.app_events
for each row
when (new.event_type in ('visit', 'affiliate_click'))
execute function public.notify_archivioscarpe_admin_traffic();
