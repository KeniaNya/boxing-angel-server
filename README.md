# Boxing Angel · servidor comunitario

Servidor no oficial para revivir **Boxing Angel** (`th.in.monogame.boxingangel`, Mono Play
Co., 2019, Unity 5.6 / Mono), cuyos servidores cerraron en 2019. Corre en Bun y se
despliega en LenaCloud (`lena up`).

## Qué reemplaza

| Original | Aquí |
|---|---|
| `http://<host>/BALoginServer/Login/Create\|Verify\|FastAccBinding` | `src/index.ts` → `handleLogin` (cuentas en `LENA_APPDATA/data/accounts.json`) |
| `http://boxingangel-thai.monogame.in.th/boxingangel/setting/v1_0/<nombre>.zip` | `GET /boxingangel/setting/<ver>/<nombre>.zip` (zip generado al vuelo, `src/settings.ts`) |
| `.../boxingangel/bundles/Google/Android/BundleDatabaseList.txt` | índice vacío: el cliente carga todo desde el OBB |
| Servidor de juego TCP (`LoginC2S`, `PlayChapterC2S`…) | `src/socket.ts` (transporte HTTP) + `src/game.ts` (handlers). El cliente parcheado lleva `BAHttpSocket.dll`, que sustituye al socket TCP por POSTs. |

## Transporte HTTP del "socket"

El cliente original abre un TCP con frames `[len:4 BE][JSON]`. El parcheado usa:

| Endpoint | Cabecera | Cuerpo | Respuesta |
|---|---|---|---|
| `POST /socket/connect` | — | `{}` | `{"session": id}` |
| `POST /socket/send` | `X-BA-Session` | `{"methodName":"XxxC2S","paramObject":"<json>"}` | `[ {"methodName":"XxxS2C","paramObject":{…}}, … ]` (respuestas + push pendientes) |
| `POST /socket/poll` | `X-BA-Session` | `{}` | `[frames pendientes]` |
| `POST /socket/close` | `X-BA-Session` | `{}` | `{"ok":true}` |

Los handlers viven en `src/game.ts` (uno por `*C2S`); los mensajes sin handler reciben `{res:0}`
y se registran en el log para implementarlos. Estado de jugador en `LENA_APPDATA/data/players/`.
La tabla de red ofrece dos servidores: id 1 offline (stubs del cliente) e id 2 comunitario
(`connection=1`); `GAME_CONNECTION` decide cuál es el recomendado.

## Variables de entorno (`server.env`)

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `8090` | La inyecta LenaCloud. |
| `PUBLIC_HOST` | `boxingangel.lenasuite.org` | Host sin esquema; el cliente construye `http://<host>/BALoginServer/...`. |
| `PUBLIC_BASE_URL` | `http://<PUBLIC_HOST>` | Base con esquema para URLs de noticias y bundles. |
| `GAME_CONNECTION` | `0` | `0` = modo offline del cliente; `1` = usar servidor de juego. |
| `GAME_SERVER_HOST` / `GAME_SERVER_PORT` | `<PUBLIC_HOST>` / `9003` | Lo que devuelve `Verify` en `game_list`. |
| `CLIENT_VERSIONS` | `1.0.18,…,1.0` | Versiones para las que se emite `Android_connect_info` (debe incluir `CSSceneManager.m_Version`). |
| `NETWORK_NAME` | `Community` | Nombre del servidor en el selector del juego. |

## Desarrollo local

```bash
bun run dev          # http://localhost:8090
curl "http://localhost:8090/BALoginServer/Login/Create?acc=usuario1&pwd=secreto1&type=0"
curl "http://localhost:8090/BALoginServer/Login/Verify?acc=usuario1&pwd=secreto1&type=0"
curl -o setting.zip http://localhost:8090/boxingangel/setting/v1_0/setting.zip
```

## Formato de las tablas de Setting

Texto tabulado; la primera línea es cabecera (el cliente la ignora). Los índices de
campo salen del cliente decompilado (`CSDatabase.InitChannelVersionData`,
`CSDatabase.LoadNetworkInfoData`, `CSDownload.CheckSettingData`). Ver comentarios en
`src/settings.ts`.

## Panel de control (`/admin`)

Página servida por el propio servidor: `http://boxingangel.lenasuite.org/admin` (usa `https://` si el
túnel lo ofrece: el token viaja en cada petición). Requiere `ADMIN_TOKEN` en `server.env`
(`lena env push`). Permite, sin redesplegar:

- **Configuración**: servidor recomendado (online/offline), nombre, versión de datos, tercer panel del
  gacha (Select/Cosplay), funciones del cliente (tutorial, NPC, historia, PvP), capítulos especiales
  abiertos, modo mantenimiento. Se guarda en `LENA_APPDATA/data/config.json` y sustituye a las
  variables de entorno equivalentes (`GAME_CONNECTION`, `NETWORK_NAME`, `DATA_VERSION`).
- **Noticias**: título y cuerpo HTML del popup del login y de los webviews del lobby.
- **Jugadores**: lista, edición (nombre, nivel, VIP, AP/TP, monedas, progreso, tutorial) y entrega
  directa de objetos.
- **Regalos**: correo con adjuntos a un jugador o a todos.
- **Códigos de canje**: alta/baja con recompensas (una vez por jugador).
- **Cuentas** y **log** reciente del servidor.

API JSON en `/admin/api/*` con cabecera `Authorization: Bearer <ADMIN_TOKEN>` (ver `src/admin.ts`).
