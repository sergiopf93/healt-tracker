# Health Tracker

PWA mobile-first para registrar ciclos y mediciones de salud. La interfaz está en español y usa unidades métricas por defecto; se puede cambiar a lb/in en Ajustes. Los datos se guardan localmente en IndexedDB y no se envían a un servidor.

## Desarrollo local

Requiere Python 3 y un navegador actual. Desde la raíz del repositorio:

```sh
npm start
```

Abre `http://localhost:4173`. Para instalarla en iPhone, publica la rama como sitio HTTPS y en Safari elige **Compartir → Añadir a pantalla de inicio**. La PWA conserva su shell básico offline después de cargarlo una vez.

## Ciclos y datos

Crea un ciclo y su medición inicial con al menos un valor real. Las siguientes mediciones son opcionales y pueden editarse. Las comparaciones usan mediciones existentes en semanas exactas; no interpolan valores. Los valores se almacenan canónicamente en kg y cm, aunque se muestren en otras unidades. Desde Ajustes puedes exportar el backup JSON o borrar los datos locales.

## Apple Health

La app no integra HealthKit directamente. El atajo existente **health-care - Apple Health** devuelve a la PWA con `?healthData=...`; el receptor valida el JSON, la fecha, unidades y números, y pide confirmar antes de guardar porque el enlace por sí solo no autentica el origen. Tras confirmar, fusiona las observaciones en la medición del día y señala discrepancias para que se resuelvan. Una importación repetida no añade de nuevo los mismos valores. Los campos no compatibles se notifican como omitidos.

El transporte mediante query string es provisional: los datos pueden aparecer brevemente en el historial del navegador o en registros del servidor que entregue la página. La app elimina el parámetro de la barra de direcciones tras recibirlo y el service worker no almacena respuestas que incluyan `healthData`. La capa parser/importación está separada para poder sustituir el transporte sin acoplarlo a la interfaz.

## Comprobaciones

```sh
npm test
```

La suite cubre fechas, conversiones, reglas de ciclos, mediciones, conflictos, referencias exactas, callback Apple Health y formato de exportación. La validación con un iPhone y el atajo real requiere ejecutarse en el dispositivo.
