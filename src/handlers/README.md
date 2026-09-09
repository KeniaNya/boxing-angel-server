# Modulos de handlers del servidor de juego

Cada archivo `<dominio>.ts` exporta `export const handlers: Record<string, PlayerHandler>` con una
entrada por mensaje `XxxC2S`. `game.ts` los carga al arrancar; un nombre repetido entre modulos
aborta el arranque. El handler recibe `{ s, p, params, log }` (sesion, jugador ya logueado,
parametros del C2S, logger) y devuelve los frames S2C (usar `s2c()` de `economy.ts`). El jugador
se guarda automaticamente tras cada handler. Estado propio del dominio: `ext(p, "<dominio>", () => ({...}))`.
