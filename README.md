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

## Cómo desplegar en Hugging Face Spaces

1. Crear un Space nuevo → SDK: **Docker** (no Gradio/Streamlit).
2. Subir estos archivos (o conectar el repo de GitHub del proyecto).
3. Hugging Face detecta el `Dockerfile` automáticamente y expone el puerto `7860`
   (ya configurado en `ENV PORT=7860`).
4. Una vez desplegado, probar los mismos `curl` de arriba maqueando la URL del Space:

```bash
curl -s "https://TU-USUARIO-TU-SPACE.hf.space/api/stream/dQw4w9WgXcQ/resolve" | jq
```

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
