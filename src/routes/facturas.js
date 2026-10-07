import { Router } from 'express';
import multer from 'multer';
import exceljs from 'exceljs';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

async function obtenerTodasLasFilas(crearConsulta) {
    const filas = [];
    const tamanoLote = 1000;
    let desde = 0;

    while (true) {
        const { data, error } = await crearConsulta().range(desde, desde + tamanoLote - 1);
        if (error) throw error;
        filas.push(...(data || []));
        if (!data || data.length < tamanoLote) break;
        desde += tamanoLote;
    }

    return filas;
}

router.get('/resumen-proveedores', async (req, res) => {
    try {
        const anio = Number.parseInt(req.query.anio, 10);
        if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
            return res.status(400).json({ exito: false, error: 'Año inválido.' });
        }

        const [programadas, transitorias, saldos] = await Promise.all([
            obtenerTodasLasFilas(() => req.supabase
                .from('fc_facturas_programadas')
                .select('proveedor_rut, proveedor_nombre, numero_doc, monto_pendiente, fecha_pago_programada, estado')
                .gte('fecha_pago_programada', `${anio}-01-01`)
                .lte('fecha_pago_programada', `${anio}-12-31`)),
            obtenerTodasLasFilas(() => req.supabase
                .from('fc_facturas_transitorias')
                .select('proveedor_rut, proveedor_nombre, numero_doc, saldo, created_at')
                .order('created_at', { ascending: true })),
            obtenerTodasLasFilas(() => req.supabase
                .from('fc_saldos_facturas')
                .select('proveedor_rut, numero_doc, saldo_pendiente'))
        ]);

        const proveedores = new Map();
        const obtenerProveedor = (rut, nombre) => {
            const rutLimpio = String(rut || '').trim();
            const nombreLimpio = String(nombre || '').trim();
            if (!rutLimpio && !nombreLimpio) return null;
            const clave = rutLimpio
                ? `rut:${rutLimpio.toLowerCase()}`
                : `nombre:${nombreLimpio.toLowerCase()}`;

            if (!proveedores.has(clave)) {
                proveedores.set(clave, {
                    proveedor_rut: rutLimpio,
                    proveedor_nombre: nombreLimpio || rutLimpio || 'Proveedor sin nombre',
                    meses: Array(12).fill(0),
                    no_programado: 0
                });
            } else if (nombreLimpio) {
                proveedores.get(clave).proveedor_nombre = nombreLimpio;
            }

            return proveedores.get(clave);
        };

        for (const item of programadas) {
            if (String(item.estado || 'pendiente').toLowerCase() !== 'pendiente') continue;
            const fecha = String(item.fecha_pago_programada || '').slice(0, 10);
            const mes = Number.parseInt(fecha.slice(5, 7), 10);
            if (!Number.isInteger(mes) || mes < 1 || mes > 12) continue;
            const proveedor = obtenerProveedor(item.proveedor_rut, item.proveedor_nombre);
            if (proveedor) proveedor.meses[mes - 1] += Number(item.monto_pendiente || 0);
        }

        const llaveFactura = (rut, numeroDoc) => {
            const doc = String(numeroDoc || '').trim();
            if (!doc) return null;
            const identificador = String(rut || '').trim().toLowerCase();
            return `${identificador}|${doc.toLowerCase()}`;
        };
        const facturas = new Map();

        // La transitoria aporta nombre y saldo inicial; created_at permite
        // conservar la fila más reciente si el documento aparece más de una vez.
        for (const item of transitorias) {
            const llave = llaveFactura(item.proveedor_rut, item.numero_doc);
            if (!llave) continue;
            facturas.set(llave, {
                proveedor_rut: item.proveedor_rut,
                proveedor_nombre: item.proveedor_nombre,
                numero_doc: item.numero_doc,
                saldo: Number(item.saldo || 0)
            });
        }

        // Cuando existe, el saldo guardado es el remanente después de programar abonos.
        for (const item of saldos) {
            const llave = llaveFactura(item.proveedor_rut, item.numero_doc);
            if (!llave) continue;
            const factura = facturas.get(llave) || {
                proveedor_rut: item.proveedor_rut,
                proveedor_nombre: '',
                numero_doc: item.numero_doc,
                saldo: 0
            };
            factura.saldo = Number(item.saldo_pendiente || 0);
            facturas.set(llave, factura);
        }

        for (const factura of facturas.values()) {
            if (factura.saldo <= 0) continue;
            const proveedor = obtenerProveedor(factura.proveedor_rut, factura.proveedor_nombre);
            if (proveedor) proveedor.no_programado += factura.saldo;
        }

        const resultado = Array.from(proveedores.values())
            .map(proveedor => ({
                ...proveedor,
                total_programado: proveedor.meses.reduce((total, monto) => total + monto, 0),
                total_pendiente: proveedor.meses.reduce((total, monto) => total + monto, proveedor.no_programado)
            }))
            .filter(proveedor => proveedor.total_pendiente > 0)
            .sort((a, b) => b.total_pendiente - a.total_pendiente || a.proveedor_nombre.localeCompare(b.proveedor_nombre, 'es'));

        res.json({ exito: true, anio, proveedores: resultado });
    } catch (error) {
        console.error('Error al generar resumen de proveedores:', error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

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
