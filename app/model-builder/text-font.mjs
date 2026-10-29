export const TEXT_WEIGHTS=[{value:200,label:'Extra Light'},{value:300,label:'Light'},{value:400,label:'Regular'},{value:500,label:'Medium'},{value:600,label:'Semi Bold'},{value:700,label:'Bold'},{value:800,label:'Extra Bold'}]
export const textWeight=value=>TEXT_WEIGHTS.some(w=>w.value===Number(value))?Number(value):400
export const textFontUrl=value=>`/wasm/model-builder/inter${textWeight(value)===400?'':`-${textWeight(value)}`}-font.json`
