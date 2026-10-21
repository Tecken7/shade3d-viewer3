# Shade3D Viewer + ARTHETIC Model Builder

První nový Model Builder pro horní model bez vyjímatelných pahýlů. Výpočet probíhá lokálně v prohlížeči; nové funkce neposílají skeny na výpočetní server.

## Spuštění

Vyžaduje Node.js 18.17 nebo novější a npm.

```
npm ci
npm run dev
```

Otevřete http://localhost:3000/model-builder. Původní prohlížeč zůstává na `/`. Původní vstup `/?mode=cad&cadTool=model` také zůstává zachovaný.

Produkční sestavení: `npm run build`, potom `npm start`.

## Postup

1. Nahrajte horní STL, PLY nebo OBJ.
2. V kroku „Úprava“ lze doplnit zářezy spojené s otevřeným okrajem. Klikněte na dva konce zářezu u modré hrany, posuvníkem nastavte prohnutí nové hrany a zkontrolujte zelený náhled. „Doplnit plochu“ přidá skutečnou geometrii s návazností a orientací podle původních hran; „Vrátit doplnění“ vrací poslední zásah. Původní scan se neposouvá a hlavní otevřená hranice zůstává otevřená. Nevhodný nebo křížící se výběr se odmítne; zvolte menší úsek nebo upravte prohnutí. Krok lze přeskočit. Pak ořízněte scan stávajícím nástrojem, nebo použijte „Nechat vše“ u připraveného skenu.
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
