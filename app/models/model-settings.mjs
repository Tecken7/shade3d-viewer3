// Only these three per-model values may replace the batch settings.
export function resolveModelSettings(global,own){
 if(!own?.enabled)return {...global}
 const extendBase=own.extendBase===true,replaceHeight=Number(own.replaceHeight),bevelHeight=Number(own.bevelHeight)
 if(!Number.isFinite(replaceHeight)||replaceHeight<1||replaceHeight>6||!Number.isFinite(bevelHeight)||bevelHeight<.2||bevelHeight>4||extendBase&&bevelHeight>replaceHeight-.1+1e-8)throw Error('Zkontrolujte vlastní prodloužení báze a výšku bevelu.')
 return {...global,convertBase:global.convertBase||extendBase,extendBase,replaceHeight,bevelHeight}
}
