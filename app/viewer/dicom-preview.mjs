// A stable central axial image is more useful than a changing random slice.
export function dicomPreviewPixels(volume) {
  if (!volume?.data || !volume.width || !volume.height || !volume.depth) return null
  const width=Math.min(192,volume.width),height=Math.max(1,Math.round(width*volume.height/volume.width))
  const pixels=new Uint8ClampedArray(width*height*4),z=Math.floor(volume.depth*.5)
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const sx=Math.min(volume.width-1,Math.floor((x+.5)*volume.width/width))
    const sy=Math.min(volume.height-1,Math.floor((y+.5)*volume.height/height))
    const hu=-1024+volume.data[(z*volume.height+sy)*volume.width+sx]/255*4095
    const value=Math.round(Math.pow(Math.max(0,Math.min(1,(hu+200)/1600)),.75)*255),i=(y*width+x)*4
    pixels[i]=pixels[i+1]=pixels[i+2]=value;pixels[i+3]=255
  }
  return {width,height,pixels}
}
export function makeDicomPreview(volume) {
  const image=dicomPreviewPixels(volume)
  if(!image || typeof document==='undefined')return null
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height
  const context=canvas.getContext('2d');if(!context)return null
  context.putImageData(new ImageData(image.pixels,image.width,image.height),0,0)
  return canvas.toDataURL('image/jpeg',.82)
}
