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
| Servidor de juego TCP (`LoginC2S`, `PlayChapterC2S`…) | pendiente (fase 4); con `GAME_CONNECTION=0` el cliente usa su modo offline integrado |

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
