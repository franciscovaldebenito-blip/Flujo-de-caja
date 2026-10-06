-- Cash Flow access: Supabase Auth identities, manually activated profiles,
-- and equal permissions for every active app user.

create table if not exists public.fc_usuarios (
    id uuid primary key references auth.users (id) on delete cascade,
    email text not null unique,
    is_active boolean not null default false,
    created_at timestamptz not null default now()
);

alter table public.fc_usuarios enable row level security;
revoke all on table public.fc_usuarios from public, anon, authenticated;
grant select on table public.fc_usuarios to authenticated;

insert into public.fc_usuarios (id, email, is_active)
select id, lower(email), false from auth.users where email is not null
on conflict (id) do nothing;

do $$
declare v_policy record;
begin
    for v_policy in select policyname from pg_policies where schemaname = 'public' and tablename = 'fc_usuarios' loop
        execute format('drop policy %I on public.fc_usuarios', v_policy.policyname);
    end loop;
end;
$$;

create policy fc_usuarios_read_own_profile
    on public.fc_usuarios for select to authenticated
    using (id = (select auth.uid()));

create or replace function public.fc_is_cashflow_user()
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.fc_usuarios as app_user
        where app_user.id = (select auth.uid()) and app_user.is_active = true
    );
$$;

revoke all on function public.fc_is_cashflow_user() from public, anon;
grant execute on function public.fc_is_cashflow_user() to authenticated;

create or replace function public.fc_create_cashflow_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.fc_usuarios (id, email, is_active)
    values (new.id, lower(new.email), false)
    on conflict (id) do update set email = lower(excluded.email);
    return new;
end;
$$;

revoke all on function public.fc_create_cashflow_profile() from public, anon, authenticated;
drop trigger if exists fc_create_cashflow_profile_after_auth_user on auth.users;
create trigger fc_create_cashflow_profile_after_auth_user
    after insert or update of email on auth.users
    for each row execute function public.fc_create_cashflow_profile();

-- Replace any older policies with this explicit least-privilege set.
do $$
declare
    v_table text;
    v_operations text[];
    v_operation text;
    v_policy record;
begin
    for v_table, v_operations in
        select * from (values
            ('fc_cheques', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]),
            ('fc_cobranza', array['SELECT']::text[]),
            ('fc_facturas_programadas', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]),
            ('fc_facturas_transitorias', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]),
            ('fc_gastos_fijos_catalogo', array['SELECT', 'INSERT']::text[]),
            ('fc_gastos_fijos_programados', array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]),
            ('fc_saldos_facturas', array['SELECT', 'INSERT', 'UPDATE']::text[]),
            ('fc_ventas', array['SELECT', 'INSERT', 'UPDATE']::text[])
        ) as app_tables(table_name, operations)
    loop
        execute format('alter table public.%I enable row level security', v_table);
        execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
        execute format('grant %s on table public.%I to authenticated', array_to_string(v_operations, ', '), v_table);

        for v_policy in select policyname from pg_policies where schemaname = 'public' and tablename = v_table loop
            execute format('drop policy %I on public.%I', v_policy.policyname, v_table);
        end loop;

        foreach v_operation in array v_operations loop
            if v_operation = 'SELECT' then
                execute format('create policy fc_active_select on public.%I for select to authenticated using ((select public.fc_is_cashflow_user()))', v_table);
            elsif v_operation = 'INSERT' then
                execute format('create policy fc_active_insert on public.%I for insert to authenticated with check ((select public.fc_is_cashflow_user()))', v_table);
            elsif v_operation = 'UPDATE' then
                execute format('create policy fc_active_update on public.%I for update to authenticated using ((select public.fc_is_cashflow_user())) with check ((select public.fc_is_cashflow_user()))', v_table);
            elsif v_operation = 'DELETE' then
                execute format('create policy fc_active_delete on public.%I for delete to authenticated using ((select public.fc_is_cashflow_user()))', v_table);
            end if;
        end loop;
    end loop;
end;
$$;

-- Legacy/unused tables remain unavailable through the Supabase Data API.
do $$
declare
    v_table text;
    v_policy record;
begin
    foreach v_table in array array['fc_gastos_fijos', 'fc_pagos_facturas'] loop
        execute format('alter table public.%I enable row level security', v_table);
        execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
        for v_policy in select policyname from pg_policies where schemaname = 'public' and tablename = v_table loop
            execute format('drop policy %I on public.%I', v_policy.policyname, v_table);
        end loop;
    end loop;
end;
$$;
