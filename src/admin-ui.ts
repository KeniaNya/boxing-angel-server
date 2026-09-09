// Pagina del panel de control (src/admin.html) cargada una vez al arrancar.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ADMIN_HTML: string = readFileSync(join(import.meta.dir, "admin.html"), "utf8");
