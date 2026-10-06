# Acceso seguro a Novovet Cash Flow

La aplicación usa Supabase Auth para correo y contraseña. No se guardan contraseñas en `public.fc_usuarios`. Los usuarios invitados reciben el mismo nivel de acceso a las funciones del flujo; un perfil inactivo no puede usar la aplicación ni leer o modificar las tablas protegidas.

## Activación inicial

1. En Supabase, desactiva el registro público de usuarios en **Authentication → Settings → Allow new users to sign up**. Mantén habilitado el inicio de sesión por correo y contraseña.
2. Ejecuta una sola vez `supabase/migrations/20261006120000_auth_and_rls.sql` en el SQL Editor del proyecto correcto. La migración activa RLS, elimina políticas anteriores de estas tablas y concede solo las operaciones indicadas en la migración.
3. En **Authentication → Users**, invita cada correo autorizado. El trigger crea su perfil con `is_active = false`.
4. Habilita cada perfil explícitamente desde SQL Editor, reemplazando el correo:

   ```sql
   UPDATE public.fc_usuarios
   SET is_active = true
   WHERE lower(email) = lower('persona@novovet.cl');
   ```

5. Para quitar acceso, usa `UPDATE public.fc_usuarios SET is_active = false WHERE lower(email) = lower('persona@novovet.cl');`. Para cambiar la contraseña o reenviar una invitación, usa las herramientas de **Authentication → Users**.
6. En **Authentication → URL Configuration**, configura el Site URL con el dominio HTTPS público de Render (no `localhost`) y agrega esa URL a Redirect URLs. El enlace de invitación debe volver a esa misma aplicación para que aparezca el formulario de creación de contraseña.
7. En Render configura `SUPABASE_URL` y `SUPABASE_ANON_KEY` con el URL y la clave publicable del mismo proyecto. La página obtiene ambas variables desde `/app-config.js`; no edites ni publiques claves secretas en el HTML.

No habilites políticas para `anon`: la app exige sesión y usa el rol `authenticated`. La clave publicable puede estar en el navegador; la seguridad depende de RLS y de verificar la sesión. Nunca uses una clave `service_role`/`secret` en el navegador ni en `SUPABASE_ANON_KEY`.

La aplicación muestra un formulario para crear y confirmar la contraseña al abrir una invitación o recuperación válida. Si un enlace anterior te envía a `localhost` o muestra un error de configuración, actualiza primero la URL de autenticación, publica esta versión de la aplicación y vuelve a invitar al usuario. No compartas el enlace del correo: contiene un token de acceso temporal.

## Tablas

- Los usuarios activos pueden operar cheques, facturas programadas, facturas transitorias y gastos fijos programados.
- El catálogo de gastos fijos permite lectura e inserción.
- Saldos de facturas permiten lectura e inserción/actualización.
- Ventas permiten lectura, inserción y actualización para admitir la carga `upsert`; cobranzas, solo lectura.
- `fc_gastos_fijos` y `fc_pagos_facturas` quedan sin acceso por la API desde roles `anon` y `authenticated` porque la aplicación actual no las necesita.

Antes de activar RLS en producción, revisa que el nombre y las columnas de las tablas coincidan con las que usa esta aplicación. Ejecuta la migración primero en un proyecto de pruebas y confirma el acceso con un usuario activo y otro inactivo.
