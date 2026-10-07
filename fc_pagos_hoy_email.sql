-- Resumen de lectura limitada para el correo diario enviado por Apps Script.
-- Antes de ejecutar: reemplaza HASH_SHA256_GENERADO por el SHA-256 del secreto
-- aleatorio que guardarás en Apps Script como CASHFLOW_EMAIL_SECRET.

create extension if not exists pgcrypto with schema extensions;

create or replace function public.fc_pagos_hoy_email(p_secret text)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
    v_fecha date := (now() at time zone 'America/Santiago')::date;
    v_pagos jsonb;
    v_total numeric;
begin
    if p_secret is null
       or encode(extensions.digest(convert_to(p_secret, 'UTF8'), 'sha256'), 'hex') <> 'a830f06b5544f4fa780a98797a6b014ecab8326af54962b4d80199c8274fb0e2' then
        raise exception 'No autorizado' using errcode = '42501';
    end if;

    select
        coalesce(jsonb_agg(jsonb_build_object(
            'tipo', p.tipo,
            'proveedor', p.proveedor,
            'detalle', p.detalle,
            'monto', p.monto
        ) order by p.tipo, p.proveedor, p.detalle), '[]'::jsonb),
        coalesce(sum(p.monto), 0)
    into v_pagos, v_total
    from (
        select
            'Cheque'::text as tipo,
            coalesce(c.proveedor, 'Sin proveedor')::text as proveedor,
            case when nullif(c.numero_cheque, '') is null then 'Cheque'
                 else 'Cheque N° ' || c.numero_cheque end as detalle,
            coalesce(c.monto, 0)::numeric as monto
        from public.fc_cheques c
        where c.fecha = v_fecha and lower(coalesce(c.estado, '')) = 'pendiente'

        union all

        select
            'Proveedor'::text,
            coalesce(f.proveedor_nombre, 'Sin proveedor')::text,
            case when nullif(f.numero_doc, '') is null then 'Factura'
                 else 'Factura N° ' || f.numero_doc end,
            coalesce(f.monto_pendiente, 0)::numeric
        from public.fc_facturas_programadas f
        where f.fecha_pago_programada = v_fecha and lower(coalesce(f.estado, '')) = 'pendiente'

        union all

        select
            'Gasto fijo'::text,
            coalesce(g.concepto, 'Gasto fijo')::text,
            coalesce(g.concepto, 'Gasto fijo')::text,
            coalesce(g.monto, 0)::numeric
        from public.fc_gastos_fijos_programados g
        where g.fecha_pago_programada = v_fecha and lower(coalesce(g.estado, '')) = 'pendiente'
    ) p;

    return jsonb_build_object(
        'fecha', v_fecha,
        'zona_horaria', 'America/Santiago',
        'pagos', v_pagos,
        'total', v_total
    );
end;
$$;

revoke all on function public.fc_pagos_hoy_email(text) from public;
grant execute on function public.fc_pagos_hoy_email(text) to anon, authenticated;

notify pgrst, 'reload schema';
