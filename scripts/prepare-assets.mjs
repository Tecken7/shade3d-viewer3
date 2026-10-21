import fs from 'node:fs'
const target='public/wasm/model-builder/'
fs.mkdirSync(target,{recursive:true})
for(const file of ['manifold.js','manifold.wasm','LICENSE']) fs.copyFileSync('node_modules/manifold-3d/'+file,target+file)
console.log('Local Manifold assets are ready.')
