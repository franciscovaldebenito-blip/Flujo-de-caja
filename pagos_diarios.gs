  const DESTINATARIO_PRUEBA = 'fvaldebenito@novovet.cl';
  const ZONA_HORARIA = 'America/Santiago';

  /** Envía manualmente un correo de prueba con los pagos pendientes de hoy. */
  function enviarResumenPagosAhora() {
    enviarResumenPagos_();
  }

  /** Activador diario: no envía correos los sábados ni domingos. */
  function enviarResumenPagosDiasHabiles() {
    const dia = Number(Utilities.formatDate(new Date(), ZONA_HORARIA, 'u'));
    if (dia > 5) return;
    enviarResumenPagos_();
  }

  /** Ejecutar una sola vez para instalar el activador diario de las 7:00. */
  function instalarEnvioDiario() {
    ScriptApp.getProjectTriggers()
      .filter(trigger => trigger.getHandlerFunction() === 'enviarResumenPagosDiasHabiles')
      .forEach(trigger => ScriptApp.deleteTrigger(trigger));

    ScriptApp.newTrigger('enviarResumenPagosDiasHabiles')
      .timeBased()
      .atHour(7)
      .everyDays(1)
      .inTimezone(ZONA_HORARIA)
      .create();
  }

  function enviarResumenPagos_() {
    const propiedades = PropertiesService.getScriptProperties();
    const supabaseUrl = propiedades.getProperty('SUPABASE_URL');
    const anonKey = propiedades.getProperty('SUPABASE_ANON_KEY');
    const secreto = propiedades.getProperty('CASHFLOW_EMAIL_SECRET');
    if (!supabaseUrl || !anonKey || !secreto) {
      throw new Error('Configura SUPABASE_URL, SUPABASE_ANON_KEY y CASHFLOW_EMAIL_SECRET en Propiedades del proyecto.');
    }

    const respuesta = UrlFetchApp.fetch(supabaseUrl.replace(/\/$/, '') + '/rest/v1/rpc/fc_pagos_hoy_email', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey },
      payload: JSON.stringify({ p_secret: secreto }),
      muteHttpExceptions: true
    });
    const codigo = respuesta.getResponseCode();
    if (codigo < 200 || codigo >= 300) {
      throw new Error('Supabase respondió ' + codigo + ': ' + respuesta.getContentText());
    }

    const resumen = JSON.parse(respuesta.getContentText());
    const fechaBonita = Utilities.formatDate(new Date(resumen.fecha + 'T12:00:00'), ZONA_HORARIA, 'dd/MM/yyyy');
    const moneda = valor => '$' + Math.round(Number(valor) || 0).toLocaleString('es-CL');
    let cuerpo;

    if (!resumen.pagos.length) {
      cuerpo = 'No hay pagos pendientes programados para hoy (' + fechaBonita + ').';
    } else {
      const filas = resumen.pagos.map(pago =>
        '<tr><td>' + escaparHtml_(pago.tipo) + '</td><td>' + escaparHtml_(pago.proveedor) +
        '</td><td>' + escaparHtml_(pago.detalle) + '</td><td style="text-align:right">' + moneda(pago.monto) + '</td></tr>'
      ).join('');
      cuerpo = '<p>Pagos pendientes programados para hoy, ' + fechaBonita + ':</p>' +
        '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">' +
        '<tr><th>Tipo</th><th>Proveedor / concepto</th><th>Documento</th><th>Monto</th></tr>' + filas +
        '<tr><th colspan="3" style="text-align:right">Total</th><th style="text-align:right">' + moneda(resumen.total) + '</th></tr></table>';
    }

    GmailApp.sendEmail(DESTINATARIO_PRUEBA, 'Pagos pendientes para hoy — ' + fechaBonita,
      cuerpo.replace(/<[^>]*>/g, ' '), { htmlBody: '<div style="font-family:Arial,sans-serif">' + cuerpo + '</div>' });
  }

  function escaparHtml_(valor) {
    return String(valor == null ? '' : valor).replace(/[&<>"']/g, caracter => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[caracter]));
  }
