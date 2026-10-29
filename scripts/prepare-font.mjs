import fs from 'node:fs'
import opentype from 'opentype.js'
const base='node_modules/@fontsource/inter/'
for(const weight of [200,300,400,500,600,700,800]){
const fonts=['latin','latin-ext'].map(sub=>{const b=fs.readFileSync(base+`files/inter-${sub}-${weight}-normal.woff`);return opentype.parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength))})
const glyphs={};const r=n=>Math.round(n*1000)/1000
for(let code=32;code<384;code++){
 const char=String.fromCharCode(code);const font=fonts.find(f=>f.charToGlyphIndex(char)!==0);if(!font)continue
 const glyph=font.charToGlyph(char),out=[]
 for(const c of glyph.getPath(0,0,1000).commands){
 if(c.type==='M'||c.type==='L')out.push(c.type.toLowerCase(),r(c.x),r(-c.y))
 else if(c.type==='Q')out.push('q',r(c.x),r(-c.y),r(c.x1),r(-c.y1))
 else if(c.type==='C')out.push('b',r(c.x),r(-c.y),r(c.x1),r(-c.y1),r(c.x2),r(-c.y2))
 }
 glyphs[char]={ha:r(glyph.advanceWidth*1000/font.unitsPerEm),x_min:0,x_max:1000,o:out.join(' ')}
}
fs.writeFileSync(`public/wasm/model-builder/inter${weight===400?'':`-${weight}`}-font.json`,JSON.stringify({glyphs,familyName:'Inter',cssFontWeight:weight,ascender:1069,descender:-293,underlinePosition:-100,underlineThickness:50,boundingBox:{yMin:-293,yMax:1069,xMin:-100,xMax:1200},resolution:1000,original_font_information:{license:'SIL Open Font License 1.1'}}))
fs.copyFileSync(base+'LICENSE','public/wasm/model-builder/INTER-FONT-LICENSE.txt')
console.log('Generated Inter',weight,Object.keys(glyphs).length,'glyphs, Czech:',[...'Příliš žluťoučký kůň'].every(c=>glyphs[c]))
}

const regular=JSON.parse(fs.readFileSync('public/wasm/model-builder/inter-font.json')),bold=JSON.parse(fs.readFileSync('public/wasm/model-builder/inter-800-font.json'))
const brand={...regular,familyName:'ARTHETIC',glyphs:{...Object.fromEntries([...'HETIC '].map(char=>[char,regular.glyphs[char]])),...Object.fromEntries([...'ART'].map((char,i)=>[String.fromCharCode(0xe000+i),bold.glyphs[char]]))}}
fs.writeFileSync('public/wasm/model-builder/arthetic-logo-font.json',JSON.stringify(brand))
