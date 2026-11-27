drop trigger archivioscarpe_admin_traffic_insert on public.app_events;
drop function public.notify_archivioscarpe_admin_traffic();
drop policy "Archivio Scarpe admin traffic broadcast" on realtime.messages;
alter publication supabase_realtime add table public.app_events;
