import dynamic from 'next/dynamic'
const ModelsTool=dynamic(()=>import('./ModelsTool'),{ssr:false})
export const metadata={title:'ARTHETIC Models',robots:{index:false,follow:false}}
export default function ModelsPage(){return <ModelsTool/>}
