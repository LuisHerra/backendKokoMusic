# KokoMusic-lite — API de resolución de audio

Backend de resolución de streams de audio vía InnerTube (`youtubei.js`), sin
yt-dlp. Pensado para integrarse en el backend original de KokoMusic
reemplazando el rol de `streamResolverService.ts` + `ytdlpService.ts` en el
camino de streaming — no reemplaza el resto del sistema (metadatos, iTunes,
CDN, historial, etc.).

## Base URL

```
https://TU-SERVICIO.onrender.com
```

Local: `http://localhost:7860`

## Autenticación

Todo lo que cuelga de `/api/*` requiere una API key si el servidor tiene
`API_KEY` configurada (recomendado siempre en producción). Se manda como
**query param**, no como header — a propósito, para que funcione en un
`<audio src="...">` o en una redirección 302, donde no se pueden mandar
headers custom:

```
GET /api/stream/dQw4w9WgXcQ/resolve?key=TU_API_KEY
```

Alternativa (equivalente, por si tu integración sí puede mandar headers):
```
x-api-key: TU_API_KEY
```

Sin key válida → `401 { "error": "API key inválida o faltante." }`

`/health` es la única ruta que NO requiere key.

---

## Endpoints

### `GET /health`
Sin auth. Chequeo de vida del servicio.

**Respuesta 200:**
```json
{
  "status": "ok",
  "timestamp": "2026-09-15T09:04:43.680Z",
  "cache": { "size": 3, "keys": ["dQw4w9WgXcQ", "..."] }
}
```

---

### `GET /api/session`
Verifica si la cookie de YouTube (`YOUTUBE_COOKIE`) está configurada y si la
sesión de InnerTube quedó autenticada. Nunca devuelve el valor de la cookie.

**Respuesta 200:**
```json
{ "loggedIn": true, "cookieConfigured": true, "cookieLength": 1847 }
```

---

### `GET /api/search?q=texto`
Busca videos en YouTube vía InnerTube.

**Query params:**
- `q` (string, requerido) — texto de búsqueda libre.

**Respuesta 200:**
```json
{
  "query": "daft punk harder better faster stronger",
  "count": 15,
  "results": [
    {
      "id": "gAjR4_CbPpQ",
      "title": "Daft Punk - Harder, Better, Faster, Stronger (Official Video)",
      "author": "Daft Punk",
      "durationSeconds": 223,
      "thumbnail": "https://i.ytimg.com/vi/.../hq720.jpg"
    }
  ]
}
```

**400** si falta `q`. **500** si InnerTube falla inesperadamente.

Para integrar con el flujo original: usá el `id` del primer resultado (o el
que el usuario elija) como `videoId` en los endpoints de `/api/stream`.

---

### `GET /api/stream/:videoId/resolve`
El endpoint principal. Resuelve el stream de audio y devuelve **JSON**, no
bytes de audio — nunca hace proxy. Ideal para consumir desde un backend
(reemplazando la vieja llamada a `streamResolverService.resolveAudioStream()`)
o desde una app nativa (ExoPlayer en Android, por ejemplo).

**Respuesta 200:**
```json
{
  "url": "https://rr3---sn-xxx.googlevideo.com/videoplayback?...",
  "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
  "bitrate": 130677,
  "contentLength": 3449447,
  "expiresAt": 1789485081000,
  "source": "innertube",
  "client": "IOS",
  "cached": true
}
```

- `expiresAt`: Unix ms real, extraído del parámetro `expire=` de la URL de
  googlevideo.com (o `Expires=` si en el futuro se suma otra fuente). Es el
  campo que reemplaza al TTL fijo que tenía `jiosaavnService.ts` en el
  backend original — acá siempre es el real.
- `client`: qué cliente InnerTube ganó (`IOS`, `ANDROID`, `YTMUSIC`, `MWEB`,
  `WEB_CREATOR`) — útil para logging/métricas si querés replicar el patrón
  de "qué fuente resolvió" que tenía el `ResolvedStream` original.
- `cached`: si la respuesta vino de la caché L1 en memoria del servidor
  (con TTL real, no fijo) o si se resolvió en el momento.

**404** si ningún cliente pudo resolver el stream (equivalente al caso
"todas las fuentes del waterfall fallaron" del sistema original):
```json
{ "error": "No se pudo resolver el stream de audio para este video.", "videoId": "..." }
```

**500** en error inesperado del servidor.

---

### `GET /api/stream/:videoId`
Mismo resolutor que `/resolve`, pero responde con **302 redirect** directo a
la URL de audio — pensado para usar como `src` de un `<audio>` HTML, o para
que el backend original haga un redirect en vez de proxy (el mismo cambio de
arquitectura "resolve & redirect" que ya habían diseñado en la Parte II del
documento original, solo que la resolución la hace este servicio en vez del
waterfall viejo).

**200** nunca — o **302** con header `Location: <url-de-audio>`, o **404**
JSON si no resolvió.

---

