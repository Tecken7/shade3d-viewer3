export function baseDirection(vertices, boundary, arch, flip = false) {
  const median=values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)]}
  const ys=[];for(let i=1;i<vertices.length;i+=3)ys.push(vertices[i])
  let min=Infinity,max=-Infinity;for(const y of ys){min=Math.min(min,y);max=Math.max(max,y)}
  const difference=median(boundary.map(id=>vertices[id*3+1]))-median(ys)
  const inferred=Math.abs(difference)>Math.max(.5,(max-min)*.1)?Math.sign(difference):(arch==='lower'?-1:1)
  return flip?-inferred:inferred
}
