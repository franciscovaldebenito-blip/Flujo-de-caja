import express from 'express';

const router = express.Router();

// 1. Obtener lista base de Gastos Fijos (Catálogo)
router.get('/catalogo', async (req, res) => {
    try {
        const { data, error } = await req.supabase
            .from('fc_gastos_fijos_catalogo')
            .select('*')
            .order('concepto', { ascending: true });

        if (error) throw error;
        res.json(data || []);
    } catch (err) {
        console.error('Error al buscar catálogo de gastos fijos:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 2. Obtener gastos fijos programados por mes (Tanto 'pendiente' como 'pagado')
router.get('/programados', async (req, res) => {
    try {
        const { mes, anio } = req.query; // Puede recibir 'mes', 'anio' o formato 'YYYY-MM'
        let query = req.supabase.from('fc_gastos_fijos_programados').select('*');

        if (mes) {
            let anioConsulta = anio ? parseInt(anio) : new Date().getFullYear();
            let numMes = parseInt(mes);

            // Manejo de formato 'YYYY-MM' si se pasa directamente en el parámetro mes
            if (typeof mes === 'string' && mes.includes('-')) {
                const partes = mes.split('-');
                anioConsulta = parseInt(partes[0]);
                numMes = parseInt(partes[1]);
            }

            const mesFormateado = numMes.toString().padStart(2, '0');
            
            // Calcular exactamente el último día del mes
            const ultimoDia = new Date(anioConsulta, numMes, 0).getDate();

            const inicioMes = `${anioConsulta}-${mesFormateado}-01`;
            const finMes = `${anioConsulta}-${mesFormateado}-${String(ultimoDia).padStart(2, '0')}`;

            query = query.gte('fecha_pago_programada', inicioMes)
                         .lte('fecha_pago_programada', finMes);
        }

        // Ordenar cronológicamente por fecha programada
        const { data, error } = await query.order('fecha_pago_programada', { ascending: true });
        if (error) throw error;

        res.json(data || []);
    } catch (err) {
        console.error('Error al obtener gastos programados:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 3. Agregar un nuevo concepto al catálogo base
router.post('/catalogo', async (req, res) => {
    try {
        const { concepto, monto_promedio } = req.body;
        const { data, error } = await req.supabase
            .from('fc_gastos_fijos_catalogo')
            .insert([{ concepto, monto_promedio }]);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Concepto agregado al catálogo.', datos: data });
    } catch (err) {
        console.error('Error al agregar gasto al catálogo:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 4. Programar un lote de gastos fijos en el flujo de caja
router.post('/programar', async (req, res) => {
    try {
        const { gastos } = req.body; // Se espera un arreglo de gastos

        if (!gastos || !gastos.length) {
            return res.status(400).json({ exito: false, error: 'No se enviaron gastos para programar.' });
        }

        const gastosValidos = gastos.filter(g =>
            g && typeof g.concepto === 'string' && g.concepto.trim() &&
            Number.isFinite(Number(g.monto)) && Number(g.monto) > 0 &&
            /^\d{4}-\d{2}-\d{2}$/.test(g.fecha_pago_programada || '')
        );

        if (!gastosValidos.length) {
            return res.status(400).json({ exito: false, error: 'Revisa que cada gasto tenga concepto, monto mayor a cero y fecha válida.' });
        }

        const actualizaciones = gastosValidos.filter(g => g.id);
        const nuevos = gastosValidos.filter(g => !g.id).map(g => ({
            concepto: g.concepto.trim(),
            monto: Number(g.monto),
            fecha_pago_programada: g.fecha_pago_programada,
            estado: 'pendiente'
        }));

        const datosGuardados = [];
        for (const gasto of actualizaciones) {
            const { data, error } = await req.supabase
                .from('fc_gastos_fijos_programados')
                .update({
                    monto: Number(gasto.monto),
                    fecha_pago_programada: gasto.fecha_pago_programada
                })
                .eq('id', gasto.id)
                .eq('estado', 'pendiente')
                .select('id, concepto, monto, fecha_pago_programada, estado')
                .maybeSingle();

            if (error) throw error;
            if (!data) {
                return res.status(409).json({
                    exito: false,
                    error: `No se pudo modificar “${gasto.concepto}”. Puede que ya esté pagado o que haya cambiado mientras editabas.`
                });
            }
            datosGuardados.push(data);
        }

        if (nuevos.length) {
            const { data, error } = await req.supabase
                .from('fc_gastos_fijos_programados')
                .insert(nuevos)
                .select('id, concepto, monto, fecha_pago_programada, estado');

            if (error) throw error;
            datosGuardados.push(...(data || []));
        }

        const cantidadActualizada = datosGuardados.filter(g => actualizaciones.some(a => a.id === g.id)).length;
        const cantidadNueva = datosGuardados.length - cantidadActualizada;
        res.json({
            exito: true,
            mensaje: `Programación guardada: ${cantidadActualizada} actualizada(s) y ${cantidadNueva} nueva(s).`,
            datos: datosGuardados
        });
    } catch (err) {
        console.error('Error al programar gastos fijos:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 5. Actualizar fecha y/o monto de un gasto fijo (Reagendar / Editar)
router.post('/reagendar', async (req, res) => {
    try {
        const { id, fecha, monto } = req.body;
        const updateData = {};
        if (fecha) updateData.fecha_pago_programada = fecha;
        if (monto !== undefined) updateData.monto = monto;

        const { error } = await req.supabase
            .from('fc_gastos_fijos_programados')
            .update(updateData)
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Gasto fijo actualizado con éxito.' });
    } catch (err) {
        console.error('Error al reagendar gasto fijo:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 6. Marcar gasto fijo como pagado
router.post('/pagar/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await req.supabase
            .from('fc_gastos_fijos_programados')
            .update({ estado: 'pagado' })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Gasto fijo marcado como pagado.' });
    } catch (err) {
        console.error('Error al pagar gasto fijo:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 7. Eliminar gasto fijo del flujo de caja
router.delete('/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await req.supabase
            .from('fc_gastos_fijos_programados')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Gasto fijo eliminado del flujo.' });
    } catch (err) {
        console.error('Error al eliminar gasto fijo:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

export default router;
