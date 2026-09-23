// EL CERROJO DE MAQUINA de `gate.sh --full`. Ejercita `scripts/lib/cerrojo-full.sh`
// de verdad -- no su texto -- porque un test que solo comprueba que la llamada
// esta escrita mide presencia, no ejecucion
// (memory/failures/el-cableado-mide-presencia-no-ejecucion.md).
//
// Se prueba la libreria y no `gate.sh` entero por coste: la puerta tarda ~50 s
// en llegar al bloque caro, y eso multiplicado por tres casos se paga en CADA
// `--fast`. Es la misma razon por la que este repo saca los predicados de sus
// servicios a ficheros sueltos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = resolve(fileURLToPath(new URL('../../scripts/lib/cerrojo-full.sh', import.meta.url)));

/** Corre un guion bash con la libreria ya cargada y devuelve su stdout. */
const enBash = (guion) =>
  execFileSync('bash', ['-c', `set -uo pipefail; . '${LIB}'\n${guion}`], { encoding: 'utf8' });

const conCerrojo = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'doxia-cerrojo-'));
  try { return fn(join(dir, 'full.lock')); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('con el cerrojo libre, el turno se toma', () => {
  conCerrojo((f) => {
    const out = enBash(`tomar_turno_full '${f}' 1; echo "[$TURNO_ESTADO]"`);
    assert.match(out, /\[PASS\]/);
    assert.match(readFileSync(f, 'utf8'), /pid=\d+/, 'el cerrojo debe decir QUIEN lo tiene');
  });
});

// EL INVARIANTE QUE IMPORTA. La primera version llamaba a la funcion con
// `read < <(tomar_turno_full ...)`: la sustitucion de proceso la corria en una
// subshell que moria en el acto, asi que el cerrojo se soltaba antes de que
// empezara un solo test y `--full` daba PASS siempre. Este caso se pone rojo si
// alguien vuelve a meter la llamada en una tuberia, un `$( )` o un `|`.
test('el turno se queda en el proceso que llama, no en una subshell', () => {
  conCerrojo((f) => {
    const out = enBash(`
      tomar_turno_full '${f}' 1
      # otro proceso abre el MISMO fichero: si el cerrojo sigue tomado, no entra
      if flock -w 0 '${f}' -c true 2>/dev/null; then echo "[SE SOLTO]"; else echo "[SIGUE MIO]"; fi`);
    assert.match(out, /\[SIGUE MIO\]/,
      'el cerrojo se solto al volver de la funcion: `--full` correria sin turno');
  });
});

test('si lo tiene otro, FAIL y la nota dice quien', () => {
  conCerrojo((f) => {
    const out = enBash(`
      ( exec 9>>'${f}'; flock -x 9; echo "EL-VECINO pid=$BASHPID" > '${f}'; sleep 5 ) &
      ajeno=$!
      sleep 0.3
      tomar_turno_full '${f}' 1
      echo "[$TURNO_ESTADO] $TURNO_NOTA"
      kill $ajeno 2>/dev/null; wait $ajeno 2>/dev/null || true`);
    assert.match(out, /\[FAIL\]/);
    assert.match(out, /EL-VECINO/,
      'el mensaje tiene que nombrar al que lo tiene: `exec 9>` truncaba el fichero y lo dejaba vacio');
  });
});

// EL UNICO AGUJERO QUE QUEDA, y no se puede tapar comprobando al TOMAR el cerrojo.
//
// `flock` cierra sobre el INODO. Si alguien borra el fichero mientras otro lo tiene, el
// siguiente `exec 9>>` estrena un inodo NUEVO y entra sin esperar: dos `--full` a la vez,
// cada uno con su flock legitimo, y los dos firman PASS. REPRODUCIDO el 2026-08-30 --
// vecino sujetando: FAIL; `rm` del fichero: PASS al instante, inodo 28243 -> 28254.
//
// Quien estrena el inodo nuevo NO tiene con que enterarse, asi que no hay guarda posible en
// `tomar_turno_full`. La unica defensa es que el fichero se lo diga a quien esta a punto de
// borrarlo: un pid muerto y una hora vieja se leen como candado olvidado, y ya paso una vez
// que un agente le pidiera a otro «borralo tu antes de tu --full».
//
// Este caso vigila esa defensa. No comprueba una palabra suelta: comprueba que el fichero
// diga las TRES cosas por las que alguien deja de borrarlo -- que no se borre, que un pid
// muerto es normal, y como se pregunta de verdad si esta libre.
test('el fichero del cerrojo se explica a quien esta a punto de borrarlo', () => {
  conCerrojo((f) => {
    enBash(`tomar_turno_full '${f}' 1`);
    const txt = readFileSync(f, 'utf8');
    assert.match(txt, /NO BORRES/i, 'sin el aviso, un pid muerto se lee como candado olvidado');
    assert.match(txt, /pid muerto[^\n]*normal/i, 'hay que decir POR QUE parece rancio y no lo esta');
    assert.match(txt, /flock -n/, 'y como se pregunta de verdad: al kernel, no al fichero');
  });
});

// ── EL TENEDOR SE ENTERA DE QUE LE ROMPIERON EL CERROJO ──────────────────────
//
// `flock` cierra sobre el INODO, asi que borrar el fichero mientras otro lo tiene no libera:
// crea un inodo nuevo y deja entrar a un segundo `--full`. Al que ENTRA no se le puede cazar
// --creo el el inodo, le cuadra-- pero al TENEDOR le DIVERGE, y ese es el guarda.
//
// Lo que se protege no es impedir el segundo `--full` (a esas alturas ya corrio): es que el
// PRIMERO deje de firmar PASS. Un cerrojo roto produce hoy un resultado con la FORMA de una
// verificacion correcta, y esa es la averia entera.
test('recien tomado, el turno esta intacto', () => {
  conCerrojo((f) => {
    const out = enBash(`tomar_turno_full '${f}' 1; turno_intacto '${f}'; echo "[$TURNO_INTACTO]"`);
    assert.match(out, /\[PASS\]/);
  });
});

test('si BORRAN el fichero a media corrida, el tenedor lo caza', () => {
  conCerrojo((f) => {
    const out = enBash(`
      tomar_turno_full '${f}' 1
      rm -f '${f}'                       # el gesto que se hace PARA respetar el cerrojo
      turno_intacto '${f}'; echo "[$TURNO_INTACTO] $TURNO_INTACTO_NOTA"`);
    assert.match(out, /\[FAIL\]/, 'un cerrojo borrado tiene que invalidar la corrida, no pasarla');
    assert.match(out, /DESAPARECIO/);
  });
});

test('si lo SUSTITUYEN --y entra un segundo--, el tenedor lo caza', () => {
  conCerrojo((f) => {
    const out = enBash(`
      tomar_turno_full '${f}' 1
      rm -f '${f}'
      # el segundo --full: estrena inodo y entra sin esperar, con su flock legitimo
      ( exec 8>>'${f}'; flock -n 8 && echo "SEGUNDO-ENTRO" > '${f}' )
      turno_intacto '${f}'; echo "[$TURNO_INTACTO] $TURNO_INTACTO_NOTA"`);
    assert.match(out, /\[FAIL\]/);
    assert.match(out, /SUSTITUIDO/, 'la nota tiene que decir QUE paso: no es lo mismo borrado que sustituido');
  });
});

test('sin turno tomado no se inventa un veredicto: SKIP', () => {
  conCerrojo((f) => {
    // No pudo comprobar != comprobo y esta mal. Colapsarlos es la clase que este repo
    // persigue (memory/failures/el-instrumento-que-confunde-error-con-vacio.md).
    const out = enBash(`turno_intacto '${f}'; echo "[$TURNO_INTACTO]"`);
    assert.match(out, /\[SKIP\]/);
  });
});

