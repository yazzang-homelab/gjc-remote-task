# gjc-remote-task

[English](README.md) · [한국어](README.ko.md) · [中文](README.zh-CN.md) · **Español**

Una extensión de [Gajae Code](https://github.com/Yeachan-Heo/gajae-code) (`gjc`) que ejecuta **trabajo de executor en otras máquinas**. Añade una sola herramienta, `remote_task`. La sesión principal envía una instantánea confirmada del repositorio y una tarea a un host remoto. Allí, un executor de `gjc` aislado hace el trabajo, y la sesión principal verifica los commits resultantes y los importa como una rama local.

Úsala para compilaciones y pruebas pesadas que, de otro modo, cargarían la máquina en la que trabajas. El trabajo ligero, que solo conversa con el modelo, sale más barato como subagente local, porque coordinar un trabajo remoto también consume algo de CPU local.

## Qué hace

- **Dos tipos de destino**
  - *Hosts de trabajo SSH de confianza* que tú mismo aprovisionas.
  - *Boxes para trabajo público* (opcionales): microVM desechables de [instabox.sh](https://instabox.sh), tratadas como no confiables. Solo ejecutan repositorios públicos y nunca reciben credenciales.
- **El ciclo de vida completo en una sola herramienta**
  - `plan` muestra la carga local, los destinos candidatos y por qué se descartó alguno. Tú eliges el destino.
  - `start` envía un git bundle de un `HEAD` confirmado (o de `base_ref`). El executor remoto trabaja en la rama `rt/<job>`.
  - `await`, `inbox` y `send` sirven para esperar una pregunta o el final del trabajo, leer eventos remotos y responder a las preguntas del executor en plena ejecución.
  - `collect` verifica los commits devueltos y los importa como `refs/heads/remote/<target>/<job>`. Con `final` también elimina el trabajo remoto.
  - `cancel` y `status` detienen o inspeccionan trabajos.
- **Despertar automático.** Mientras la sesión principal está inactiva, un vigilante la despierta cuando un trabajo remoto hace una pregunta o termina.
- **Comprobaciones en el ejecutor remoto.** Si pasas `checks` (`{id, cmd, timeout_s}`), el ejecutor remoto los vuelve a ejecutar por su cuenta cuando el executor informa que ha terminado, y los resultados forman parte de la evidencia que `collect` verifica.
- **Sin automatización oculta.** Nunca cambia a otro destino, nunca recurre a la ejecución local y nunca fusiona. La fusión la haces tú.

## Cómo funciona

```
 host principal (origen)                          host de trabajo (confiable, SSH)
 ┌──────────────────────────┐  ssh, cmd forzado   ┌──────────────────────────────────┐
 │ sesión principal de gjc  │ ──────────────────▶ │ gjcrt-ctl → rt-dispatch → sudo   │
 │  └ extensión remote_task │  sube git bundle    │   rt-helper (root, verbos fijos) │
 │     ├ state.db (trabajos)│ ◀────────────────── │   └ unidad systemd por trabajo   │
 │     └ vigilante (avisos) │  eventos / bundle   │       rt-runner → gjc executor   │
 └──────────────────────────┘                     └──────────────────────────────────┘
          │  cola instabox-q + port-forward (solo extracción)
          ▼
 box pública (no confiable): relay ⇄ pump en el origen ⇄ hub de modelos (la clave queda en el origen)
```

- **Host de trabajo**
  - El origen se conecta con la cuenta `gjcrt-ctl`. Su clave está ligada a un comando forzado (`rt-dispatch --origin <nombre>`), y su shell de inicio rechaza todo lo demás.
  - Con `sudo`, esa cuenta solo puede ejecutar un único asistente con privilegios de root, `rt-helper`, y únicamente con un conjunto fijo de verbos.
  - Cada trabajo se ejecuta con la cuenta sin privilegios `gjcrt` dentro de una unidad systemd transitoria. La unidad tiene límites de memoria y de tareas, `ProtectSystem=strict` y un tope de tiempo de ejecución. Todos los trabajos comparten un slice con pesos de CPU/IO.
- **Admisión.** El host rechaza trabajos nuevos con carga alta, presión de memoria (PSI), poco disco o todos los slots ocupados. Los slots reservados son concesiones que caducan.
- **Autenticación.** Cada origen tiene su propio token de registro. Cada trabajo recibe un token de capacidad HMAC que las llamadas posteriores deben presentar.
- **Huellas de secretos**
  - En el host se instalan huellas de secretos reales: nombre, longitud y SHA-256, nunca el valor ni ningún fragmento.
  - Se bloquean los resultados, registros y eventos que contengan una cadena coincidente.
  - La clave dedicada del hub de modelos en el host se registra de la misma forma.
- **Modo box**
  - Antes de enviar, el origen comprueba que el origen de GitHub del repositorio sea público (API anónima) y que el commit base exista en el repositorio público. Después analiza los commits sin publicar y el texto de la tarea en busca de patrones de tokens y huellas.
  - La box no puede conectarse de vuelta. Un pump en el origen extrae las peticiones al modelo del relay de la box mediante `instabox port-forward` y las reenvía al hub con la clave, que nunca sale del origen.
  - Las boxes rechazan `needs: [docker|sudo]` y los trabajos que excederían el tiempo de ejecución restante de la box.

## Requisitos

- **Origen:** `gjc` ≥ 0.22 con Bun, `git`, `ssh` y Python 3.10+.
- **Host de trabajo:** Linux con systemd (cgroup v2), OpenSSH, `sudo` ≥ 1.9.10 (por la regla con expresión regular), `git` y Python 3.10+. Misma arquitectura de CPU que el origen, porque el origen sube su propio binario de `gjc` y el host lo verifica contra un SHA-256 fijado. Desarrollado en Debian 13.
- **Hub de modelos:** un endpoint de modelos compatible con OpenAI y una clave de API dedicada a los hosts de trabajo que solo permita los modelos que indiques.
- **Transporte box (opcional):** la CLI `instabox` y una herramienta de cola `instabox-q`. `instabox-q` no forma parte de este repositorio; sin ella, configura solo destinos SSH.

## Instalación

### 1. Origen

```bash
git clone https://github.com/yazzang-homelab/gjc-remote-task
cd gjc-remote-task && bun install
mkdir -p ~/.gjc/agent/remote-task
cp config.example.yml ~/.gjc/agent/remote-task/config.yml   # edita destinos, modelos, gjcBinary
bash deploy/sync.sh             # instala extension/ en ~/.gjc/agent/extensions/remote-task
```

### 2. Cada host de trabajo

1. Copia y edita un perfil:

   ```bash
   cp deploy/profiles/example.config.json deploy/profiles/build1.config.json
   cp deploy/profiles/example.slice.conf  deploy/profiles/build1.slice.conf
   ```

   Edita `build1.config.json` (provider, allowed_models, hub_models_url, slots, límites) y `build1.slice.conf` (límites de CPU y memoria).
2. Opcional: registra huellas de secretos. Cada línea contiene nombre, longitud y SHA-256, nunca el secreto:

   ```bash
   python3 scripts/fingerprint.py --name gh <(gh auth token) >> ~/.gjc/agent/remote-task/fingerprints.jsonl
   ```

3. Aprovisiona por SSH como root (`<destino> <alias ssh de root> <perfil>`):

   ```bash
   RT_FROM=203.0.113.10 bash deploy/stage-worker.sh build1 root@build1 build1
   ```

   `RT_FROM` es la dirección desde la que se conecta este origen y se escribe en `authorized_keys from=`. Puedes omitirla si el destino es una dirección de enlace local o si el origen tiene Tailscale. Usa `RT_EXTRA_SETUP=deploy/extras/debian-rust.sh` para instalar también herramientas de compilación.
4. Instala la clave dedicada del hub. Solo se lee desde stdin:

   ```bash
   cat hub-worker.key | bash deploy/install-key.sh root@build1
   ```

Para revertir un host de trabajo, ejecuta `deploy/rollback-worker.sh` como root en ese host. Para que otro host principal use el mismo host de trabajo, usa `deploy/add-origin.sh`.

### 3. Boxes (opcional)

Añade un destino `kind: box` y la sección `box:` a `config.yml`, y luego ejecuta `bash deploy/stage-box.sh`. Configura las boxes en un solo origen, porque el registro del grupo de boxes vive en el estado local de ese origen.

## Uso

La herramienta solo está disponible en la sesión **principal**. Llamadas típicas:

```jsonc
{ "action": "plan", "estimated_minutes": 15 }
{ "action": "start", "target": "build1", "estimated_minutes": 15,
  "task": "Arregla las pruebas fallidas del parser en crates/parse",
  "checks": [{ "id": "test", "cmd": "cargo test -p parse", "timeout_s": 900 }],
  "wait": "collect" }                       // espera el final y recoge en una sola llamada
{ "action": "await", "job_id": "rt-…", "until": "ended", "collect": "final" }
{ "action": "send",  "job_id": "rt-…", "reply_to": "<qid>", "text": "Usa la API v2" }
```

`start` rechaza repositorios con cambios sin confirmar. Después de `collect`, revisa y fusiona tú mismo `remote/<target>/<job>`.

## Resultados medidos

Estos datos provienen de un único homelab: un origen Intel Xeon E-2124G, dos hosts de trabajo y una box de 4 vCPU. Todos los trabajos usaron un modelo real a través de un hub real. Cada configuración se ejecutó al menos 5 rondas emparejando una ejecución local (L) con la remota (R). La tabla muestra medianas.

| Destino | CPU local usada por un trabajo remoto (R ÷ L) | Tiempo de reloj (R ÷ L) |
|---|---|---|
| Hosts SSH (tarea Rust/cargo y tarea sintética pesada, en caliente y en frío) | 0.001 – 0.027 | 0.63 – 1.17 |
| Box pública (bun test sobre un repositorio público) | 0.10 – 0.15 | 2.1 – 2.3 |

La relación de tiempo SSH excluye el tiempo que el ejecutor remoto dedica a repetir los `checks`, porque la referencia local ejecuta esas mismas comprobaciones fuera de su intervalo medido. Incluyéndolo, la peor configuración fue 1.24. Las boxes son mucho más lentas, así que úsalas para quitar carga al origen, no para terminar antes. Tus cifras dependerán de tus hosts, tu red y la latencia del modelo.

## Limitaciones

- Los comentarios del código, la descripción de la herramienta y el prompt de rol remoto (`worker/bundle/role.md`) están en coreano, y al executor remoto se le indica que informe en coreano. Edita `role.md` para cambiarlo.
- Solo se admite trabajo de tipo `executor`. El lado remoto no delega en otros agentes.
- Los hosts SSH requieren aprovisionamiento como root, systemd y sudo. No se admiten contenedores sin systemd.
- El transporte box depende de instabox.sh y de la herramienta `instabox-q`, que no está publicada.

## Desarrollo

```bash
bun install
bun test test/unit                 # pruebas unitarias de la extensión
bunx tsc --noEmit -p .
for t in test/py/test_*.py; do python3 "$t"; done   # pruebas del lado del host de trabajo
```

`test/fixtures/mock-hub.py` es un hub de modelos falso para probar el aprovisionamiento sin una clave real (`RT_TEST_HUB=host:port`).

## Licencia

MIT. Consulta [LICENSE](LICENSE). `worker/bundle/role.md` está adaptado del prompt de executor de Gajae Code (MIT, © Yeachan-Heo and Gajae Code Contributors).
