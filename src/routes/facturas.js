import { Router } from 'express';
import multer from 'multer';
import exceljs from 'exceljs';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Helper para convertir fechas de Excel (serial o string DD-MM-YYYY) a ISO (YYYY-MM-DD)
function formatearFecha(valor) {
    if (!valor) return null;
    if (valor instanceof Date) return valor.toISOString().split('T')[0];
    
    if (typeof valor === 'string') {
        const partes = valor.split(/[-/]/);
        if (partes.length === 3) {
            return `${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
        }
    }
    return null;
}

// 1. CARGAR EXCEL A LA TABLA TRANSITORIA
router.post('/upload-excel', upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

        const workbook = new exceljs.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const worksheet = workbook.worksheets[0];

        const filas = [];
        
        worksheet.eachRow((row, rowNumber) => {
            if (rowNumber === 1) return;

            const concepto = row.getCell(1).value?.toString() || '';
            const proveedor_rut = row.getCell(2).value?.toString() || '';
            const proveedor_nombre = row.getCell(3).value?.toString() || '';
            const tipo_comp = row.getCell(4).value?.toString() || '';
            const tipo_doc = row.getCell(5).value?.toString() || '';
            const numero_doc = row.getCell(6).value?.toString() || '';
            const fecha_emision = formatearFecha(row.getCell(7).value);
            const fecha_vencimiento = formatearFecha(row.getCell(8).value);
            const voucher = row.getCell(9).value?.toString() || '';
            const referencia = row.getCell(10).value?.toString() || '';
            const dias = parseInt(row.getCell(11).value) || 0;
            const debe = parseFloat(row.getCell(12).value) || 0;
            const haber = parseFloat(row.getCell(13).value) || 0;
            const saldo = parseFloat(row.getCell(14).value) || 0;

            if (proveedor_rut && numero_doc) {
                filas.push({
                    concepto,
                    proveedor_rut,
                    proveedor_nombre,
                    tipo_comp,
                    tipo_doc,
                    numero_doc,
                    fecha_emision,
                    fecha_vencimiento,
                    voucher,
                    referencia,
                    dias,
                    debe,
                    haber,
                    saldo
                });
            }
        });

        await req.supabase.from('fc_facturas_transitorias').delete().neq('id', '00000000-0000-0000-0000-000000000000');

        const { data, error } = await req.supabase.from('fc_facturas_transitorias').insert(filas);
        if (error) throw error;

        res.json({ mensaje: 'Excel procesado e insertado correctamente', registros: filas.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Elimina una factura programada y, si sigue pendiente, devuelve el monto
// comprometido al saldo de la factura dentro de una sola transacción.
router.delete('/:id', async (req, res) => {
    try {
        const { data, error } = await req.supabase.rpc('fc_eliminar_factura_programada', {
            p_id: req.params.id
        });

        if (error) throw error;
        if (!data?.exito) return res.status(404).json(data || { error: 'No se encontró la factura programada.' });
        res.json(data);
    } catch (err) {
        console.error('Error al eliminar factura programada:', err);
        res.status(500).json({ error: err.message || 'No se pudo eliminar la factura programada.' });
    }
});

// 2. BUSCAR FACTURAS PENDIENTES DE UN PROVEEDOR
router.get('/pendientes/:rut', async (req, res) => {
    try {
        const { rut } = req.params;

        const { data: transitorias, error: errTrans } = await req.supabase
            .from('fc_facturas_transitorias')
            .select('*')
            .eq('proveedor_rut', rut);

        if (errTrans) throw errTrans;

        const { data: saldos, error: errSaldos } = await req.supabase
            .from('fc_saldos_facturas')
            .select('*')
            .eq('proveedor_rut', rut);

        if (errSaldos) throw errSaldos;

        const mapSaldos = new Map((saldos || []).map(s => [String(s.numero_doc), Number(s.saldo_pendiente)]));

        const facturasDisponibles = (transitorias || [])
            .map(f => {
                const docStr = String(f.numero_doc);
                const saldoActual = mapSaldos.has(docStr) ? mapSaldos.get(docStr) : Number(f.saldo !== undefined ? f.saldo : f.monto || 0);
                return {
                    ...f,
                    saldo: saldoActual
                };
            })
            .filter(f => f.saldo > 0);

        res.json(facturasDisponibles);
    } catch (err) {
        console.error('Error al obtener pendientes:', err);
        res.status(500).json({ error: err.message });
    }
});

// 3. PASAR FACTURAS/ABONOS SELECCIONADOS AL FLUJO DE CAJA (SIN FACTURA_ID)
router.post('/programar', async (req, res) => {
    try {
        const { facturas, fecha_pago_programada, monto_abono } = req.body;

        if (!facturas || !facturas.length || !fecha_pago_programada) {
            return res.status(400).json({ error: 'Faltan parámetros requeridos.' });
        }

        const totalDeudaSeleccionada = facturas.reduce((sum, f) => sum + Number(f.saldo !== undefined ? f.saldo : f.monto || 0), 0);
        const montoEfectivoPago = (monto_abono && Number(monto_abono) > 0) ? Number(monto_abono) : totalDeudaSeleccionada;

        let montoRestantePorDistribuir = montoEfectivoPago;

        for (const factura of facturas) {
            const saldoActual = Number(factura.saldo !== undefined ? factura.saldo : factura.monto || 0);
            if (montoRestantePorDistribuir <= 0) break;

            const montoCubierto = Math.min(saldoActual, montoRestantePorDistribuir);
            const nuevoSaldo = saldoActual - montoCubierto;

            // Inserción limpia a fc_facturas_programadas
            const { error: errInsert } = await req.supabase
                .from('fc_facturas_programadas')
                .insert({
                    numero_doc: factura.numero_doc,
                    proveedor_rut: factura.proveedor_rut,
                    proveedor_nombre: factura.proveedor_nombre,
                    monto_original: factura.monto || saldoActual,
                    monto_pendiente: montoCubierto,
                    fecha_vencimiento: factura.fecha_vencimiento,
                    fecha_pago_programada: fecha_pago_programada,
                    estado: 'pendiente'
                });

            if (errInsert) throw errInsert;

            // Actualización de saldos
            const { error: errSaldo } = await req.supabase
                .from('fc_saldos_facturas')
                .upsert({
                    numero_doc: String(factura.numero_doc),
                    proveedor_rut: factura.proveedor_rut,
                    saldo_pendiente: nuevoSaldo,
                    updated_at: new Date()
                }, { onConflict: 'proveedor_rut,numero_doc' });

            if (errSaldo) throw errSaldo;

            montoRestantePorDistribuir -= montoCubierto;
        }

        res.json({
            exito: true,
            mensaje: `Factura(s) programada(s) correctamente por $${montoEfectivoPago.toLocaleString('es-CL')}`
        });
    } catch (err) {
        console.error('Error al programar pago:', err);
        res.status(500).json({ error: err.message });
    }
});

// 4. BUSCADOR DE PROVEEDORES
router.get('/buscar-proveedor', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q || q.trim() === '') return res.json([]);

        const termino = q.trim();

        const { data, error } = await req.supabase
            .from('fc_facturas_transitorias')
            .select('proveedor_rut, proveedor_nombre')
            .or(`proveedor_nombre.ilike.%${termino}%,proveedor_rut.ilike.%${termino}%`)
            .limit(15);

        if (error) {
            console.error('Error Supabase al buscar proveedor:', error);
            return res.status(500).json({ error: error.message });
        }

        const unicos = [];
        const rutsProcesados = new Set();

        if (data) {
            for (const item of data) {
                if (item.proveedor_rut && !rutsProcesados.has(item.proveedor_rut)) {
                    rutsProcesados.add(item.proveedor_rut);
                    unicos.push(item);
                }
            }
        }

        res.json(unicos);
    } catch (err) {
        console.error('Error en /buscar-proveedor:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// 5. OBTENER DATOS DE LA MATRIZ DE FLUJO DE CAJA (Facturas + Cheques + Gastos Fijos)
router.get('/matriz', async (req, res) => {
    try {
        // ✅ Traemos TODAS las facturas programadas (tanto pendientes como pagadas)
        const { data: programadas, error } = await req.supabase
            .from('fc_facturas_programadas')
            .select('*');

        if (error) throw error;

        // ✅ Traemos TODOS los cheques (tanto pendientes como pagados)
        const { data: cheques, error: errCheq } = await req.supabase
            .from('fc_cheques')
            .select('*');

        if (errCheq) console.error('Error al cargar cheques:', errCheq);

        // ✅ Traemos TODOS los gastos fijos (tanto pendientes como pagados)
        const { data: gastosFijos, error: errGF } = await req.supabase
            .from('fc_gastos_fijos_programados')
            .select('*');

        if (errGF) console.error('Error al cargar gastos fijos:', errGF);

        res.json({
            programadas: programadas || [],
            cheques: cheques || [],
            gastosFijos: gastosFijos || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
