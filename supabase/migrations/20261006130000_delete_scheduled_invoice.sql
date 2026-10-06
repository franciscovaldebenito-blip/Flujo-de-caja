-- Atomically remove a scheduled invoice and restore its pending balance.
-- The security-invoker function remains subject to the caller's RLS policies.
create or replace function public.fc_eliminar_factura_programada(p_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_factura public.fc_facturas_programadas%rowtype;
begin
    delete from public.fc_facturas_programadas
    where id = p_id
    returning * into v_factura;

    if not found then
        return pg_catalog.jsonb_build_object(
            'exito', false,
            'error', 'No se encontró la factura programada.'
        );
    end if;

    if pg_catalog.lower(coalesce(v_factura.estado, '')) <> 'pagado' then
        insert into public.fc_saldos_facturas (
            numero_doc,
            proveedor_rut,
            saldo_pendiente,
            updated_at
        ) values (
            v_factura.numero_doc,
            v_factura.proveedor_rut,
            coalesce(v_factura.monto_pendiente, 0),
            pg_catalog.now()
        )
        on conflict (proveedor_rut, numero_doc)
        do update set
            saldo_pendiente = coalesce(fc_saldos_facturas.saldo_pendiente, 0)
                + coalesce(excluded.saldo_pendiente, 0),
            updated_at = pg_catalog.now();
    end if;

    return pg_catalog.jsonb_build_object(
        'exito', true,
        'mensaje', 'Factura eliminada correctamente.',
        'saldo_restaurado', pg_catalog.lower(coalesce(v_factura.estado, '')) <> 'pagado'
    );
end;
$$;

revoke all on function public.fc_eliminar_factura_programada(uuid) from public, anon;
grant execute on function public.fc_eliminar_factura_programada(uuid) to authenticated;

notify pgrst, 'reload schema';
