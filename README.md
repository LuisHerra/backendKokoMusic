# KokoMusic-lite — Parte 1 del ecosistema híbrido

Backend mínimo de resolución de audio usando **solo `youtubei.js` (InnerTube), sin yt-dlp**.
Objetivo de esta fase: validar cuánta cobertura real da InnerTube por sí solo antes de
decidir si hace falta el segundo escalón (yt-dlp en un Raspberry Pi vía Tailscale).

## Qué hace

- `GET /health` — estado del servicio y tamaño de la caché L1.
- `GET /api/search?q=...` — búsqueda de videos vía InnerTube.
- `GET /api/stream/:videoId/resolve` — resuelve el stream de audio y devuelve JSON
  (`url`, `mimeType`, `bitrate`, `expiresAt`, `source`, `client`). **No hace proxy de audio.**
- `GET /api/stream/:videoId` — mismo resolutor, pero responde con **302 redirect** directo
  a la URL de audio (para usar como `src` de un `<audio>`).
- `DELETE /api/stream/:videoId/cache` — purga la entrada cacheada de un video.

El servidor prueba varios clientes InnerTube en orden (`YTMUSIC`, `ANDROID`, `IOS`, `MWEB`)
hasta que uno resuelva. Si todos fallan, responde 404 — ese es justamente el caso que
mediremos para decidir si hace falta el fallback de yt-dlp.

## ⚠️ Importante: por qué esto no se pudo probar end-to-end en el sandbox

Este proyecto se generó y compiló en un entorno con acceso a red restringido (solo npm,
GitHub, PyPI — sin `youtube.com` ni `googlevideo.com`). Se verificó que:

- ✅ El proyecto instala dependencias y compila sin errores de tipos.
- ✅ El servidor arranca y `/health` responde correctamente.
- ✅ El flujo de código llega hasta el punto de red (se confirmó con un 403 del proxy
  del propio sandbox al intentar salir a youtube.com — no es un error de YouTube, es el
  firewall de este entorno).
- ❌ **No se pudo confirmar una resolución real contra YouTube.** Eso solo se puede probar
  desde tu máquina o ya desplegado en la nube.

## Cómo probarlo en tu máquina (primer paso obligatorio)

```bash
npm install
npm run dev
# en otra terminal:
curl -s http://localhost:7860/health

# Prueba real con un video conocido:
curl -s "http://localhost:7860/api/stream/dQw4w9WgXcQ/resolve" | jq

# Prueba de redirect (debe devolver 302 y un header Location: hacia googlevideo.com)
curl -sI "http://localhost:7860/api/stream/dQw4w9WgXcQ"

# Búsqueda
curl -s "http://localhost:7860/api/search?q=daft+punk+harder+better+faster+stronger" | jq
```

Qué mirar en los resultados:
- Campo `client` en la respuesta de `/resolve`: te dice qué cliente InnerTube ganó
  (`YTMUSIC`, `ANDROID`, etc.). Anotalo en varias pruebas — si siempre es el mismo,
  podés simplificar el orden de intento.
- Campo `expiresAt`: debería ser un timestamp varias horas en el futuro. Si sale muy
  cercano a "ahora", revisar el parseo del parámetro `expire=`.
- Si te da 404 en tracks de nicho, poco populares, o con restricción de edad: es
  justo la señal de que hace falta el fallback de yt-dlp para esos casos.

## Autenticación opcional con cookies (para contenido con restricción de edad)

Por defecto la sesión de InnerTube es anónima. Si querés intentar desbloquear
contenido con restricción de edad (como el caso de Rammstein - "Pussy" que
falló en todos los clientes), podés pasar cookies de tu propia cuenta real de
YouTube:

```bash
# Windows PowerShell
$env:YOUTUBE_COOKIE = "SID=...; HSID=...; SSID=...; ..."
npm run dev

# macOS/Linux
YOUTUBE_COOKIE="SID=...; HSID=...; SSID=...; ..." npm run dev
```

Cómo obtener el string de cookies: iniciá sesión en youtube.com en tu
navegador, abrí las herramientas de desarrollador (F12) → pestaña Network →
recargá la página → click en cualquier request a youtube.com → copiá el
header `Cookie` completo. También podés usar una extensión tipo "Get
cookies.txt" y convertir el formato.

