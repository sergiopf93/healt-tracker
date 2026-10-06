# Health Tracker

PWA mobile-first para registrar ciclos y mediciones de salud. La interfaz está en español, usa unidades métricas por defecto y permite cambiar a lb/in. IndexedDB mantiene una copia local; con el backend conectado, la fuente de verdad se sincroniza en Cloudflare D1.

## Desarrollo local

Requiere Python 3 y un navegador actual. Desde la raíz del repositorio:

```sh
npm start
```

Abre `http://localhost:4173`. Para instalarla en iPhone, publica el sitio en HTTPS y en Safari elige **Compartir → Añadir a pantalla de inicio**.

## Backend gratuito

La API es un Cloudflare Worker y el estado de la aplicación se guarda en una base D1. El Worker protege cada llamada con un token aleatorio; no se guarda en Git ni se incluye en el código servido por Pages. La app y el Atajo lo conservan localmente/configurado por separado. El nivel gratuito tiene límites diarios; al agotarlos las peticiones dejan de funcionar hasta que se restablezca la cuota. No se necesita activar Workers Paid.

1. Crea una base D1 llamada `health-tracker` y selecciona jurisdicción **EU**. En su pestaña **Console**, ejecuta el esquema de `backend/migrations/0001_health_state.sql`.
2. Conecta el repositorio a **Workers Builds** desde el panel de Cloudflare. Usa como raíz el directorio del repositorio, deja vacío **Build command** y despliega desde la rama estable que contiene la aplicación.
3. El **Deploy command** es `npx wrangler deploy --config ./wrangler.toml`. El `database_id` de `wrangler.toml` debe ser el de la base D1 y el nombre del Worker debe coincidir con `name` en ese archivo.
4. En **Settings → Variables and Secrets**, crea el secreto `HEALTH_TRACKER_API_KEY` con una clave aleatoria larga. Guárdala en un gestor de contraseñas y no la añadas a archivos del proyecto.
5. En Health Tracker → **Ajustes → Backend privado**, introduce la URL del Worker y el mismo token. El endpoint desplegado para este proyecto es `https://healt-tracker.sergio-pf93-794.workers.dev`. Hazlo antes de cambiar el Atajo para que la app copie primero los datos locales a D1.
6. En el Atajo **health-care - Apple Health**, después de generar el JSON añade **Obtener contenido de URL** con método POST a la URL del Worker seguida de `/api/import`. Añade `Authorization: Bearer <token>` como cabecera y un cuerpo JSON con `date` y `data`; `data` puede ser el diccionario de métricas o texto JSON válido. Opcionalmente, incluye `steps` como diccionario `{ "YYYY-MM-DD": pasos }` con los datos diarios de Fitbit. La app calcula la media de los días disponibles entre la fecha del registro y los seis días anteriores. La acción de envío puede quedar al final.

`APP_ORIGIN` en `wrangler.toml` debe coincidir con el origen HTTPS de GitHub Pages (solo dominio, sin la ruta `/healt-tracker/`). El token debe ser el mismo en Cloudflare, Ajustes y la cabecera del Atajo. Cada persona con ese token puede leer y modificar los datos, así que no lo compartas. Si se borran los datos del sitio, vuelve a introducirlo; los ciclos seguirán en D1.

Al conectar por primera vez, los datos locales se copian a D1 si el backend está vacío; si D1 ya tiene ciclos, la app los descarga. Las importaciones del Atajo quedan pendientes en D1 hasta que la PWA vuelve, las coloca en el formulario que abrió Atajos y el usuario guarda la medición. D1 conserva el estado actual; no genera un historial de commits con versiones previas de cada medición.

## Ciclos y datos

Cada ciclo tiene una medición inicial. Las mediciones se pueden editar o eliminar desde el menú de tres puntos; si se elimina la referencia inicial, pasa a serlo el registro más antiguo restante. Se puede escribir a mano la media de pasos en cualquier medición. Desde Ajustes se puede exportar un backup JSON. Los ciclos cerrados se pueden eliminar con sus mediciones. Los cambios se sincronizan al backend cuando está configurado.

Los tres gráficos comparan: peso, masa libre de grasa y porcentaje de grasa; TMB y media de pasos por semana del ciclo; cintura, cadera y flotadores. Se ven las 16 semanas con desplazamiento horizontal; los gráficos de series con unidades diferentes usan escalas verticales independientes, mientras cintura, cadera y flotadores comparten escala. La media semanal de pasos incluye solo los días que tienen un dato. Las leyendas permiten resaltar una o varias series.

## Apple Health y Atajos

La PWA no accede directamente a HealthKit. El botón abre el atajo existente **health-care - Apple Health** y le pasa la fecha seleccionada. Con el backend conectado, el Atajo envía el JSON a `/api/import`; al volver a la PWA desde el selector de apps, esta consulta Cloudflare automáticamente y espera la importación hasta 45 segundos. Los valores manuales se conservan, los conflictos guardan sus dos orígenes y las importaciones repetidas se deduplican al guardar. Al leer estados antiguos, el Worker agrega a cada medición un nodo `observations.Steps` vacío si aún no existe; el valor se puede completar manualmente o importar desde Fitbit.

## Comprobaciones

```sh
npm test
```

La suite cubre fechas, conversiones, reglas de ciclos, importación Apple Health, sincronización remota, medias semanales, conflictos y eliminación. El despliegue y la prueba con el Atajo real requieren tu cuenta Cloudflare y el iPhone.
