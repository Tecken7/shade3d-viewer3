# Shade3D Viewer + ARTHETIC Model Builder

První nový Model Builder pro horní model bez vyjímatelných pahýlů. Výpočet probíhá lokálně v prohlížeči; nové funkce neposílají skeny na výpočetní server.

## Spuštění

Vyžaduje Node.js 18.17 nebo novější a npm.

```
npm ci
npm run dev
```

Otevřete http://localhost:3000/model-builder. Původní prohlížeč zůstává na `/`. Původní vstup `/?mode=cad&cadTool=model` také zůstává zachovaný.

V hlavním prohlížeči tlačítko **Model Builder** přepne pracovní prostředí přímo ve stejné scéně. V dolním panelu vyberte horní a/nebo dolní čelist z již nahraných STL, PLY nebo OBJ. Při návratu do prohlížeče se obnoví původní geometrie a transformace; tiskový výsledek před návratem exportujte jako STL. Přímá stránka `/model-builder` nadále umožňuje samostatné nahrání souborů.

### Štětcové úpravy scanu

- **Označit doplnění:** tahem po povrchu přetřete zdravé okolí zářezu i oba jeho konce. Žlutě se označí dotčený úsek otevřeného okraje. Zelený náhled a prohnutí nové hrany lze upravit před potvrzením. Pro jiný zářez zrušte výběr a namalujte novou oblast.
- **Vyhladit celý okraj:** tři průchody s fyzickým dosahem 1,2 mm srovnají obrys bez závislosti na hustotě sítě. Posun se plynule rozloží do pásu 0,8 mm. Vyrovnat okraj zůstává lokálním štětcem.
- **Přidávat / Odebírat / Smooth:** lokální sculpting s nastavením poloměru v mm a síly. Shift vyhlazuje, Ctrl obrací přidávání/odebírání; Alt + levé tažení otáčí modelem. Přepínač Otáčet umožňuje běžnou navigaci.
- **Plynulý sculpting:** přidávání, odebírání a smoothing používají stávající síť. Dynotopo je z rozhraní odstraněné kvůli prodlevám na hustých scanech; pracovní vlákno změny topologie při sculptingu nespouští.
- **Označit artefakt / Odstranit artefakt:** přetřete výstupek a malé okolí. Fialová plocha ukáže výběr; Ctrl ubírá. Potvrzení vyrovná označenou oblast podle neoznačeného okolí včetně otevřeného okraje. Výslednou úpravu lze vrátit.
- **Vrátit úpravu:** vrátí doplnění, vyhlazení obrysu, odstranění artefaktu i celý tah sculptingu.

Pro vložený editor se posílá zpráva `ARTHETIC_MODEL_BUILDER_MODE` s `payload.active`, obdobně jako u Zarovnání. Připravené Framer komponenty LabCaseForm a LabCaseDetail přidávají tento stav do `viewerWorkspaceActive`; databáze ani ukládání původních příloh se nemění.

Produkční sestavení: `npm run build`, potom `npm start`.

## Postup

