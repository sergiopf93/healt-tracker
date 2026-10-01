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

1. Crea una cuenta Cloudflare en el nivel gratuito e inicia sesión desde `npx wrangler login`.
2. Desde la raíz del proyecto, ejecuta `npx wrangler d1 create health-tracker --jurisdiction eu --update-config`. Wrangler completará el identificador D1 en `wrangler.toml`.
3. Inicializa el esquema: `npx wrangler d1 migrations apply health-tracker --remote`.
4. Publica una primera vez: `npx wrangler deploy`.
5. Crea un token aleatorio con `openssl rand -hex 32` y guárdalo en un gestor de contraseñas. Configúralo con `npx wrangler secret put HEALTH_TRACKER_API_KEY` y vuelve a ejecutar `npx wrangler deploy`. No lo añadas a archivos del proyecto.
6. Abre Health Tracker → Ajustes → Backend privado. Introduce la URL `https://health-tracker-private-api.<tu-subdominio>.workers.dev` que muestra Wrangler y el token. Hazlo antes de modificar el Atajo para que la app copie primero los datos locales a D1.
7. En el Atajo **health-care - Apple Health**, después de generar el JSON añade **Obtener contenido de URL** con método POST a la URL del Worker seguida de `/api/import`. Añade `Authorization: Bearer <token>` como cabecera y envía el objeto JSON generado como cuerpo (`Content-Type: application/json`). Conserva al final **Abrir app → Health Tracker**.

`APP_ORIGIN` en `wrangler.toml` debe coincidir con el origen HTTPS de GitHub Pages (solo dominio, sin la ruta `/healt-tracker/`). El token debe ser el mismo en Cloudflare, Ajustes y la cabecera del Atajo. Cada persona con ese token puede leer y modificar los datos, así que no lo compartas. Si se borran los datos del sitio, vuelve a introducirlo; los ciclos seguirán en D1.

Al conectar por primera vez, los datos locales se copian a D1 si el backend está vacío; si D1 ya tiene ciclos, la app los descarga. Las importaciones del Atajo quedan pendientes en D1 hasta que la PWA vuelve, las coloca en el formulario que abrió Atajos y el usuario guarda la medición. D1 conserva el estado actual; no genera un historial de commits con versiones previas de cada medición.

## Ciclos y datos

Cada ciclo tiene una medición inicial. Desde Ajustes se puede exportar un backup JSON. Los ciclos cerrados se pueden eliminar con sus mediciones. Los cambios se sincronizan al backend cuando está configurado.

Los tres gráficos comparan: peso, masa libre de grasa y porcentaje de grasa; TMB y media de pasos por semana del ciclo; cintura, cadera y flotadores. Peso y masa comparten escala en kg/lb, grasa corporal usa eje secundario; TMB y pasos también usan ejes separados. La media semanal de pasos incluye solo los días que tienen un dato. Las leyendas permiten resaltar una o varias series.

## Apple Health y Atajos

La PWA no accede directamente a HealthKit. El botón abre el atajo existente **health-care - Apple Health** y le pasa la fecha seleccionada. Con el backend conectado, el Atajo envía el JSON a `/api/import`; al volver, la app recibe la importación en el formulario pendiente. Los valores manuales se conservan, los conflictos guardan sus dos orígenes y las importaciones repetidas se deduplican al guardar.

## Comprobaciones

```sh
npm test
```

La suite cubre fechas, conversiones, reglas de ciclos, importación Apple Health, sincronización remota, medias semanales, conflictos y eliminación. El despliegue y la prueba con el Atajo real requieren tu cuenta Cloudflare y el iPhone.
