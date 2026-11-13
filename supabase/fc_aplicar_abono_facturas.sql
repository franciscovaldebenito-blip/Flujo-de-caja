-- Apply a cash payment to a scheduled supplier group, oldest invoice due date first.
-- Positive invoice rows are settled FIFO. Negative credit notes reduce the net
-- cash due and are marked paid as part of the same transaction.
create or replace function public.fc_aplicar_abono_facturas(
    p_ids uuid[],
    p_monto numeric
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_factura record;
    v_total_ids integer;
    v_pendientes integer;
    v_total_positivo numeric := 0;
    v_total_credito numeric := 0;
    v_deuda_neta numeric := 0;
    v_por_cubrir numeric := 0;
    v_monto_cubierto numeric := 0;
    v_sobrante numeric := 0;
begin
    if p_ids is null or pg_catalog.cardinality(p_ids) = 0 or pg_catalog.cardinality(p_ids) > 300 then
        raise exception 'Selecciona un grupo válido de facturas para abonar.';
    end if;

    if p_monto is null or p_monto <= 0 then
        raise exception 'Ingresa un monto de abono mayor que cero.';
    end if;

    if pg_catalog.cardinality(p_ids) <> (
        select pg_catalog.count(distinct ids.id)::integer from pg_catalog.unnest(p_ids) as ids(id)
    ) then
        raise exception 'La selección contiene documentos repetidos.';
    end if;

    select
        pg_catalog.count(*)::integer,
        pg_catalog.count(*) filter (where pg_catalog.lower(pg_catalog.coalesce(estado, '')) = 'pendiente')::integer
    into v_total_ids, v_pendientes
    from public.fc_facturas_programadas
    where id = any(p_ids);

    if v_total_ids <> pg_catalog.cardinality(p_ids) or v_pendientes <> pg_catalog.cardinality(p_ids) then
        raise exception 'Una o más facturas ya fueron pagadas o cambiaron. Actualiza el flujo e inténtalo nuevamente.';
    end if;

    select
        pg_catalog.coalesce(pg_catalog.sum(pg_catalog.coalesce(monto_pendiente, 0)) filter (where pg_catalog.coalesce(monto_pendiente, 0) > 0), 0),
        pg_catalog.coalesce(pg_catalog.sum(pg_catalog.coalesce(monto_pendiente, 0)) filter (where pg_catalog.coalesce(monto_pendiente, 0) < 0), 0)
    into v_total_positivo, v_total_credito
    from public.fc_facturas_programadas
    where id = any(p_ids)
      and pg_catalog.lower(pg_catalog.coalesce(estado, '')) = 'pendiente';

    v_deuda_neta := v_total_positivo + v_total_credito;
    if v_total_positivo <= 0 or v_deuda_neta <= 0 then
        raise exception 'Este grupo no tiene una deuda neta positiva para abonar.';
    end if;

    -- A credit note is an offset, so the invoice coverage includes the credit
    -- amount while the net amount recorded as paid remains equal to cash paid.
    v_por_cubrir := pg_catalog.least(v_total_positivo, p_monto - v_total_credito);

    for v_factura in
        select id, numero_doc, proveedor_rut, proveedor_nombre, monto_original,
               pg_catalog.coalesce(monto_pendiente, 0) as monto_pendiente,
               fecha_vencimiento, fecha_pago_programada
        from public.fc_facturas_programadas
        where id = any(p_ids)
          and pg_catalog.lower(pg_catalog.coalesce(estado, '')) = 'pendiente'
          and pg_catalog.coalesce(monto_pendiente, 0) > 0
        order by fecha_vencimiento asc nulls last, created_at asc, numero_doc asc
        for update
    loop
        exit when v_por_cubrir <= 0;

        if v_por_cubrir >= v_factura.monto_pendiente then
            update public.fc_facturas_programadas
            set estado = 'pagado'
            where id = v_factura.id;

            v_por_cubrir := v_por_cubrir - v_factura.monto_pendiente;
            v_monto_cubierto := v_monto_cubierto + v_factura.monto_pendiente;
        else
            update public.fc_facturas_programadas
            set monto_pendiente = v_factura.monto_pendiente - v_por_cubrir
            where id = v_factura.id;

            insert into public.fc_facturas_programadas (
                numero_doc, proveedor_rut, proveedor_nombre, monto_original,
                monto_pendiente, fecha_vencimiento, fecha_pago_programada, estado
            ) values (
                v_factura.numero_doc, v_factura.proveedor_rut, v_factura.proveedor_nombre,
                v_factura.monto_original, v_por_cubrir, v_factura.fecha_vencimiento,
                v_factura.fecha_pago_programada, 'pagado'
            );

            v_monto_cubierto := v_monto_cubierto + v_por_cubrir;
            v_por_cubrir := 0;
        end if;
    end loop;

    -- Settle the selected credit notes in the same atomic transaction.
    update public.fc_facturas_programadas
    set estado = 'pagado'
    where id = any(p_ids)
      and pg_catalog.lower(pg_catalog.coalesce(estado, '')) = 'pendiente'
      and pg_catalog.coalesce(monto_pendiente, 0) < 0;

    v_sobrante := pg_catalog.greatest(0, p_monto - (v_monto_cubierto + v_total_credito));

    return pg_catalog.jsonb_build_object(
        'exito', true,
        'facturas_cubiertas', v_monto_cubierto,
        'credito_aplicado', pg_catalog.abs(v_total_credito),
        'monto_aplicado', v_monto_cubierto + v_total_credito,
        'sobrante', v_sobrante
    );
end;
$$;

revoke all on function public.fc_aplicar_abono_facturas(uuid[], numeric) from public, anon;
grant execute on function public.fc_aplicar_abono_facturas(uuid[], numeric) to authenticated;

notify pgrst, 'reload schema';
