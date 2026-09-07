# Předávací brief – Shade3D Viewer / ARTHETIC Model Builder

## Kontext projektu
Next.js app (`app/ClientPage.jsx`, ~20 800 řádků) pro zpracování intraorálních
scanů: trim hranice, generování solid báze pod scan, spojení scan↔báze
("shoulder"), export do STL pro 3D tisk. Existuje CGAL WASM modul
(`public/wasm/mesh-repair.js` + `.wasm`, volaný z `app/workers/repair.worker.js`)
který zatím umí jen jednu věc: `_arthetic_repair_hole` (vyplnění díry ve scanu,
C1 continuity + fairing).

## Co jsme dnes (v jiné, chat-only relaci) vyřešili v `cadBuildSolidBaseGeometry`
### Diagnóza (3 postupné bugy, potvrzeno rozborem exportovaných STL):
1. **V37** (`cadExactClipScanToBaseFootprint`) – přesné triangle-polygon
   klipování scanu podle obrysu báze nechávalo velkou souvislou díru (~1700
   vrcholů) tam, kde scan potkává bázi. Potvrzeno porovnáním s dřív fungující
   V36 verzí, kterou uživatel dohledal.
2. **V36 revert** (`cadClipScanBoundaryBandToBaseEnvelope`, per-vertex XZ
   projekce na obrys báze) – spoj fungoval, ale vznikaly "jehlové" (sliver)
   trojúhelníky, protože se posouval každý vrchol zvlášť a topologie
   zůstávala – trojúhelník s jedním posunutým a jedním nehýbaným vrcholem se
   protáhl. Filtr na degenerované trojúhelníky chytal jen téměř nulovou
   plochu, ne protažené jehly.
3. **V39 (aktuální, funguje)** – stejná funkce přepsaná na přístup
   "smaž trojúhelníky, co čouhají přes obrys báze o víc než `outsideHard`,
   pak hranici znovu extrahuj" pomocí stávajícího spolehlivého
   `cadExtractBoundaryLoopsRobust` (edge-multiplicity tracer). Žádné
   posouvání vrcholů → žádné jehly. Kritický detail: nová hranice se musí
   zarovnat (stejný "start index" + winding) na tu starou, protože
   `evaluateDirectBridge` dál spoluvzorkuje `rawLoop` a `regularized`
   (footprint) podle stejného parametru `u` – jinak by vznikl přehozený/
   pokroucený shoulder.
4. Navíc: zaoblený profil shoulderu (`evaluateDirectBridge`) přepsaný na
   Hermitovu křivku s tečnou odvozenou ze skutečné normály scan povrchu
   (nový `cadBuildVertexNormalMap`/`cadLookupVertexNormal`), aby napojení
   bylo tečné (G1), ne lomené.

**Výsledek:** scan a báze se teď spojují bez děr a bez jehel. Zbylé drobné
(3–40 vrcholů) otevřené smyčky na povrchu zubů jsou staré, předexistující
artefakty ze scanu (ne z shoulder kódu) – měla by je řešit existující
"Oprava" fáze (CGAL repair), případně ji doladit.

## Kam chceme jít dál – hlavní úkol pro Claude Code
Uživatel plánuje rozšiřovat appku o funkce, které jsou v podstatě všechny
**boolean/CSG operace**: přidání textu na model (union/difference vytlačeného
textu), dutý model (offset shell + subtract), zkosení/bevel hrany báze
(lokální fillet). Ruční heuristiky (jako výše) se s každou další funkcí
kombinatoricky komplikují.

**Rozhodnutí:** rozšířit stávající CGAL WASM modul o:
1. **Boolean union** dvou manifold meshů (scan-solid + base-solid) –
   `CGAL::Polygon_mesh_processing::corefine_and_compute_union`. Tohle by mělo
   nahradit celé dnešní ruční klipování/stitching jedním robustním voláním.
2. **Hollowing (dutý model)** – doporučuju voxel/SDF přístup (marching cubes
   na signed distance field), ne exaktní BRep offset – ten bývá na
   organickém/šumovém dentálním scanu křehký. CGAL má
   `Polygon_mesh_processing` nástroje využitelné pro tohle, nebo lze jít přes
   vlastní voxelizaci.
3. (Později) fillet/bevel hrany – buď JS-side kosmetický pass (podobně jako
   dnešní Hermitův profil), nebo CGAL nástroj, pokud existuje vhodný.

## Konkrétní technický požadavek na novou WASM funkci
Následuj **přesně stejnou konvenci** jako stávající `arthetic_repair_hole`
(viz `app/workers/repair.worker.js`):
- Vstup: `Module._malloc` + zápis do `Module.HEAPF64`/`HEAPU32` (positions,
  faces jako ploché pole trojic).
- Výstup: sada `_arthetic_result_*` getter funkcí vracejících pointery a
  počty (pozice, trojúhelníky, případně origin/mapping indexy), plus
  `_arthetic_result_error_code`.
- Nová funkce v novém (nebo rozšířeném) C++ souboru, zkompilovat stejným
  emcc/CGAL/Boost/GMP/MPFR toolchainem, jakým vznikl `mesh-repair.wasm`
  (najdi build skript/CMake, pokud je v repu, jinak zjisti verze knihoven
  ze stávajícího `.wasm` – např. přes `emcc --version` použitý dřív).
- Nový worker soubor nebo rozšíření `repair.worker.js` o nový message type
  (`BOOLEAN_UNION`), stejný vzor postMessage/PROGRESS/RESULT/ERROR.

## Co zkontrolovat jako první krok v Claude Code
1. Je v repu build skript pro `mesh-repair.wasm` (CMakeLists.txt, build.sh,
   nebo zmínka v README)? Pokud ne, bude potřeba ho zrekonstruovat/napsat
   (zjistit verzi CGAL/Emscripten, nastavit include paths).
2. Ověřit, že `emcc`, CGAL, Boost, GMP, MPFR lze na tomhle stroji
   nainstalovat/mít dostupné (na rozdíl od cloud sandboxu v chatu, kde to
   šlo ověřit, že to nejde – `403 host_not_allowed` na github.com).
3. Až build funguje, napsat `arthetic_boolean_union(positionsA, countA,
   facesA, faceCountA, positionsB, countB, facesB, faceCountB) -> result`
   a otestovat na jednoduchém páru krychle+koule než na reálném scanu.

## Soubor k referenci
Aktuální `app/ClientPage.jsx` (s dnešními V38/V39 úpravami) je přiložený
jako `ClientPage.jsx` – měl by už být nahraný v repu, pokud ho uživatel
uložil zpátky.
