import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { supabase } from './src/config/supabase.js';

// Importación de rutas modulares
import rutasFacturas from './src/routes/facturas.js';
import rutasGastosFijos from './src/routes/gastosfijos.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Vinculación de routers principales
app.use('/api/facturas', rutasFacturas);
app.use('/api/gastos-fijos', rutasGastosFijos);

// --- FUNCIONES DE UTILIDAD ---

// Función para formatear fechas de DD/MM/YYYY a YYYY-MM-DD
function formatearFechaSupabase(fechaRaw) {
    if (!fechaRaw) return null;
    const partes = fechaRaw.trim().split('/');
    if (partes.length === 3) {
        const dia = partes[0].padStart(2, '0');
        const mes = partes[1].padStart(2, '0');
        let anio = partes[2];
        if (anio.length === 2) anio = `20${anio}`;
        return `${anio}-${mes}-${dia}`;
    }
    return null;
}

// Función para limpiar y convertir montos con formato $X.XXX.XXX o X,XXX.XX
function limpiarMonto(montoRaw) {
    if (!montoRaw) return 0;
    let texto = String(montoRaw).replace(/[^0-9.,-]/g, '').trim();
    if (texto.includes('.')) {
        texto = texto.replace(/\./g, '');
    }
    texto = texto.replace(',', '.');
    return Number(texto) || 0;
}

// --- ENDPOINTS DE CHEQUES Y SINCRONIZACIÓN CON GOOGLE SHEETS ---

app.post('/api/cheques/sincronizar', async (req, res) => {
    try {
        const SPREADSHEET_ID = '119JK275gEhwDr-N5ea_vFuftC7Wqc49iQGuN-fcfHYU';
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || './google-credentials.json',
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });
        const sheets = google.sheets({ version: 'v4', auth });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'A2:D',
        });
        const filas = response.data.values;
        if (!filas || filas.length === 0) {
            return res.json({ exito: true, mensaje: 'No se encontraron registros en la planilla.', total: 0 });
        }

        const chequesMap = new Map();
        filas.forEach(fila => {
            const fechaFormat = formatearFechaSupabase(fila[0]);
            const proveedor = (fila[1] || '').trim();
            const numeroCheque = (fila[2] || '').trim();
            const montoCalculado = limpiarMonto(fila[3]);

            if (fechaFormat && proveedor && numeroCheque) {
                const claveUnica = `${proveedor.toLowerCase()}_${numeroCheque.toLowerCase()}`;
                chequesMap.set(claveUnica, {
                    fecha: fechaFormat,
                    proveedor: proveedor,
                    numero_cheque: numeroCheque,
                    monto: montoCalculado
                });
            }
        });

        const chequesDePlanilla = Array.from(chequesMap.values());

        // Recuperar estados actuales para que la sincronización no reactive cheques pagados.
        const estadosExistentes = new Map();
        const claveEstadoCheque = cheque => `${cheque.proveedor}_${cheque.numero_cheque}`;
        const clavesPlanilla = new Set(chequesDePlanilla.map(claveEstadoCheque));
        let desde = 0;
        const paso = 1000;
        let hayMas = true;

        while (hayMas) {
            const { data, error } = await supabase
                .from('fc_cheques')
                .select('proveedor, numero_cheque, estado')
                .order('proveedor', { ascending: true })
                .order('numero_cheque', { ascending: true })
                .range(desde, desde + paso - 1);

            if (error) throw error;
            (data || []).forEach(cheque => {
                const clave = `${cheque.proveedor}_${cheque.numero_cheque}`;
                if (clavesPlanilla.has(clave)) estadosExistentes.set(clave, cheque.estado);
            });

            hayMas = (data || []).length === paso;
            desde += paso;
        }

        const chequesProcesados = chequesDePlanilla.map(cheque => {
            const clave = claveEstadoCheque(cheque);
            return { ...cheque, estado: estadosExistentes.has(clave) ? estadosExistentes.get(clave) : 'pendiente' };
        });

        const { error: errorUpsert } = await supabase
            .from('fc_cheques')
            .upsert(chequesProcesados, { onConflict: 'proveedor,numero_cheque' });

        if (errorUpsert) throw errorUpsert;

        res.json({
            exito: true,
            mensaje: `Se sincronizaron correctamente ${chequesProcesados.length} cheques; se conservaron los estados existentes y los nuevos quedaron pendientes.`,
            total: chequesProcesados.length
        });
    } catch (error) {
        console.error('Error al procesar/guardar cheques en Supabase:', error);
        res.status(500).json({ 
            exito: false, 
            error: error.message || 'Error al procesar y guardar los cheques.' 
        });
    }
});