1. Nahrajte horní STL, PLY nebo OBJ.
2. V kroku „Úprava“ lze doplnit zářezy spojené s otevřeným okrajem. Štětcem označte zdravé okolí a oba konce zářezu, posuvníkem nastavte prohnutí nové hrany a zkontrolujte zelený náhled. „Doplnit plochu“ přidá skutečnou geometrii s návazností a orientací podle původních hran; „Vrátit doplnění“ vrací poslední zásah. Původní scan se neposouvá a hlavní otevřená hranice zůstává otevřená. Nevhodný nebo křížící se výběr se odmítne; zvolte menší úsek nebo upravte prohnutí. Krok lze přeskočit. Pak ořízněte scan stávajícím nástrojem, nebo použijte „Nechat vše“ u připraveného skenu.
3. Před hledáním děr se automaticky zkontrolují a bezpečně sloučí vrcholy do vzdálenosti 0,005 mm. Používá se skutečná prostorová vzdálenost, kontrola zachování topologie a odstranění zkolabovaných či duplicitních trojúhelníků. Barvy, UV a materiály zůstávají zachované; původní soubor na disku se nemění. Sloučení lze vrátit stejně jako opravu. Potom opravte díry. Hlavní otevřená hranice pro bázi se zachovává.
4. Určete tři body okluzní roviny a potvrďte orientaci.
5. Vytvořte náhled báze. Domluvené výchozí hodnoty: celková výška 25 mm, dutý model otevřený zespodu, stěna 2,5 mm, spodní bevel 1 mm / 45°, vyhlazení okraje 0,8 mm, zaoblení napojení scanu v pásu 1 mm, dva rovnoběžné odtokové zářezy Ø 4,5 mm s počáteční hloubkou řezu 8 mm s automatickým prodloužením pro celý průřez a středem 1,5 mm nad spodkem (proříznou i spodní bevel). Báze nemá rozšíření ani infill.
6. Zadejte popisek, umístěte ho na stěnu a přepočítejte. Výchozí vystoupení je 0,5 mm; lze měnit hodnotu, velikost, otočení a přepnout na vyrytí. Text podporuje českou diakritiku a promítá se na zakřivení stěny.
7. Vyberte jednotlivý otvor a upravte jeho průměr nebo hloubku. „Umístit otvor na stěnu“ nastavuje polohu kliknutím na povrch; oba otvory si zachovávají společný směr; barevné osy umožňují posun v prostoru. Po změně proveďte přepočet. Automatické otevření kontroluje průřez otvoru a celou koncovou plochu řezu; podle potřeby prodlouží řez. Ruční změna hloubky automatiku vypne. Pokud část průřezu zůstává blokovaná, zobrazí se upozornění.
Odtokové zářezy se ve výpočtu odečítají jako poslední, až po bevelu a popisku. Společný směr lze natočit; výšku středu, průměr a délku řezu lze měnit jednotlivě.

8. Dokončete model a stáhněte binární STL. Ke změně parametrů se lze vrátit.

Při příliš vysokém skenu se minimální přípustná celková výška zvýší; anatomie se nepřepočítává měřítkem. Pro přesnou výšku 25 mm může být nutný větší ořez nebo doladění orientace.

## Nový výpočet

- `app/model-builder/edge-edit.mjs` a `EdgeEditOverlay.jsx`: lokální doplnění části otevřeného okraje, náhled, nastavení nové hrany a kontrola návaznosti bez uzavření celého spodku scanu.
- `app/model-builder/repair-orientation.mjs`: orientace opravené plochy podle společných hran původního scanu, včetně kontroly celé hranice a konzistence uvnitř záplaty. Zobrazovací normály se následně počítají z ověřeného windingu; průměrná normála okolí je nesmí hromadně obrátit.
- `app/model-builder/mesh-preflight.mjs`: příprava vrcholů před analýzou a CGAL opravou. Oddělené meshe se navzájem nesvařují a operace, která by přidala otevřené či neplatné hrany, se neaplikuje.
- `app/model-builder/engine.mjs`: samostatný geometrický modul. Zachovává scan mimo úzký pás ořezu, vyhlazuje hranici, vytváří krátký přechod a rovné stěny, spodní bevel tvořený úzkými vnořenými pásy obrysu, otevřenou dutinu, otvory a text.
- `app/workers/model-builder.worker.js`: oddělené pracovní vlákno prohlížeče. Výpočet lze zrušit.
- `app/model-builder/drains.mjs`: kontrola celé plochy odtokového otvoru pomocí vzorkovaných paprsků; geometrický modul navíc testuje průnik celé koncové plochy řezu se stěnou.
- `app/model-builder/transition.mjs`: pravidelné vzorkování obrysu a lokální zaoblení skutečné geometrie napojení. Šířka pásu 0–3 mm; nejde o přesný kruhový poloměr. Anatomie mimo pás a celková výška se zachovávají.
- `app/model-builder/BuilderControls.jsx`: nastavení a prostorové ovladače.
- `app/model-builder/BuilderPreview.jsx`: rychlý výběr povrchu a automatické vyhlazení stínování podle úhlu 30° (ostré přechody se zachovávají).
- `public/wasm/model-builder/`: lokální Manifold WASM 3.5.4, písmo Noto Sans a licence.