⚠️ Riesgo a tener en cuenta: estás usando la sesión de tu cuenta real para
requests automatizados. Para un proyecto personal de bajo volumen el riesgo
es mínimo, pero no lo hagas con una cuenta que te importe perder si hacés
muchísimas requests por hora.

Antes de complicarte con cookies, probá primero si el cliente `WEB_CREATOR`
(ya incluido en la cadena de clientes) resuelve el contenido con restricción
de edad sin necesitar login — es el workaround documentado por yt-dlp para
este caso específico.

## Diagnóstico: ¿es viable depender de un solo cliente?

`coverage-test.mjs` reporta quién GANÓ primero en cada track — pero como IOS
suele ganar siempre, nunca te dice si ANDROID/YTMUSIC/MWEB/WEB_CREATOR
funcionarían igual si IOS fallara. Para eso está `diagnose-clients.mjs`:
prueba TODOS los clientes en cada track (sin cortar en el primer éxito) y te
dice, específicamente, cuántas veces tuviste un plan B real cuando IOS falló.

```bash
node scripts/diagnose-clients.mjs
```

## Despliegue en Render.com — gratis, recomendado

Hugging Face cambió silenciosamente su política: Docker Spaces con CPU básica
ahora exige suscripción PRO ($9/mes). Render.com es la alternativa que no pide
tarjeta y usa el mismo `Dockerfile` que ya tenés, sin cambiar una línea de
código (tu servidor ya lee `process.env.PORT`, que es justo lo que Render
inyecta automáticamente).

**Contra a tener en cuenta**: el plan gratis "duerme" el servicio tras 15
minutos sin tráfico, y el primer request después de eso tarda ~1 minuto en
responder (cold start). Para uso personal esporádico es un precio razonable
a cambio de $0/mes.

### 1. Subir el proyecto a GitHub (Render deploya desde ahí)

```bash
cd kokomusic-lite
git init
git add .
git commit -m "Deploy inicial"
```
Creá un repo nuevo en [github.com/new](https://github.com/new) (puede ser
privado) y seguí las instrucciones que te da GitHub para conectar tu carpeta
local (`git remote add origin ...` + `git push`).

### 2. Crear el Web Service en Render

1. Entrá a [dashboard.render.com](https://dashboard.render.com) (podés
   registrarte con tu cuenta de GitHub directamente).
2. **New** → **Web Service** → conectá el repo que acabás de crear.
3. Render detecta el `Dockerfile` solo — dejá **Runtime: Docker**.
4. **Instance Type**: **Free**.
5. Antes de crear, andá a **Environment** y agregá (marcá "Secret" si el
   toggle está disponible):

| Key | Value |
|---|---|
| `API_KEY` | Tu string random (mismo concepto que antes) |
| `YOUTUBE_COOKIE` | Opcional, tu cookie de sesión |

6. **Create Web Service**. El primer build tarda unos minutos — mirá la
   pestaña **Logs**.

### 3. Probar

Render te da una URL tipo `https://kokomusic-lite.onrender.com`:

```bash
curl -s https://kokomusic-lite.onrender.com/health
curl -s "https://kokomusic-lite.onrender.com/api/session?key=TU_API_KEY"
```

Si el servicio estaba dormido, la primera respuesta va a tardar — es
esperado, no es un error.

### 4. Comparar cobertura local vs. cloud

```powershell
$env:BASE_URL="https://kokomusic-lite.onrender.com"
$env:API_KEY="TU_API_KEY"
node scripts/diagnose-clients.mjs
node scripts/coverage-test.mjs
```

## Alternativa: Hugging Face Spaces (requiere PRO, $9/mes)

Si preferís evitar el cold start de Render y no te molesta pagar, el mismo
`Dockerfile` funciona igual en HF Spaces una vez que tengas PRO activo.
Los pasos son los mismos que se detallan abajo.

## Despliegue en Hugging Face Spaces — paso a paso

### 1. Crear el Space