app.get('/api/cheques/resumen-hoy', async (req, res) => {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        const { data, error } = await supabase
            .from('fc_cheques')
            .select('monto')
            .eq('fecha', hoy)
            .eq('estado', 'pendiente');

        if (error) throw error;

        const totalMontoHoy = (data || []).reduce((acc, item) => acc + (Number(item.monto) || 0), 0);

        res.json({
            exito: true,
            fecha: hoy,
            total_cheques: data.length,
            monto_total_hoy: totalMontoHoy
        });
    } catch (error) {
        console.error('Error al obtener el resumen de cheques:', error);
        res.status(500).json({ 
            exito: false, 
            error: error.message || 'Error al obtener resumen de cheques.' 
        });
    }
});

app.post('/api/cheques/reagendar', async (req, res) => {
    try {
        const { id, fecha } = req.body;
        const { error } = await supabase
            .from('fc_cheques')
            .update({ fecha: fecha })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Fecha de cheque actualizada correctamente.' });
    } catch (err) {
        console.error('Error al reagendar cheque:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

app.post('/api/cheques/pagar/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('fc_cheques')
            .update({ estado: 'pagado' })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Cheque marcado como pagado.' });
    } catch (err) {
        console.error('Error al pagar cheque:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

app.delete('/api/cheques/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('fc_cheques')
            .delete()
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Cheque eliminado.' });
    } catch (err) {
        console.error('Error al eliminar cheque:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// --- ENDPOINTS DE VENTAS ---

app.get('/api/ventas/resumen-mensual/:anio', async (req, res) => {
    try {
        const { anio } = req.params;

        const { data, error } = await supabase
            .from('fc_ventas')
            .select('vencimiento_date, monto_total')
            .gte('vencimiento_date', `${anio}-01-01`)
            .lte('vencimiento_date', `${anio}-12-31`);

        if (error) throw error;

        const totalesPorMes = Array(12).fill(0);

        (data || []).forEach(item => {
            if (item.vencimiento_date) {
                // Extracción directa de mes para evitar desfasamiento por zona horaria UTC
                const partes = item.vencimiento_date.split('-');
                if (partes.length >= 2) {
                    const mesIndex = parseInt(partes[1], 10) - 1; // 0 = Ene, 11 = Dic
                    const monto = parseFloat(item.monto_total) || 0;
                    if (mesIndex >= 0 && mesIndex < 12) {
                        totalesPorMes[mesIndex] += monto;
                    }
                }
            }
        });

        res.json({ exito: true, datos: totalesPorMes });
    } catch (err) {
        console.error('Error al obtener ventas:', err);
        res.status(500).json({ exito: false, error: err.message });
    }
});

app.post('/api/ventas/cargar-excel', async (req, res) => {
    try {
        const { ventas } = req.body;

        if (!ventas || ventas.length === 0) {
            return res.status(400).json({ exito: false, error: 'No hay datos de ventas para cargar.' });
        }

        const { data, error } = await supabase
            .from('fc_ventas')
            .insert(ventas);

        if (error) throw error;

        res.json({
            exito: true,
            insertados: ventas.length
        });
    } catch (error) {
        console.error('Error al insertar ventas:', error);
        res.status(500).json({ exito: false, error: error.message });
    }
});

// --- RESUMEN GENERAL Y SALUD DE LA API ---

app.get('/api/resumen-mensual', async (req, res) => {
    try {
        const { anio } = req.query;
        const anioConsulta = anio || new Date().getFullYear();

        // 1. Obtener ventas en lotes
        let todasLasVentas = [];
        let desdeVentas = 0;
        let paso = 1000;
        let masVentas = true;

        while (masVentas) {
            const { data: loteVentas, error: errVentas } = await supabase
                .from('fc_ventas')
                .select('*')
                .gte('vencimiento', `${anioConsulta}-01-01`)
                .lte('vencimiento', `${anioConsulta}-12-31`)
                .range(desdeVentas, desdeVentas + paso - 1);

            if (errVentas) throw errVentas;

            if (loteVentas && loteVentas.length > 0) {
                todasLasVentas.push(...loteVentas);
                desdeVentas += paso;
                if (loteVentas.length < paso) masVentas = false;
            } else {
                masVentas = false;
            }
        }

        // 2. Obtener cobranzas en lotes
        let todasLasCobranzas = [];
        let desdeCobranza = 0;
        let masCobranza = true;

        while (masCobranza) {
            const { data: loteCobranza, error: errCobranza } = await supabase
                .from('fc_cobranza')
                .select('*')
                .gte('vencimiento', `${anioConsulta}-01-01`)
                .lte('vencimiento', `${anioConsulta}-12-31`)
                .range(desdeCobranza, desdeCobranza + paso - 1);

            if (errCobranza) throw errCobranza;

            if (loteCobranza && loteCobranza.length > 0) {
                todasLasCobranzas.push(...loteCobranza);
                desdeCobranza += paso;
                if (loteCobranza.length < paso) masCobranza = false;
            } else {
                masCobranza = false;
            }
        }

        // 3. Consultar egresos en paralelo
        const [resCheques, resProveedores, resGastos] = await Promise.all([
            supabase.from('fc_cheques')
                .select('*')
                .gte('fecha', `${anioConsulta}-01-01`)
                .lte('fecha', `${anioConsulta}-12-31`),
            
            supabase.from('fc_facturas_programadas')
                .select('*')
                .gte('fecha_pago_programada', `${anioConsulta}-01-01`)
                .lte('fecha_pago_programada', `${anioConsulta}-12-31`),
            
            supabase.from('fc_gastos_fijos_programados')
                .select('*')
                .gte('fecha_pago_programada', `${anioConsulta}-01-01`)
                .lte('fecha_pago_programada', `${anioConsulta}-12-31`)
        ]);

        if (resCheques.error) throw resCheques.error;
        if (resProveedores.error) throw resProveedores.error;
        if (resGastos.error) throw resGastos.error;

        const proveedoresFormateados = (resProveedores.data || []).map(p => ({
            ...p,
            monto_pago: p.monto_pendiente || 0
        }));

        res.json({
            exito: true,
            anio: anioConsulta,
            cheques: resCheques.data || [],
            proveedores: proveedoresFormateados,
            gastos_fijos: resGastos.data || [],
            ventas: todasLasVentas,
            cobranza: todasLasCobranzas
        });
    } catch (error) {
        console.error('Error al obtener resumen mensual:', error);
        res.status(500).json({ exito: false, error: error.message });
    }
});


// 1. Revertir pago de Factura Programada
app.post('/api/facturas/revertir-pago/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('fc_facturas_programadas')
            .update({ estado: 'pendiente' })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Pago de factura revertido.' });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 2. Revertir pago de Cheque
app.post('/api/cheques/revertir-pago/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('fc_cheques')
            .update({ estado: 'pendiente' })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Pago de cheque revertido.' });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

// 3. Revertir pago de Gasto Fijo
app.post('/api/gastos-fijos/revertir-pago/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from('fc_gastos_fijos')
            .update({ estado: 'pendiente' })
            .eq('id', id);

        if (error) throw error;
        res.json({ exito: true, mensaje: 'Pago de gasto fijo revertido.' });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

// Pagar todos los Cheques de una fecha
app.post('/api/cheques/pagar-todo', async (req, res) => {
    try {
        const { fecha } = req.body;
        const { error } = await supabase
            .from('fc_cheques')
            .update({ estado: 'pagado' })
            .eq('fecha', fecha)
            .eq('estado', 'pendiente');

        if (error) throw error;
        res.json({ exito: true });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

// Pagar todas las Facturas de un proveedor en una fecha
app.post('/api/facturas/pagar-todo', async (req, res) => {
    try {
        const { fecha, proveedor } = req.body;
        let query = supabase
            .from('fc_facturas_programadas')
            .update({ estado: 'pagado' })
            .eq('fecha_pago_programada', fecha)
            .eq('estado', 'pendiente');

        if (proveedor) query = query.eq('proveedor_nombre', proveedor);

        const { error } = await query;
        if (error) throw error;
        res.json({ exito: true });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});

// Endpoint para pagar una factura individual desde la vista de laboratorios
app.post('/api/facturas/pagar/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // ACTUALIZA la fila existente mediante su ID único
        const { data, error } = await supabase
            .from('fc_facturas_programadas')
            .update({ estado: 'pagado' })
            .eq('id', id)
            .select();

        if (error) throw error;

        res.json({ exito: true, mensaje: 'Factura actualizada a pagado.', data });
    } catch (err) {
        console.error('Error al pagar factura:', err.message);
        res.status(500).json({ exito: false, error: err.message });
    }
});

// Endpoint para la consulta por laboratorio



app.get('/api/facturas/consulta-laboratorio', async (req, res) => {



    try {



        const { rut, nombre } = req.query;



        if (!rut && !nombre) {



            return res.status(400).json({ exito: false, error: 'Debe ingresar RUT o Nombre del laboratorio' });



        }







        let queryAgendadas = supabase.from('fc_facturas_programadas').select('*');



        if (rut) queryAgendadas = queryAgendadas.eq('proveedor_rut', rut);



        else if (nombre) queryAgendadas = queryAgendadas.ilike('proveedor_nombre', `%${nombre}%`);



        const { data: agendadas, error: errAgendadas } = await queryAgendadas;



        if (errAgendadas) throw errAgendadas;







        let queryPendientes = supabase.from('fc_facturas_transitorias').select('*');



        if (rut) queryPendientes = queryPendientes.eq('proveedor_rut', rut);



        else if (nombre) queryPendientes = queryPendientes.ilike('proveedor_nombre', `%${nombre}%`);



        const { data: transitorias, error: errTransitorias } = await queryPendientes;



        if (errTransitorias) throw errTransitorias;







        const idsAgendados = new Set((agendadas || []).map(a => String(a.numero_doc || a.id)));



        const porAgendar = (transitorias || []).filter(t => !idsAgendados.has(String(t.numero_doc || t.id)));







        res.json({



            exito: true,



            agendadas: agendadas || [],



            porAgendar: porAgendar



        });



    } catch (error) {



        console.error('Error en consulta por laboratorio:', error);



        res.status(500).json({ exito: false, error: error.message });



    }



});

// Pagar todos los Gastos Fijos de un concepto en una fecha
app.post('/api/gastos-fijos/pagar-todo', async (req, res) => {
    try {
        const { fecha, proveedor: concepto } = req.body;
        let query = supabase
            .from('fc_gastos_fijos')
            .update({ estado: 'pagado' })
            .eq('fecha_pago_programada', fecha)
            .eq('estado', 'pendiente');

        if (concepto) query = query.eq('concepto', concepto);

        const { error } = await query;
        if (error) throw error;
        res.json({ exito: true });
    } catch (err) {
        res.status(500).json({ exito: false, error: err.message });
    }
});


app.get('/api/health', async (req, res) => {
    try {
        const { data, error } = await supabase.from('fc_facturas_transitorias').select('count', { count: 'exact' });
        if (error) throw error;
        res.json({ status: 'OK', mensaje: 'Conexión a Supabase exitosa', data });
    } catch (err) {
        res.status(500).json({ status: 'Error', mensaje: err.message });
    }
});

// Inicialización del servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});
