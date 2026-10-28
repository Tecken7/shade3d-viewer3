export function baseHeightGuideLayout(data,height,flip=false) {
  const direction=data.direction*(flip?-1:1)
  const y=direction>0?data.min[1]+height:data.max[1]-height
  const center=[(data.min[0]+data.max[0])/2,(data.min[2]+data.max[2])/2]
  const anchor=data.points.reduce((best,p)=>{
    const d=(p[0]-center[0])**2+(p[2]-center[1])**2
    return !best||d<best.d?{p,d}:best
  },null).p
  return {direction,y,anchor:[anchor[0],y,anchor[2]]}
}

export function draggedBaseHeight(startHeight,startY,currentY,direction,min,max) {
  return Math.round(Math.max(min,Math.min(max,startHeight+direction*(currentY-startY)))*100)/100
}
