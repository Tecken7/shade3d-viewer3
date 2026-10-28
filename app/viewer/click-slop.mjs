// Keep normal clicks (including hand jitter) from reaching orbit's move handler.
// Larger drags and modifier gestures retain their existing camera behavior.
export function installClickSlop(element,{slop=4,enabled=()=>true}={}){
 let gesture=null
 const down=event=>{gesture=enabled()&&event.button===0&&event.pointerType!=='touch'&&!event.ctrlKey&&!event.altKey&&!event.shiftKey?{id:event.pointerId,x:event.clientX,y:event.clientY}:null}
 const move=event=>{if(!gesture||event.pointerId!==gesture.id)return;if(Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>slop){gesture=null;return}event.stopImmediatePropagation()}
 const end=()=>{gesture=null}
 element.addEventListener('pointerdown',down,true);element.addEventListener('pointermove',move,true);element.addEventListener('pointerup',end,true);element.addEventListener('pointercancel',end,true)
 return()=>{element.removeEventListener('pointerdown',down,true);element.removeEventListener('pointermove',move,true);element.removeEventListener('pointerup',end,true);element.removeEventListener('pointercancel',end,true)}
}