Starý generátor plné báze zůstává v ClientPage jako neaktivní historický kód. Nový náhled jej nevolá. Původní ořez, opravy sítě a orientace jsou znovu využité. Historický HANDOFF není specifikací nového generátoru.

Dutina se počítá metodou vzdálenostního pole s přibližnou délkou hrany 0,65 mm a interpolací vzdálenostního pole; výstup proto nemusí triangulací ani přesným tvarem dutiny odpovídat Meditu. Uzavřené vnitřní kapsy se vyplňují, aby nezůstávaly dutiny bez odtoku. Před exportem se kontrolují otevřené hrany, oddělené části a také topologie souřadnic, které se skutečně zapisují do STL. Shodné kontaktní vrcholy odlišných vnitřních ploch se podle potřeby oddělují o 0,002 mm, aby ve formátu STL nevznikaly sdílené neplatné hrany. Jde o první verzi k porovnání s referenčními modely; fyzický tisk ani rozměrová shoda s Meditem nebyly ověřené.

## Ověření a údržba

`npm test` ověřuje celkovou výšku, stěnu, otevřený spodek, topologii, nezávislé otvory, vystouplý i vyrytý český text, chybná nastavení, vyhlazení okraje a skutečné zaoblení napojení při zachování okolní anatomie.

`npm run prepare:model-builder` obnoví lokální WASM a písmo z uzamčených závislostí. Pro běžné spuštění není potřeba, připravené soubory jsou v projektu.

Nová implementace je ověřovaná na horním testovacím skenu. Artikulátory, pahýly, automatické rozpoznání zubů a dolní čelist nejsou součástí ověřeného rozsahu první verze.

## Ovládání úprav scanu

- Kamera se při zvoleném štětci otáčí tažením mimo scan nebo Alt + tažením přes scan; zamkne se pouze během tahu.
- Odznačovat lze samostatnou gumou nebo podržením Ctrl při označování.
- Náhled doplnění po dokončení tahu hledá blízké zdravé okraje ústí zářezu; u zahnutého okraje může automaticky vysunout novou hranu. Před potvrzením je plocha zeleně viditelná.
- Vyhladit celý okraj provede tři plné průchody hlavního okraje každého meshe. Vnitřní otvory a vzdálená anatomie zůstávají zachované. Úpravu lze vrátit.

Vyhlazení po doplnění uchovává původní normály mimo upravené okolí. V okolí změny se normály sčítají přes geometricky společné vrcholy i na neindexované síti, aby nevznikalo ploškové stínování celého scanu. Odstranění artefaktu používá lokální harmonické vyrovnání podle pevného okolí; nevytváří novou anatomii ani nedetekuje artefakty automaticky.

## Kvalita doplnění a ořezu

Doplnění používá místní délku hran (0,06–0,30 mm), společné půlení hran, překlápění diagonál, slučování krátkých vnitřních hran a relaxaci. Sdílený okraj zůstává přesný. Vnitřní plocha se vyrovnává podle výšek a normál okolí. Pokud původní zahnutý lem překáží, nahrazuje se úzký pás místo přidání druhé vrstvy. Potvrzení odstraní nahrazované původní trojúhelníky a podporuje vrácení zpět.

Před potvrzením se kontrolují průniky, koplanární překrytí a blízké souběžné vrstvy. Kontakty na společném švu mají toleranci 0,001 mm. Nejde o kompletní detekci všech možných samoprůniků celého vstupního scanu. Výpočet náhledu běží v pracovním vlákně; z čekajících požadavků se zpracuje jen poslední označení.

Ořez zachovává identitu trojúhelníků při vytváření BVH a rozděluje i více samostatných průchodů jednou face. Nejednoznačná nebo vadná křivka se odmítne, místo exportu roztržené plochy. Testy ověřují plochu skutečné ořezové cesty a odstranění původních faces při náhradě lemu.