1. Andá a [huggingface.co/new-space](https://huggingface.co/new-space) (necesitás una cuenta de Hugging Face, gratis).
2. **SDK**: elegí **Docker** (no Gradio/Streamlit/otro).
3. **Visibilidad**: podés dejarlo en **Public**. No hace falta ponerlo en
   Private — la protección real la da la `API_KEY` propia que configuramos
   abajo, que además funciona en un `<audio src="...">` (un Space privado de
   HF exige un header `Authorization`, que no podés poner ahí).
4. **Hardware**: **CPU basic (free)** alcanza de sobra para esto.
5. Creá el Space.

### 2. Configurar los secretos (¡antes de subir código!)

En tu Space → **Settings** → **Variables and Secrets** → **New secret**,
agregá:

| Nombre | Valor | Obligatorio |
|---|---|---|
| `API_KEY` | Un string random que inventes vos (ej. generá uno con `openssl rand -hex 16`) | Sí — sin esto tu backend queda abierto a cualquiera en internet |
| `YOUTUBE_COOKIE` | Tu cookie de sesión de YouTube, si la vas a usar | Opcional |

**Nunca pongas estos valores directamente en el código ni los subas a git** —
por eso son "Secrets" y no "Variables": no se muestran ni siquiera a vos una
vez guardados, y no quedan en el historial del repo.

### 3. Subir el código

**Opción A — más simple, sin git**: en la página del Space, pestaña
**Files** → **Add file** → subís todos los archivos del proyecto manteniendo
la estructura de carpetas (`src/`, `package.json`, `Dockerfile`, etc.) —
**no subas `node_modules` ni `dist`**, el Dockerfile los genera solo.

**Opción B — con git** (mejor si vas a iterar seguido):
```bash
git clone https://huggingface.co/spaces/TU-USUARIO/TU-SPACE
cd TU-SPACE
# copiá adentro todos los archivos del proyecto (menos node_modules y dist)
git add .
git commit -m "Deploy inicial"
git push
```

### 4. Esperar el build y probar

El Space detecta el `Dockerfile` automáticamente y empieza a buildear (mirá
la pestaña **Logs** para seguir el progreso — la primera vez tarda unos
minutos). Cuando diga **Running**:

```bash
# Salud básica (no necesita key)
curl -s https://TU-USUARIO-TU-SPACE.hf.space/health

# Cualquier endpoint /api/* SÍ necesita la key que configuraste como Secret
curl -s "https://TU-USUARIO-TU-SPACE.hf.space/api/session?key=TU_API_KEY"
```

### 5. Comparar cobertura local vs. cloud (el dato que realmente importa)

Los mismos scripts que ya usaste sirven para esto — solo apuntalos al Space:

```bash
# Windows PowerShell
$env:BASE_URL="https://TU-USUARIO-TU-SPACE.hf.space"
$env:API_KEY="TU_API_KEY"
node scripts/diagnose-clients.mjs
node scripts/coverage-test.mjs
```

Compará el resumen con el que ya tenés de tu máquina local. Si ves que
`IOS`/`YTMUSIC`/`MWEB` bajan su tasa de éxito notablemente desde la IP de
datacenter de Hugging Face, esa es la señal real de que el bloqueo por IP de
datacenter te está afectando — y ahí sí tendría sentido retomar la idea del
Raspberry Pi con yt-dlp como fallback. Si se mantienen parecidos, significa
que para tu volumen de uso personal el datacenter no es un problema práctico.

## Plan de verificación sugerido (antes de decidir sobre yt-dlp)

1. **Cobertura**: probar ~30-50 tracks variados de tu librería real (populares, de nicho,
   lanzamientos recientes, con y sin explicit content) contra `/resolve`. Contar cuántos
   dan 404 vs. cuántos resuelven bien. Ese porcentaje de fallo es tu métrica clave.
2. **Latencia**: medir `time_total` de `/resolve` en frío (sin caché) vs. en caliente
   (segunda llamada al mismo id, debe ser prácticamente instantánea por el cache L1).
3. **Estabilidad en el tiempo**: correr las mismas pruebas un par de días seguidos — la
   tasa de fallo de InnerTube puede subir si YouTube cambia algo (rotación de n-token,
   nuevas restricciones). Si ves que sube con el tiempo, es la señal de que necesitás el
   segundo escalón (yt-dlp) antes de lo esperado.
4. **Comparar con IP de datacenter real**: si desplegás en Hugging Face (datacenter) y
   los resultados difieren mucho de tus pruebas locales (con tu IP residencial), eso te
   confirma cuánto pesa el bloqueo por IP de datacenter específicamente para InnerTube.

Con esos datos ya tenemos evidencia real para decidir si el fallback de yt-dlp en un
Raspberry Pi es necesario, o si InnerTube solo cubre lo suficiente para tu uso personal.