### `DELETE /api/stream/:videoId/cache`
Purga la entrada cacheada de un video — usar cuando el cliente detecta una
URL rota (403/404 al reproducir) para forzar re-resolución en el siguiente
request. Reemplaza al viejo `POST /purge-cache` del sistema original.

**Respuesta 200:**
```json
{ "videoId": "dQw4w9WgXcQ", "deleted": true }
```

---

### `GET /api/stream/:videoId/diagnose`
Prueba **todos** los clientes InnerTube (sin cortar en el primero que
funcione) y devuelve el resultado de cada uno. Pensado para debugging /
monitoreo de salud del sistema, no para el camino de streaming normal —
es pesado (dispara ~5 llamadas internas a InnerTube por request).

**Respuesta 200:**
```json
{
  "videoId": "dQw4w9WgXcQ",
  "results": [
    { "client": "IOS", "success": true, "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"", "bitrate": 130677 },
    { "client": "ANDROID", "success": false, "error": "Streaming data not available" },
    { "client": "YTMUSIC", "success": true, "mimeType": "...", "bitrate": 129000 },
    { "client": "MWEB", "success": true, "mimeType": "...", "bitrate": 129000 },
    { "client": "WEB_CREATOR", "success": false, "error": "..." }
  ]
}
```

---

### `GET /api/artist/search?q=texto`
Busca **artistas específicamente** (vía YouTube Music, no la búsqueda de
video normal) — sirve para armar un selector si hay varios artistas con
nombre parecido, sin traer el perfil completo de cada uno.

**Respuesta 200:**
```json
{
  "query": "rnboi",
  "count": 2,
  "results": [
    { "id": "UCxxxxxxxx", "name": "rnboi", "thumbnail": "https://...", "subscribers": "12K subscribers" }
  ]
}
```

### `GET /api/artist/lookup?q=texto`
El atajo directo para "busco un nombre y me sale el perfil": busca, toma el
primer candidato, y devuelve el perfil completo en una sola llamada.

**Respuesta 200** — mismo shape que `/api/artist/:artistId` (ver abajo).

**404** si no encuentra ningún artista con ese nombre.

### `GET /api/artist/:artistId`
Perfil completo por ID directo (útil si el usuario ya eligió uno de varios
candidatos de `/search`).

**Respuesta 200:**
```json
{
  "id": "UCxxxxxxxx",
  "name": "rnboi",
  "description": "Bio del artista tal como la tiene en YouTube Music...",
  "thumbnail": "https://...",
  "topSongs": [
    { "id": "dQw4w9WgXcQ", "title": "...", "thumbnail": "https://...", "durationSeconds": 213 }
  ],
  "albums": [
    { "id": "MPREb_...", "title": "...", "year": "2024", "thumbnail": "https://..." }
  ],
  "relatedArtists": [
    { "id": "UCyyyyyyyy", "name": "Otro artista", "thumbnail": "https://..." }
  ]
}
```

Los `id` dentro de `topSongs` son video IDs normales — se usan tal cual con
`/api/stream/:videoId/resolve` para reproducirlos, es el mismo mecanismo que
ya tenés.

⚠️ **Nota honesta**: esto no se pudo probar contra YouTube real (el entorno
donde se escribió no tiene salida a internet general). La lógica de
extracción está basada en los tipos reales de `youtubei.js`, pero la forma
exacta de la respuesta puede variar según cómo YouTube arme el shelf de
resultados para un artista en particular. Si `topSongs`/`albums` vienen
vacíos pero sabés que el artista sí tiene contenido, hacé un
`console.log(JSON.stringify(artist, null, 2))` en `getArtistProfile()` una
vez para ver la forma real y ajustar la extracción.

---

## Notas de integración con el backend original

- **Reemplazo directo**: en `routes/stream.ts` del backend original, el paso
  `streamResolverService.resolveAudioStream()` se reemplaza por un `fetch` a
  `GET /api/stream/:videoId/resolve?key=...` de este servicio. El `videoId`
  sigue siendo el YouTube ID ya resuelto desde el `itunesId` por
  `ytResolverService.ts` — **este servicio no toca esa parte**, solo la
  resolución de la URL de audio final.
- **El proxy desaparece igual**: si el backend original todavía hace
  `proxyAudioStream()`, reemplazarlo por un `res.redirect(302, resolved.url)`
  usando la `url` que devuelve este servicio.
- **TTL real ya viene resuelto**: no hace falta que el backend original
  vuelva a calcular `expiresAt` — usalo tal cual viene.
- **Cache**: este servicio ya tiene su propia caché L1 con TTL real. Si el
  backend original también cachea (Supabase, R2), lo natural es cachear el
  objeto `ResolvedStream` completo tal cual llega.
- **Rate limiting propio**: no hay límite de requests implementado en este
  servicio más allá de la propia protección de InnerTube — si lo llamás
  muy seguido desde el backend original (por ejemplo en un prefetch masivo
  de cola), respetá un pequeño delay entre resoluciones (200-400ms) para no
  gatillar cooldowns de InnerTube.
